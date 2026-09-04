import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePackagePage, parsePublishedPackage } from "./contracts";

const fixturePath = fileURLToPath(
  new URL("../../../../contracts/fixtures/package-page.v1.json", import.meta.url),
);

describe("shared package page contract", () => {
  it("parses the cross-language fixture", () => {
    const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    const page = parsePackagePage(fixture);

    expect(page.schema_version).toBe("1.0");
    expect(page.items[0]?.kind).toBe("art");
  });

  it("rejects an unsupported major contract", () => {
    expect(() => parsePackagePage({ schema_version: "2.0", items: [], next_cursor: null })).toThrow();
  });

  it("rejects malformed package details", () => {
    expect(() => parsePublishedPackage({ id: "not-a-package" })).toThrow(
      "Invalid AssetLibrary package contract",
    );
  });
});
