import { defineConfig, devices } from "@playwright/test";

const fixturePort = Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? "18900");
const webPort = Number(process.env.ASSETLIBRARY_BROWSER_WEB_PORT ?? "18901");
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/browser",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.015 },
  },
  webServer: [
    {
      command: "node e2e/fixture-server.mjs",
      url: `${fixtureUrl}/healthz`,
      env: {
        ASSETLIBRARY_BROWSER_FIXTURE_PORT: String(fixturePort),
        ASSETLIBRARY_BROWSER_WEB_PORT: String(webPort),
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `pnpm build && pnpm start -p ${webPort}`,
      url: `${webUrl}/healthz`,
      env: {
        ASSETLIBRARY_BROWSER_TEST: "1",
        ASSETLIBRARY_API_URL: fixtureUrl,
        ASSETLIBRARY_PUBLIC_URL: webUrl,
        ASSETLIBRARY_ACCOUNT_SESSION_URL: `${fixtureUrl}/v1/session`,
        ASSETLIBRARY_ACCOUNT_SESSION_COOKIE: "neuro_session",
        ASSETLIBRARY_UPLOAD_ORIGINS: fixtureUrl,
        ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL: `http://localhost:${fixturePort}`,
        ASSETLIBRARY_BROWSER_WEB_PORT: String(webPort),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
});
