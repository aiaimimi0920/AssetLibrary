import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(), currentAccountSession: vi.fn(), register: vi.fn(), revoke: vi.fn(), redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/account-session", () => ({ currentAccountSession: mocks.currentAccountSession }));
vi.mock("@/lib/publisher-api", () => ({
  registerPublisherSigningKey: mocks.register,
  revokePublisherSigningKey: mocks.revoke,
}));

import { registerSigningKeyAction, revokeSigningKeyAction } from "./actions";

const publisherId = "11111111-1111-4111-8111-111111111111";
const publicKey = "ERERERERERERERERERERERERERERERERERERERERERE=";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  Object.entries(fields).forEach(([name, value]) => data.set(name, value));
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASSETLIBRARY_PUBLIC_URL", "https://assets.neuro.example");
  mocks.headers.mockResolvedValue(new Headers({ origin: "https://assets.neuro.example" }));
  mocks.currentAccountSession.mockResolvedValue({
    ok: true, session: { access_token: "publisher-access-token-that-is-long-enough" },
  });
  mocks.register.mockResolvedValue({ ok: true, data: { key_id: "release-2026" } });
  mocks.revoke.mockResolvedValue({ ok: true, data: { key_id: "release-2026", status: "revoked" } });
});

describe("Publisher signing-key Server Actions", () => {
  it("registers public material without accepting a private-key field", async () => {
    await registerSigningKeyAction({}, form({
      publisher_id: publisherId, idempotency_key: "register-key-2026",
      key_id: "release-2026", public_key_base64: publicKey,
      private_key: "must-be-ignored-by-the-contract",
    }));
    expect(mocks.register).toHaveBeenCalledWith(
      "publisher-access-token-that-is-long-enough", publisherId, "register-key-2026",
      { key_id: "release-2026", algorithm: "ed25519", public_key_base64: publicKey },
    );
    expect(mocks.register.mock.calls[0]?.flat().join(" ")).not.toContain("must-be-ignored");
    expect(mocks.redirect).toHaveBeenCalledWith(`/publisher/signing-keys?publisher=${publisherId}`);
  });

  it("rejects malformed public material before Account Service access", async () => {
    await expect(registerSigningKeyAction({}, form({
      publisher_id: publisherId, idempotency_key: "register-key-2026",
      key_id: "release-2026", public_key_base64: "not-a-public-key",
    }))).resolves.toMatchObject({ error: expect.stringContaining("Ed25519 公钥") });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });

  it("requires confirmation and a trusted origin before revocation", async () => {
    const fields = { publisher_id: publisherId, key_id: "release-2026",
      idempotency_key: "revoke-key-2026", reason: "Retired after rotation.", confirm: "yes" };
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(revokeSigningKeyAction({}, form(fields)))
      .resolves.toEqual({ error: "请求来源验证失败，密钥未吊销。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
