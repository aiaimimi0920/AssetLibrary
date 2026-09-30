import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./browser-contract";

const packageId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const fixtureUrl = `http://127.0.0.1:${process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? "18900"}`;
const file = { name: "browser-recovery.zip", mimeType: "application/zip",
  buffer: Buffer.alloc(8_388_609) };

test("Publisher resumes only matching object-store parts after a page reload", async ({ context, page, request }) => {
  await request.post(`${fixtureUrl}/fixture/reset-upload`);
  await context.addCookies([{
    name: "neuro_session", value: "browser-fixture-session", domain: "127.0.0.1", path: "/",
  }]);
  await page.goto(`/publisher/packages/${packageId}/releases/${releaseId}`);
  await expect(page.getByRole("heading", { level: 1, name: /Neuro Painter.*v1\.0\.0/ })).toBeVisible();
  const input = page.getByLabel("Artifact ZIP");
  await input.setInputFiles(file);
  await page.getByRole("button", { name: "开始安全直传" }).click();
  await expect.poll(async () => {
    const response = await request.get(`${fixtureUrl}/fixture/upload-state`);
    return (await response.json()).parts;
  }).toEqual([1]);
  const stored = await page.evaluate((id) => sessionStorage.getItem(`assetlibrary.upload.v1.${id}`), releaseId);
  expect(stored).toContain("browser-recovery.zip");
  expect(stored).not.toMatch(/object_key|access_token|presigned|signed_url|authorization/i);

  await page.reload();
  await expect(page.getByText("可恢复上传", { exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await input.setInputFiles(file);
  await page.getByRole("button", { name: "校验并恢复直传" }).click();
  await expect(page.getByText("已进入扫描队列", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${fixtureUrl}/fixture/upload-state`);
    return (await response.json()).parts;
  }).toEqual([1, 2]);
  await expect.poll(() => page.evaluate((id) =>
    sessionStorage.getItem(`assetlibrary.upload.v1.${id}`), releaseId)).toBeNull();

  // The client completion message precedes router.refresh(). Audit the refreshed document.
  await expect(page.getByRole("heading", { level: 3, name: file.name })).toBeVisible();
  await expect(page.getByText("等待扫描", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Neuro Painter.*v1\.0\.0/ })).toBeVisible();
  await expect(page).toHaveTitle("Release 工作区 | AssetLibrary");

  const content = await page.locator("body").innerText();
  expect(content).not.toContain("browser-fixture-access-token");
  expect(content).not.toContain("browser-private-subject");
  expect(content).not.toContain("accounts.browser.invalid");
  const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});
