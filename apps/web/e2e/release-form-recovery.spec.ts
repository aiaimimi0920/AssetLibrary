import { expect, test } from './browser-contract';
import type { APIRequestContext, Locator } from '@playwright/test';
import type { OwnedRelease, UpdateReleaseRequest } from '../src/lib/publisher-contracts';
import AxeBuilder from '@axe-core/playwright';

test.describe.configure({ retries: 0 });
const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;
const packageId = '22222222-2222-4222-8222-222222222222';
const releaseId = '33333333-3333-4333-8333-333333333333';
const route = `/publisher/packages/${packageId}/releases/${releaseId}`;
const permissionsDraft = 'filesystem.read-project, network.fetch';
type EditState = { release: OwnedRelease; patch_requests: number; writes: number;
  attempts: { path: string; idempotency_key: string; body: UpdateReleaseRequest }[] };
async function state(request: APIRequestContext): Promise<EditState> {
  const response = await request.get(`${fixture}/fixture/release-edit-state`);
  expect(response.ok()).toBe(true);
  return response.json();
}
const fields = (form: Locator) => ({ permissions: form.getByRole('textbox', { name: /^权限声明/ }),
  loom: form.getByRole('textbox', { name: 'Loom 版本范围', exact: true }),
  hook: form.getByRole('textbox', { name: 'Hook 版本范围', exact: true }) });
async function fill(form: Locator, permissions = permissionsDraft) {
  const controls = fields(form);
  await controls.permissions.fill(permissions);
  await controls.loom.fill('>=0.2.0');
  await controls.hook.fill('>=0.3.0');
}
async function authoritativeFields(form: Locator, release: OwnedRelease) {
  const controls = fields(form);
  await expect(controls.permissions).toHaveValue(release.permissions.join(', '));
  for (const product of ['loom', 'hook'] as const) {
    await expect(controls[product]).toHaveValue(release.compatibility.products.find(item => item.name === product)?.version_requirement ?? '');
  }
}
function immutable(release: OwnedRelease) {
  const { compatibility: _compatibility, permissions: _permissions, updated_at: _updatedAt, ...value } = release;
  return value;
}

