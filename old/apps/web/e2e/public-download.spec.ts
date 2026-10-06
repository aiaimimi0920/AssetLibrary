import AxeBuilder from '@axe-core/playwright';
import { readFile, stat } from 'node:fs/promises';
import { expect, test } from './browser-contract';

const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;
const packagePath = '/packages/neuro-starter-art';

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/download-mode?mode=normal`)).ok()).toBe(true);
  expect((await request.post(`${fixture}/fixture/discovery-mode?mode=normal`)).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/download-mode?mode=normal`)).ok()).toBe(true);
});

test('public Art download prepares current metadata and hands file bytes directly to the download host', async ({ page, context, request }) => {
  await context.addCookies([{ name: 'neuro_session', value: 'browser-fixture-session', domain: '127.0.0.1', path: '/' }]);
  await page.goto(packagePath);
  await expect(page.getByRole('heading', { level: 1, name: 'Neuro Starter Art' })).toBeVisible();
  const prepare = page.getByRole('button', { name: '准备下载', exact: true });
  await expect(prepare).toBeVisible();
  expect((await (await request.get(`${fixture}/fixture/download-state`)).json()).resolve_count).toBe(0);
  await prepare.focus();
  await page.keyboard.press('Enter');
  const link = page.getByRole('link', { name: '下载文件', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(page.getByRole('status')).toContainText('不代表已下载、校验或安装');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const pendingDownload = page.waitForEvent('download');
  await link.click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('neuro-starter-art-1.2.0.zip');
  expect(download.url()).toMatch(/^http:\/\/localhost:\d+\/public\/sha256\/4242/);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect((await stat(downloadedPath!)).size).toBe(4096);
  expect((await readFile(downloadedPath!)).equals(Buffer.alloc(4096, 42))).toBe(true);
  const state = await (await request.get(`${fixture}/fixture/download-state`)).json();
  expect(state).toEqual({ resolve_count: 1, object_count: 1, api_credentials_received: false,
    object_credentials_received: false, referrer_received: false });
});

test('repeated preparation, cancellation and navigation cannot restore an old pending download', async ({ page, request }) => {
  await request.post(`${fixture}/fixture/download-mode?mode=delayed`);
  await page.goto(packagePath);
  const prepare = page.getByRole('button', { name: '准备下载', exact: true });
  // Two same-turn clicks exercise the synchronous guard before React commits disabled.
  await prepare.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole('button', { name: '正在确认下载…' })).toBeDisabled();
  await expect.poll(async () => (await (await request.get(`${fixture}/fixture/download-state`)).json()).resolve_count).toBe(1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(prepare).toBeFocused();
  await request.post(`${fixture}/fixture/release-download`);
  await expect(page.getByRole('link', { name: '下载文件', exact: true })).toHaveCount(0);
  await prepare.click();
  await expect.poll(async () => (await (await request.get(`${fixture}/fixture/download-state`)).json()).resolve_count).toBe(2);
  await page.getByRole('link', { name: 'AssetLibrary 首页' }).click();
  await expect(page).toHaveURL('/');
  await request.post(`${fixture}/fixture/release-download`);
  await page.goBack();
  await expect(prepare).toBeEnabled();
  await expect(page.getByRole('link', { name: '下载文件', exact: true })).toHaveCount(0);
  await request.post(`${fixture}/fixture/download-mode?mode=normal`);
  await prepare.click();
  await expect(page.getByRole('link', { name: '下载文件', exact: true })).toBeVisible();
});

test('revocation, wrong immutable identity and unsafe destinations remain recoverable errors', async ({ page, request }) => {
  await page.goto(packagePath);
  await page.getByRole('button', { name: '准备下载', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载文件', exact: true })).toBeVisible();
  for (const mode of ['revoked', 'mismatch', 'redirect', 'unavailable']) {
    await request.post(`${fixture}/fixture/download-mode?mode=${mode}`);
    await page.getByRole('button', { name: /^(重新确认下载|准备下载)$/ }).click();
    await expect(page.getByRole('status')).toContainText(mode === 'revoked' ? '已不可公开下载' : '暂时无法获取下载地址');
    await expect(page.getByRole('link', { name: '下载文件', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('must-not-escape');
  }
  await request.post(`${fixture}/fixture/download-mode?mode=normal`);
  await page.getByRole('button', { name: '准备下载', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载文件', exact: true })).toBeVisible();
});
