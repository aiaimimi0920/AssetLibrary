import { expect, test as base, type ConsoleMessage } from "@playwright/test";

// React 19 SSR/hydration failures must not pass through client rerendering.
const hydrationErrors = [
  /Minified React error #(418|419|421|422|423|424)\b/,
  /Hydration failed because the server rendered/,
  /A tree hydrated but some attributes of the server rendered HTML/,
  /The server could not finish this Suspense boundary/,
  /There was an error while hydrating/,
  /This Suspense boundary received an update before it finished hydrating/,
  /This root received an early update, before anything was able hydrate/,
];

export const test = base.extend<{ runtimeErrors: void }>({
  runtimeErrors: [async ({ page }, runTest) => {
    const errors: string[] = [];
    const record = (message: string) => {
      if (errors.length < 10) errors.push(message.slice(0, 1_000));
    };
    const onPageError = (error: Error) => record(`pageerror: ${error.message}`);
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === "error" && hydrationErrors.some((pattern) => pattern.test(message.text()))) {
        record(`hydration: ${message.text()}`);
      }
    };
    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    try {
      await runTest();
    } finally {
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
    }
    expect(errors, "Page exceptions and React SSR/hydration failures").toEqual([]);
  }, { auto: true }],
});

export { expect };
