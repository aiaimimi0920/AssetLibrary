import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPublisherSigningKeys,
  registerPublisherSigningKey,
  revokePublisherSigningKey,
} from "./publisher-api";

vi.mock("server-only", () => ({}));

const token = "publisher-access-token-that-is-long-enough";
const publisherId = "11111111-1111-4111-8111-111111111111";
const page = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../../contracts/fixtures/publisher-signing-key-page.v1.json", import.meta.url,
)), "utf8"));
const signingKey = page.items[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Publisher signing-key API client", () => {
  it("lists, registers, and irreversibly revokes public material server-side", async () => {
    const revoked = { ...signingKey, status: "revoked", revoked_at: "2026-09-04T09:00:00Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(signingKey), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(revoked), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPublisherSigningKeys(token, publisherId, { limit: 30 }))
      .resolves.toMatchObject({ ok: true, data: { items: [{ status: "active" }] } });
    await expect(registerPublisherSigningKey(token, publisherId, "register-key-2026", {
      key_id: signingKey.key_id,
      algorithm: "ed25519",
      public_key_base64: signingKey.public_key_base64,
    })).resolves.toMatchObject({ ok: true, data: { key_id: "release-2026" } });
    await expect(revokePublisherSigningKey(
      token, publisherId, signingKey.key_id, "revoke-key-2026", "Retired after rotation.",
    )).resolves.toMatchObject({ ok: true, data: { status: "revoked" } });

    expect((fetchMock.mock.calls[0]?.[0] as URL).href)
      .toBe(`http://127.0.0.1:8080/v1/me/publishers/${publisherId}/signing-keys?limit=30`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "register-key-2026" },
      body: JSON.stringify({
        key_id: signingKey.key_id, algorithm: "ed25519",
        public_key_base64: signingKey.public_key_base64,
      }),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reason: "Retired after rotation." }),
    });
  });

  it("rejects malformed keys and reasons before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerPublisherSigningKey(token, publisherId, "register-key-2026", {
      key_id: "Release Key",
      algorithm: "ed25519",
      public_key_base64: signingKey.public_key_base64,
    })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(revokePublisherSigningKey(
      token, publisherId, signingKey.key_id, "revoke-key-2026", " padded ",
    )).resolves.toEqual({ ok: false, failure: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a valid response that crosses the requested Publisher boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...page,
      items: [{ ...signingKey, publisher_id: "22222222-2222-4222-8222-222222222222" }],
    }), { status: 200 })));

    await expect(listPublisherSigningKeys(token, publisherId))
      .resolves.toEqual({ ok: false, failure: "invalid_response" });
  });

  it("rejects mutation responses that cross their requested resource boundary", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...signingKey, publisher_id: "22222222-2222-4222-8222-222222222222",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...signingKey, key_id: "unexpected-key", status: "revoked",
        revoked_at: "2026-09-04T09:00:00Z",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerPublisherSigningKey(token, publisherId, "register-key-2026", {
      key_id: signingKey.key_id,
      algorithm: "ed25519",
      public_key_base64: signingKey.public_key_base64,
    })).resolves.toEqual({ ok: false, failure: "invalid_response" });
    await expect(revokePublisherSigningKey(
      token, publisherId, signingKey.key_id, "revoke-key-2026", "Retired after rotation.",
    )).resolves.toEqual({ ok: false, failure: "invalid_response" });
  });
});
