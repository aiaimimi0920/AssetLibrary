import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./browser-contract";

async function expectNoOverflow(page: import("@playwright/test").Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function expectVisual(page: import("@playwright/test").Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
}

async function expectAccessible(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

const fixtureUrl = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? "18900")}`;

test("public catalog is keyboard reachable, accessible, and viewport bounded", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "独立安装，逐项验证。" })).toBeVisible();
  await expect(page.getByText("Neuro Starter Art")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "跳至主要内容" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "AssetLibrary 首页" })).toBeFocused();
  await expectNoOverflow(page);
  await expectAccessible(page);
  await expectVisual(page, "public-catalog");
});

test("Publisher signing workspace exposes public trust data without identity leakage", async ({ context, page }) => {
  await context.addCookies([{
    name: "neuro_session", value: "browser-fixture-session", domain: "127.0.0.1", path: "/",
  }]);
  await page.goto("/publisher/signing-keys?publisher=11111111-1111-4111-8111-111111111111");
  await expect(page.getByRole("heading", { level: 1, name: "签名密钥" })).toBeVisible();
  await expect(page.getByText("私钥永远不会进入商店")).toBeVisible();
  await expect(page.getByText("release-2026", { exact: true })).toBeVisible();
  await expect(page.locator('[name="public_key_base64"]')).toHaveCount(1);
  await expect(page.locator('[name*="private"], [name*="secret"]')).toHaveCount(0);
  const content = await page.locator("body").innerText();
  expect(content).not.toContain("browser-fixture-access-token");
  expect(content).not.toContain("browser-private-subject");
  expect(content).not.toContain("accounts.browser.invalid");
  await expectNoOverflow(page);
  await expectAccessible(page);
  await expectVisual(page, "publisher-signing-keys");
});

test("Publisher workspace fails closed when the external Account Service cannot establish a session", async ({
  context, page, request,
}) => {
  const cases = [
    ["browser-fixture-unauthenticated", "需要外部账号会话"],
    ["browser-fixture-unavailable", "账号服务暂时不可用"],
    ["browser-fixture-malformed", "账号会话响应无效"],
    ["browser-fixture-expired", "账号会话响应无效"],
  ] as const;

  for (const [cookie, heading] of cases) {
    await request.post(`${fixtureUrl}/fixture/reset-account-state`);
    await context.clearCookies();
    await context.addCookies([{ name: "neuro_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
    await page.goto("/publisher/signing-keys?publisher=11111111-1111-4111-8111-111111111111");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    const content = await page.locator("body").innerText();
    expect(content).not.toContain("browser-fixture-access-token");
    expect(content).not.toContain("browser-private-subject");
    expect(content).not.toContain("accounts.browser.invalid");
    const state = await request.get(`${fixtureUrl}/fixture/account-state`);
    expect(await state.json()).toEqual({ protected_request_count: 0 });
  }
});

test("Publisher owner edits bounded draft package metadata through the server boundary", async ({ context, page }) => {
  await context.addCookies([{
    name: "neuro_session", value: "browser-fixture-session", domain: "127.0.0.1", path: "/",
  }]);
  await page.goto("/publisher/packages/22222222-2222-4222-8222-222222222222");
  await expect(page.getByRole("heading", { level: 1, name: "Neuro Painter" })).toBeVisible();
  await expect(page.getByText("neuro-painter · art")).toBeVisible();
  await page.getByLabel("Package 名称").fill("Neuro Painter Updated");
  await page.getByLabel("可见性").selectOption("unlisted");
  await page.getByLabel("摘要").fill("Updated through the browser journey.");
  await page.getByLabel("说明").fill("The Account bearer remains on the server.");
  await page.getByLabel("标签").fill("art, workflow, updated");
  await page.getByRole("button", { name: "保存 Package 草稿" }).click();
  await expect(page).toHaveURL(/\/publisher\/packages\/22222222-2222-4222-8222-222222222222$/);
  await page.goto("/publisher/packages/22222222-2222-4222-8222-222222222222");
  await expect(page.getByRole("heading", { level: 1, name: "Neuro Painter Updated" })).toBeVisible();
  await expect(page.getByLabel("可见性")).toHaveValue("unlisted");
  const content = await page.locator("body").innerText();
  expect(content).not.toContain("browser-fixture-access-token");
  expect(content).not.toContain("browser-private-subject");
  expect(content).not.toContain("accounts.browser.invalid");
  await expectNoOverflow(page);
  await expectAccessible(page);
  await expectVisual(page, "publisher-package-edit");
});
