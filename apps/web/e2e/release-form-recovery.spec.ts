import { expect, test } from './browser-contract';
import type { APIRequestContext } from '@playwright/test';
import type { OwnedRelease } from '../src/lib/publisher-contracts';

test.describe.configure({ retries: 0 });
const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;
const packageId = '22222222-2222-4222-8222-222222222222';
const releaseId = '33333333-3333-4333-8333-333333333333';
type EditState = { release: OwnedRelease; patch_requests: number; writes: number;
  attempts: { path: string; idempotency_key: string; body: { expected_updated_at: string } }[] };
async function state(request: APIRequestContext): Promise<EditState> {
  const response = await request.get(`${fixture}/fixture/release-edit-state`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ request, context }) => {
  expect((await request.post(`${fixture}/fixture/reset-release-edit`)).ok()).toBe(true);
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
});
test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/reset-release-edit`)).ok()).toBe(true);
});

for (const failure of ['validation', 'expired-session', 'conflict'] as const) {
  test(`Release editor retains unsaved metadata after ${failure}`, async ({ page, context, request }) => {
    await page.goto(`/publisher/packages/${packageId}/releases/${releaseId}`);
    const form = page.locator('main form.publisher-form');
    await expect(form).toBeVisible();
    const idempotency = await form.locator('[name="idempotency_key"]').inputValue();
    const revision = await form.locator('[name="expected_updated_at"]').inputValue();
    const version = await form.locator('.immutable-field code').innerText();
    const permissions = failure === 'validation' ? 'network.fetch, network.fetch' : 'filesystem.read-project, network.fetch';
    await form.getByRole('textbox', { name: /^权限声明/ }).fill(permissions);
    await form.getByRole('textbox', { name: 'Loom 版本范围', exact: true }).fill('>=0.2.0');
    await form.getByRole('textbox', { name: 'Hook 版本范围', exact: true }).fill('>=0.3.0');
    if (failure === 'expired-session') {
      await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
    }
    if (failure === 'conflict') expect((await request.post(`${fixture}/fixture/concurrent-release-edit`)).ok()).toBe(true);
    const authoritative = await state(request);
    await form.getByRole('button', { name: '保存 Release 草稿', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText(failure === 'validation' ? '请检查 Release'
      : failure === 'expired-session' ? '外部账号会话不可用' : '冲突');
    await expect(form.locator('[name="idempotency_key"]')).toHaveValue(idempotency);
    await expect(form.locator('[name="expected_updated_at"]')).toHaveValue(revision);
    await expect(form.locator('[name="package_id"]')).toHaveValue(packageId);
    await expect(form.locator('[name="release_id"]')).toHaveValue(releaseId);
    await expect(form.locator('.immutable-field code')).toHaveText(version);
    const observed = await state(request);
    expect(observed.release).toEqual(authoritative.release);
    expect(observed.writes).toBe(authoritative.writes);
    expect(observed.patch_requests).toBe(failure === 'conflict' ? 1 : 0);
    if (failure === 'conflict') expect(observed.attempts[0]).toMatchObject({ path: `/v1/me/releases/${releaseId}`,
      idempotency_key: idempotency, body: { expected_updated_at: revision } });
    await expect(form.getByRole('textbox', { name: /^权限声明/ })).toHaveValue(permissions);
    await expect(form.getByRole('textbox', { name: 'Loom 版本范围', exact: true })).toHaveValue('>=0.2.0');
    await expect(form.getByRole('textbox', { name: 'Hook 版本范围', exact: true })).toHaveValue('>=0.3.0');
  });
}
