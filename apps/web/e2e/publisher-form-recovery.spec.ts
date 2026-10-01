import { expect, test } from './browser-contract';
import type { APIRequestContext } from '@playwright/test';

test.describe.configure({ retries: 0 });

const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;
const packageId = '22222222-2222-4222-8222-222222222222';
const endpoint = `${fixture}/v1/me/packages/${packageId}`;
// This token belongs only to fixture-server.mjs, never to an external account.
const headers = { authorization: 'Bearer browser-fixture-access-token-that-stays-server-only' };
type PackageFixture = { name: string; summary: string; description: string; tags: string[];
  visibility: string; updated_at: string };
let original: PackageFixture;

async function current(request: APIRequestContext): Promise<PackageFixture> {
  const response = await request.get(endpoint, { headers });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function writeFixture(request: APIRequestContext, value: PackageFixture) {
  const now = await current(request);
  const response = await request.patch(endpoint, { headers, data: {
    expected_updated_at: now.updated_at, visibility: value.visibility, name: value.name,
    summary: value.summary, description: value.description, tags: value.tags,
  } });
  expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ request, context }) => {
  original = await current(request);
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
});
test.afterEach(async ({ request }) => { await writeFixture(request, original); });

for (const failure of ['validation', 'expired-session', 'conflict'] as const) {
  test(`Publisher package editor preserves unsaved input after ${failure}`, async ({ page, context, request }) => {
    await page.goto(`/publisher/packages/${packageId}`);
    const form = page.locator('#package-metadata form');
    const name = form.getByRole('textbox', { name: 'Package 名称', exact: true });
    await expect(name).toBeVisible();
    const idempotency = await form.locator('[name="idempotency_key"]').inputValue();
    const revision = await form.locator('[name="expected_updated_at"]').inputValue();
    await name.fill('Unsaved editor name');
    await form.getByRole('textbox', { name: '摘要', exact: true }).fill('Unsaved summary');
    await form.getByRole('textbox', { name: '说明', exact: true }).fill('Unsaved detailed description\nSecond line must survive.');
    await form.getByRole('combobox', { name: '可见性', exact: true }).selectOption('private');
    await form.getByRole('textbox', { name: /^标签/ }).fill(failure === 'validation' ? 'INVALID TAG' : 'art, retry');
    if (failure === 'expired-session') {
      await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
    }
    if (failure === 'conflict') await writeFixture(request, { ...original, name: 'Concurrent editor saved this' });
    await page.getByRole('button', { name: '保存 Package 草稿', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText(failure === 'validation' ? '请检查 Package'
      : failure === 'expired-session' ? '外部账号会话不可用' : '冲突');
    await expect(form.locator('[name="idempotency_key"]')).toHaveValue(idempotency);
    await expect(form.locator('[name="expected_updated_at"]')).toHaveValue(revision);
    expect((await current(request)).name).toBe(failure === 'conflict' ? 'Concurrent editor saved this' : original.name);
    await expect(form.getByRole('textbox', { name: '说明', exact: true })).toHaveValue('Unsaved detailed description\nSecond line must survive.');
    await expect(name).toHaveValue('Unsaved editor name');
    await expect(form.getByRole('textbox', { name: '摘要', exact: true })).toHaveValue('Unsaved summary');
    await expect(form.getByRole('combobox', { name: '可见性', exact: true })).toHaveValue('private');
    await expect(form.getByRole('textbox', { name: /^标签/ })).toHaveValue(failure === 'validation' ? 'INVALID TAG' : 'art, retry');
  });
}
