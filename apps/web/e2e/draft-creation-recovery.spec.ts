import { expect, test } from './browser-contract';

test.describe.configure({ retries: 0 });
const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;
const publisherId = '11111111-1111-4111-8111-111111111111';
const packageId = '22222222-2222-4222-8222-222222222222';

test.beforeEach(async ({ request, context }) => {
  expect((await request.post(`${fixture}/fixture/reset-draft-creation-state`)).ok()).toBe(true);
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
});
test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/reset-draft-creation-state`)).ok()).toBe(true);
});

for (const resource of ['package', 'release'] as const) {
  for (const failure of ['validation', 'expired-session'] as const) {
    test(`new ${resource} retains its unsubmitted draft after ${failure}`, async ({ page, request, context }) => {
      const path = resource === 'package' ? '/publisher/packages/new'
        : `/publisher/packages/${packageId}/releases/new`;
      await page.goto(`${path}?publisher=${publisherId}`);
      const form = page.locator('main form.publisher-form');
      await expect(form).toBeVisible();
      const idempotency = await form.locator('[name="idempotency_key"]').inputValue();
      if (resource === 'package') {
        await form.getByRole('textbox', { name: 'Package 名称', exact: true }).fill('Unsubmitted package');
        await form.getByRole('textbox', { name: '全局 Slug', exact: true }).fill('unsubmitted-package');
        await form.getByRole('combobox', { name: '类型', exact: true }).selectOption('capability');
        await form.getByRole('combobox', { name: '可见性', exact: true }).selectOption('public');
        await form.getByRole('textbox', { name: '摘要', exact: true }).fill('Unsubmitted summary');
        await form.getByRole('textbox', { name: '说明', exact: true }).fill('Unsubmitted description\nSecond line.');
        await form.getByRole('textbox', { name: /^标签/ }).fill(failure === 'validation' ? 'INVALID TAG' : 'draft, retry');
      } else {
        await form.getByRole('textbox', { name: '语义版本', exact: true }).fill(failure === 'validation' ? 'not-semver' : '1.2.3');
        await form.getByRole('textbox', { name: /^权限声明/ }).fill('filesystem.read-project, network.fetch');
        await form.getByRole('textbox', { name: 'Loom 版本范围', exact: true }).fill('>=0.2.0');
        await form.getByRole('textbox', { name: 'Hook 版本范围', exact: true }).fill('>=0.3.0');
      }
      if (failure === 'expired-session') {
        await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
      }
      await form.getByRole('button', { name: resource === 'package' ? '创建包草稿' : '创建版本草稿', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText(failure === 'expired-session' ? '外部账号会话不可用'
        : resource === 'package' ? '请检查必填项' : '请检查目标');
      await expect(form.locator('[name="idempotency_key"]')).toHaveValue(idempotency);
      await expect(form.locator('[name="publisher_id"]')).toHaveValue(publisherId);
      const state = await request.get(`${fixture}/fixture/draft-creation-state`);
      expect(await state.json()).toEqual({ create_requests: 0 });
      if (resource === 'package') {
        await expect(form.getByRole('textbox', { name: '说明', exact: true })).toHaveValue('Unsubmitted description\nSecond line.');
        await expect(form.getByRole('textbox', { name: 'Package 名称', exact: true })).toHaveValue('Unsubmitted package');
        await expect(form.getByRole('textbox', { name: '全局 Slug', exact: true })).toHaveValue('unsubmitted-package');
        await expect(form.getByRole('textbox', { name: '摘要', exact: true })).toHaveValue('Unsubmitted summary');
        await expect(form.getByRole('textbox', { name: /^标签/ })).toHaveValue(failure === 'validation' ? 'INVALID TAG' : 'draft, retry');
        await expect(form.getByRole('combobox', { name: '类型', exact: true })).toHaveValue('capability');
        await expect(form.getByRole('combobox', { name: '可见性', exact: true })).toHaveValue('public');
      } else {
        await expect(form.locator('[name="package_id"]')).toHaveValue(packageId);
        await expect(form.getByRole('textbox', { name: '语义版本', exact: true })).toHaveValue(failure === 'validation' ? 'not-semver' : '1.2.3');
        await expect(form.getByRole('textbox', { name: /^权限声明/ })).toHaveValue('filesystem.read-project, network.fetch');
        await expect(form.getByRole('textbox', { name: 'Loom 版本范围', exact: true })).toHaveValue('>=0.2.0');
        await expect(form.getByRole('textbox', { name: 'Hook 版本范围', exact: true })).toHaveValue('>=0.3.0');
      }
    });
  }
}
