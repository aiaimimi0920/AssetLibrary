import { expect, test } from './browser-contract';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe.configure({ retries: 0 });
const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;
const publisherId = '11111111-1111-4111-8111-111111111111';
const packageId = '22222222-2222-4222-8222-222222222222';
const newReleaseId = '99999999-9999-4999-8999-999999999992';
type Resource = 'package' | 'release';
type CreationState = { create_requests: number; attempts: {
  path: string; idempotency_key: string; body: Record<string, unknown> }[];
  packages: Record<string, unknown>[]; releases: Record<string, unknown>[]; pending: boolean };
const path = (resource: Resource) => `${resource === 'package' ? '/publisher/packages/new'
  : `/publisher/packages/${packageId}/releases/new`}?publisher=${publisherId}`;
const submitName = (resource: Resource) => resource === 'package' ? '创建包草稿' : '创建版本草稿';
const formOn = (page: Page) => page.locator('main form.publisher-form');
async function state(request: APIRequestContext): Promise<CreationState> {
  const response = await request.get(`${fixture}/fixture/draft-creation-state`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function configure(request: APIRequestContext, data: { conflict?: boolean; hold?: boolean }) {
  expect((await request.post(`${fixture}/fixture/draft-creation-control`, { data })).ok()).toBe(true);
}
function fields(form: Locator, resource: Resource): Record<string, Locator> {
  return resource === 'package' ? {
    description: form.getByRole('textbox', { name: '说明', exact: true }),
    name: form.getByRole('textbox', { name: 'Package 名称', exact: true }),
    slug: form.getByRole('textbox', { name: '全局 Slug', exact: true }),
    summary: form.getByRole('textbox', { name: '摘要', exact: true }),
    tags: form.getByRole('textbox', { name: /^标签/ }),
  } : {
    version: form.getByRole('textbox', { name: '语义版本', exact: true }),
    permissions: form.getByRole('textbox', { name: /^权限声明/ }),
    loom: form.getByRole('textbox', { name: 'Loom 版本范围', exact: true }),
    hook: form.getByRole('textbox', { name: 'Hook 版本范围', exact: true }),
  };
}
function values(resource: Resource, invalid = false): Record<string, string> {
  return resource === 'package' ? { description: 'Unsubmitted description\nSecond line.',
    name: 'Unsubmitted package', slug: 'unsubmitted-package', summary: 'Unsubmitted summary',
    tags: invalid ? 'INVALID TAG' : 'draft, retry' }
    : { version: invalid ? 'not-semver' : '1.2.3', permissions: 'filesystem.read-project, network.fetch',
      loom: '>=0.2.0', hook: '>=0.3.0' };
}
async function fill(form: Locator, resource: Resource, invalid = false) {
  const controls = fields(form, resource);
  for (const [key, value] of Object.entries(values(resource, invalid))) await controls[key].fill(value);
  if (resource === 'package') {
    await form.getByRole('combobox', { name: '类型', exact: true }).selectOption('capability');
    await form.getByRole('combobox', { name: '可见性', exact: true }).selectOption('public');
  }
}
async function retained(form: Locator, resource: Resource, invalid = false) {
  const controls = fields(form, resource);
  for (const [key, value] of Object.entries(values(resource, invalid))) await expect(controls[key]).toHaveValue(value);
  if (resource === 'package') {
    await expect(form.getByRole('combobox', { name: '类型', exact: true })).toHaveValue('capability');
    await expect(form.getByRole('combobox', { name: '可见性', exact: true })).toHaveValue('public');
  }
}
async function blank(form: Locator, resource: Resource) {
  for (const control of Object.values(fields(form, resource))) await expect(control).toHaveValue('');
  if (resource === 'package') {
    await expect(form.getByRole('combobox', { name: '类型', exact: true })).toHaveValue('art');
    await expect(form.getByRole('combobox', { name: '可见性', exact: true })).toHaveValue('private');
  }
}

test.beforeEach(async ({ request, context }) => {
  expect((await request.post(`${fixture}/fixture/reset-draft-creation-state`)).ok()).toBe(true);
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
});
test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/reset-draft-creation-state`)).ok()).toBe(true);
});

for (const resource of ['package', 'release'] as const) {
  for (const failure of ['validation', 'expired-session', 'conflict'] as const) {
    test(`new ${resource} retains its unsubmitted draft after ${failure}`, async ({ page, request, context }) => {
      await page.goto(path(resource));
      const form = formOn(page);
      await expect(form).toBeVisible();
      const idempotency = await form.locator('[name="idempotency_key"]').inputValue();
      await fill(form, resource, failure === 'validation');
      if (failure === 'expired-session') {
        await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
      }
      if (failure === 'conflict') await configure(request, { conflict: true });
      for (let attempt = 1; attempt <= 2; attempt++) {
        await form.getByRole('button', { name: submitName(resource), exact: true }).click();
        await expect(form.getByRole('alert')).toContainText(failure === 'expired-session' ? '外部账号会话不可用'
          : failure === 'conflict' ? '冲突' : resource === 'package' ? '请检查必填项' : '请检查目标');
        await expect(form.getByRole('alert')).toBeFocused();
        await expect(form.locator('[name="idempotency_key"]')).toHaveValue(idempotency);
        await expect(form.locator('[name="publisher_id"]')).toHaveValue(publisherId);
        if (resource === 'release') await expect(form.locator('[name="package_id"]')).toHaveValue(packageId);
        if (failure === 'conflict') await expect.poll(async () => (await state(request)).create_requests).toBe(attempt);
        const observed = await state(request);
        expect(observed).toMatchObject({ create_requests: failure === 'conflict' ? attempt : 0, packages: [], releases: [] });
        for (const sent of observed.attempts) expect(sent).toMatchObject({ idempotency_key: idempotency,
          path: resource === 'package' ? `/v1/me/publishers/${publisherId}/packages` : `/v1/me/packages/${packageId}/releases` });
        await retained(form, resource, failure === 'validation');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
      if (failure === 'validation') {
        await fields(form, resource)[resource === 'package' ? 'tags' : 'version'].fill(resource === 'package' ? 'draft, retry' : '1.2.3');
        await configure(request, { hold: true });
        const button = form.getByRole('button');
        await button.click();
        await expect.poll(async () => (await state(request)).pending).toBe(true);
        await expect(button).toBeDisabled();
        // A native second click on the disabled submitter must not enqueue a new action.
        await button.evaluate((element: HTMLButtonElement) => element.click());
        expect((await state(request)).create_requests).toBe(1);
        await configure(request, {});
        if (resource === 'package') {
          await expect(page).toHaveURL(new RegExp(`/publisher\\?publisher=${publisherId}$`));
          await expect(page.getByRole('heading', { level: 3, name: 'Unsubmitted package', exact: true })).toBeVisible();
          await page.locator('article.owned-package-row').filter({ hasText: 'Unsubmitted package' })
            .getByRole('link', { name: '管理发布', exact: true }).click();
          await expect(page.getByRole('heading', { level: 1, name: 'Unsubmitted package', exact: true })).toBeVisible();
          await expect(page.getByRole('heading', { name: '尚无 Release', exact: true })).toBeVisible();
        } else {
          await expect(page).toHaveURL(new RegExp(`/publisher/packages/${packageId}/releases/${newReleaseId}$`));
          await expect(page.getByRole('heading', { level: 1 })).toContainText('v1.2.3');
          await page.getByRole('link', { name: '返回 Package', exact: true }).click();
          await expect(page.locator('.release-workspace-row').filter({ hasText: '1.2.3' })).toHaveCount(1);
        }
        const saved = await state(request);
        expect(saved.create_requests).toBe(1);
        expect(saved.attempts[0].idempotency_key).toBe(idempotency);
        expect(saved[resource === 'package' ? 'packages' : 'releases']).toHaveLength(1);
        expect(saved[resource === 'package' ? 'releases' : 'packages']).toEqual([]);
        expect(saved.attempts[0].body).toEqual(resource === 'package' ? {
          slug: 'unsubmitted-package', kind: 'capability', visibility: 'public', name: 'Unsubmitted package',
          summary: 'Unsubmitted summary', description: 'Unsubmitted description\r\nSecond line.', tags: ['draft', 'retry'],
        } : { version: '1.2.3', permissions: ['filesystem.read-project', 'network.fetch'],
          compatibility: { products: [{ name: 'loom', version_requirement: '>=0.2.0' }, { name: 'hook', version_requirement: '>=0.3.0' }] } });
        await page.goto(path(resource));
        await blank(form, resource);
        await expect(form.getByRole('alert')).toHaveCount(0);
        await expect(form.locator('[name="idempotency_key"]')).not.toHaveValue(idempotency);
      }
    });
  }

  test(`leaving new ${resource} discards private input across navigation and account gates`, async ({ page, request, context }) => {
    await page.goto(path(resource));
    const form = formOn(page);
    const idempotency = await form.locator('[name="idempotency_key"]').inputValue();
    await fill(form, resource);
    await page.getByRole('link', { name: '返回工作区', exact: true }).click();
    await expect(page).toHaveURL(/\/publisher\?publisher=/);
    await page.goBack();
    await blank(form, resource);
    await expect(form.getByRole('alert')).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(/\/publisher\?publisher=/);
    await page.goBack();
    await blank(form, resource);
    await fill(form, resource);
    await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
    // A new document establishes the account boundary; this is not live-session revocation.
    await page.goto(path(resource));
    await expect(page.getByRole('heading', { level: 1, name: '账号会话响应无效', exact: true })).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])))
      .not.toContain(resource === 'package' ? 'Unsubmitted' : 'filesystem.read-project');
    await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
    await page.goto(path(resource).replace(publisherId, '44444444-4444-4444-8444-444444444444'));
    await expect(form).toHaveCount(0);
    await page.goto(path(resource));
    await blank(form, resource);
    await expect(form.locator('[name="idempotency_key"]')).not.toHaveValue(idempotency);
    expect(await state(request)).toMatchObject({ create_requests: 0, packages: [], releases: [] });
  });
}
