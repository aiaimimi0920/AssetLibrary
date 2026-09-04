import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePublishedReleasePage, parsePublisherProfile } from "./public-details";

const fixturePath = fileURLToPath(
  new URL("../../../../contracts/fixtures/published-release-page.v1.json", import.meta.url),
);

function releaseFixture() {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("public catalog detail contracts", () => {
  it("parses the cross-language release fixture", () => {
    const fixture: unknown = releaseFixture();
    const page = parsePublishedReleasePage(fixture);

    expect(page.items[0]?.compatibility.products[0]?.name).toBe("loom");
    expect(page.items[0]?.artifacts[0]?.digest).toHaveLength(64);
  });

  it("rejects artifact/release identity mismatches and undeclared fields", () => {
    const fixture = releaseFixture();
    fixture.items[0].artifacts[0].release_id = "different";
    expect(() => parsePublishedReleasePage(fixture)).toThrow();

    expect(() => parsePublisherProfile({
      schema_version: "1.0",
      publisher: { id: "publisher", slug: "valid", display_name: "Valid", internal: true },
    })).toThrow();
  });

  it("rejects impossible dates, path segments, and non-descending pages", () => {
    const impossibleDate = releaseFixture();
    impossibleDate.items[0].published_at = "2026-02-30T08:00:00Z";
    expect(() => parsePublishedReleasePage(impossibleDate)).toThrow();

    const pathSegment = releaseFixture();
    pathSegment.items[0].artifacts[0].file_name = "..";
    expect(() => parsePublishedReleasePage(pathSegment)).toThrow();

    const unordered = releaseFixture();
    const second = structuredClone(unordered.items[0]);
    second.id = "018f47d2-4a75-7fa1-a12b-9a1f19d46ec0";
    second.artifacts[0].artifact_id = "018f47d2-4a75-7fa1-a12b-9a1f19d46ec1";
    second.artifacts[0].release_id = second.id;
    second.published_at = "2026-09-04T08:00:00Z";
    unordered.items.push(second);
    expect(() => parsePublishedReleasePage(unordered)).toThrow("release-page order");
  });
});