test.beforeEach(async ({ request, context }) => {
  expect((await request.post(`${fixture}/fixture/reset-release-edit`)).ok()).toBe(true);
  expect((await request.post(`${fixture}/fixture/reset-draft-creation-state`)).ok()).toBe(true);
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
});
test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/reset-release-edit`)).ok()).toBe(true);
  expect((await request.post(`${fixture}/fixture/reset-draft-creation-state`)).ok()).toBe(true);
});

for (const failure of ['validation', 'expired-session', 'conflict'] as const) {
  test(`Release editor retains unsaved metadata after ${failure}`, async ({ page, context, request }) => {
    await page.goto(route);
    const form = page.locator('main form.publisher-form');
    await expect(form).toBeVisible();
    const idempotency = await form.locator('[name="idempotency_key"]').inputValue();
    const revision = await form.locator('[name="expected_updated_at"]').inputValue();
    const version = await form.locator('.immutable-field code').innerText();
    const original = (await state(request)).release;
    const permissions = failure === 'validation' ? 'network.fetch, network.fetch' : permissionsDraft;
    await fill(form, permissions);
    if (failure === 'expired-session') {
      await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
    }
    if (failure === 'conflict') expect((await request.post(`${fixture}/fixture/concurrent-release-edit`)).ok()).toBe(true);
    const authoritative = await state(request);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await form.getByRole('button', { name: '保存 Release 草稿', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText(failure === 'validation' ? '请检查 Release'
        : failure === 'expired-session' ? '外部账号会话不可用' : '冲突');
      await expect(form.getByRole('alert')).toBeFocused();
      await expect(form.locator('[name="idempotency_key"]')).toHaveValue(idempotency);
      await expect(form.locator('[name="expected_updated_at"]')).toHaveValue(revision);
      await expect(form.locator('[name="package_id"]')).toHaveValue(packageId);
      await expect(form.locator('[name="release_id"]')).toHaveValue(releaseId);
      await expect(form.locator('.immutable-field code')).toHaveText(version);
      if (failure === 'conflict') await expect.poll(async () => (await state(request)).patch_requests).toBe(attempt);
      const observed = await state(request);
      expect(observed.release).toEqual(authoritative.release);
      expect(observed.writes).toBe(authoritative.writes);
      expect(observed.patch_requests).toBe(failure === 'conflict' ? attempt : 0);
      for (const sent of observed.attempts) expect(sent).toMatchObject({ path: `/v1/me/releases/${releaseId}`,
        idempotency_key: idempotency, body: { expected_updated_at: revision } });
      await expect(fields(form).permissions).toHaveValue(permissions);
      await expect(fields(form).loom).toHaveValue('>=0.2.0');
      await expect(fields(form).hook).toHaveValue('>=0.3.0');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    if (failure === 'conflict') {
      // Reload is an explicit choice to discard the draft and load the other editor's revision.
      await page.reload();
      await authoritativeFields(form, authoritative.release);
      await expect(form.locator('[name="expected_updated_at"]')).toHaveValue(authoritative.release.updated_at);
      expect(await state(request)).toMatchObject({ writes: 1, patch_requests: 2, release: authoritative.release });
    } else {
      if (failure === 'validation') await fields(form).permissions.fill(permissionsDraft);
      if (failure === 'expired-session') {
        await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
      }
      await form.getByRole('button', { name: '保存 Release 草稿', exact: true }).click();
      await expect(form.locator('[name="expected_updated_at"]')).not.toHaveValue(revision);
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      const saved = await state(request);
      expect(saved.writes).toBe(1);
      expect(saved.patch_requests).toBe(1);
      expect(immutable(saved.release)).toEqual(immutable(original));
      expect(saved.attempts[0]).toEqual({ path: `/v1/me/releases/${releaseId}`, idempotency_key: idempotency,
        body: { expected_updated_at: revision, permissions: ['filesystem.read-project', 'network.fetch'],
          compatibility: { products: [{ name: 'loom', version_requirement: '>=0.2.0' }, { name: 'hook', version_requirement: '>=0.3.0' }] } } });
      await authoritativeFields(form, saved.release);
      await expect(form.locator('[name="expected_updated_at"]')).toHaveValue(saved.release.updated_at);
    }
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expect(form.locator('[name="idempotency_key"]')).not.toHaveValue(idempotency);
    await expect(form.locator('.immutable-field code')).toHaveText(version);
  });
}

test('Release navigation and fresh account gates discard unsaved input without writing it elsewhere', async ({ page, context, request }) => {
  const original = (await state(request)).release;
  await page.goto(route);
  const form = page.locator('main form.publisher-form');
  await fill(form, 'unsubmitted.private-permission');
  await page.getByRole('link', { name: '返回 Package', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/publisher/packages/${packageId}$`));
  await page.goBack();
  await authoritativeFields(form, original);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/publisher/packages/${packageId}$`));
  await page.goBack();
  await authoritativeFields(form, original);
  await fill(form, 'unsubmitted.private-permission');
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-expired', domain: '127.0.0.1', path: '/' }]);
  // A new document verifies the existing account gate, not live session revocation.
  await page.goto(route);
  await expect(page.getByRole('heading', { level: 1, name: '账号会话响应无效', exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])))
    .not.toContain('unsubmitted.private-permission');
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
  await page.goto(route.replace(packageId, '44444444-4444-4444-8444-444444444444'));
  await expect(form).toHaveCount(0);
  await page.goto(route);
  await authoritativeFields(form, original);
  await fill(form, 'unsubmitted.private-permission');
  // Fixed synthetic credentials only; create a second fixture target to verify client navigation.
  const created = await request.post(`${fixture}/v1/me/packages/${packageId}/releases`, {
    headers: { authorization: 'Bearer browser-fixture-access-token-that-stays-server-only', 'idempotency-key': 'fixture-target-release-key' },
    data: { version: '2.0.0', permissions: ['target.read'], compatibility: { products: [{ name: 'hook', version_requirement: '>=9.0.0' }] } },
  });
  expect(created.ok()).toBe(true);
  const target = await created.json() as OwnedRelease;
  await page.getByRole('link', { name: '返回 Package', exact: true }).click();
  await page.locator('.release-workspace-row').filter({ hasText: 'v2.0.0' }).getByRole('link', { name: '管理 Release', exact: true }).click();
  await expect(form.locator('[name="release_id"]')).toHaveValue(target.id);
  await expect(form.locator('[name="package_id"]')).toHaveValue(packageId);
  await expect(form.locator('.immutable-field code')).toHaveText('2.0.0');
  await authoritativeFields(form, target);
  expect(await state(request)).toMatchObject({ release: original, patch_requests: 0, writes: 0 });
});
