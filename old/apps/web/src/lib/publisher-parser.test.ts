import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMembershipPage, parseOwnedPackagePage, parseOwnedRelease, parseOwnedReleasePage } from "./publisher-parser";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../../contracts/fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("Publisher console runtime contracts", () => {
  it("parses all shared Publisher fixtures", () => {
    expect(parseMembershipPage(fixture("publisher-membership-page.v1.json")).items[0]?.role).toBe("owner");
    expect(parseOwnedPackagePage(fixture("owned-package-page.v1.json")).items[0]?.status).toBe("draft");
    expect(parseOwnedReleasePage(fixture("owned-release-page.v1.json")).items[0]?.version).toBe("1.0.0");
  });

  it("rejects unknown fields and malformed release identity", () => {
    const packagePage = fixture("owned-package-page.v1.json") as { items: Array<Record<string, unknown>> };
    packagePage.items[0]!.storage_key = "must-not-render";
    expect(() => parseOwnedPackagePage(packagePage)).toThrow("Invalid owned package contract");

    const releasePage = fixture("owned-release-page.v1.json") as { items: Array<Record<string, unknown>> };
    releasePage.items[0]!.version = "latest";
    expect(() => parseOwnedReleasePage(releasePage)).toThrow("Invalid owned release contract");
  });

  it("requires full RFC 3339 timestamps for optimistic release editing", () => {
    const releasePage = fixture("owned-release-page.v1.json") as { items: Array<Record<string, unknown>> };
    releasePage.items[0]!.updated_at = "2026-09-03";
    expect(() => parseOwnedRelease(releasePage.items[0])).toThrow("Invalid owned release contract");
  });
});
