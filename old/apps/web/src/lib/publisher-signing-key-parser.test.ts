import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isCanonicalEd25519PublicKey,
  parsePublisherSigningKeyPage,
} from "./publisher-signing-key-parser";

function fixture(): { items: Array<Record<string, unknown>> } {
  const path = fileURLToPath(new URL(
    "../../../../contracts/fixtures/publisher-signing-key-page.v1.json", import.meta.url,
  ));
  return JSON.parse(readFileSync(path, "utf8")) as { items: Array<Record<string, unknown>> };
}

describe("Publisher signing-key runtime contract", () => {
  it("parses the shared public-key fixture", () => {
    const page = parsePublisherSigningKeyPage(fixture());
    expect(page.items[0]).toMatchObject({
      key_id: "release-2026",
      algorithm: "ed25519",
      status: "active",
    });
  });

  it("rejects non-canonical material and unknown secret-bearing fields", () => {
    expect(isCanonicalEd25519PublicKey("ERER")).toBe(false);
    const page = fixture();
    page.items[0]!.private_key = "must-never-enter-the-contract";
    expect(() => parsePublisherSigningKeyPage(page)).toThrow("Invalid Publisher signing-key contract");
  });

  it("requires revoked keys to carry a revocation timestamp", () => {
    const page = fixture();
    page.items[0]!.status = "revoked";
    expect(() => parsePublisherSigningKeyPage(page)).toThrow("Invalid Publisher signing-key contract");
  });
});
