import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { listPublisherMemberships, listPublisherSigningKeys } from "@/lib/publisher-api";
import PublisherSigningKeysPage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-session", () => ({
  accountLoginUrl: vi.fn(), currentAccountSession: vi.fn(),
}));
vi.mock("@/lib/publisher-api", () => ({
  listPublisherMemberships: vi.fn(), listPublisherSigningKeys: vi.fn(),
}));

const publisherId = "11111111-1111-4111-8111-111111111111";
const accessToken = "secret-publisher-access-token-that-must-not-render";
const membership = { publisher: { id: publisherId, slug: "neuro-labs", display_name: "Neuro Labs" },
  publisher_status: "active" as const, role: "owner" as const };
const signingKey = { publisher_id: publisherId, key_id: "release-2026", algorithm: "ed25519" as const,
  public_key_base64: "ERERERERERERERERERERERERERERERERERERERERERE=",
  fingerprint: "sha256:02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc",
  status: "active" as const, created_at: "2026-09-04T08:00:00Z", revoked_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentAccountSession).mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "private-subject" },
    access_token: accessToken, expires_at: "2099-01-01T00:00:00Z",
  } });
  vi.mocked(listPublisherMemberships).mockResolvedValue({ ok: true, data: {
    schema_version: "1.0", items: [membership], next_cursor: null,
  } });
  vi.mocked(listPublisherSigningKeys).mockResolvedValue({ ok: true, data: {
    schema_version: "1.0", items: [signingKey], next_cursor: null,
  } });
});

describe("Publisher signing-key workspace SSR", () => {
  it("renders only public trust material without leaking external identity or bearer data", async () => {
    const html = renderToStaticMarkup(await PublisherSigningKeysPage({
      searchParams: Promise.resolve({ publisher: publisherId }),
    }));
    expect(html).toContain("私钥永远不会进入商店");
    expect(html).toContain(signingKey.fingerprint);
    expect(html).toContain(signingKey.public_key_base64);
    expect(html).not.toContain(accessToken);
    expect(html).not.toContain("private-subject");
    expect(html).not.toContain("https://accounts.example");
  });

  it("keeps a Release Manager read-only", async () => {
    vi.mocked(listPublisherMemberships).mockResolvedValueOnce({ ok: true, data: {
      schema_version: "1.0", items: [{ ...membership, role: "release_manager" }], next_cursor: null,
    } });
    const html = renderToStaticMarkup(await PublisherSigningKeysPage({
      searchParams: Promise.resolve({ publisher: publisherId }),
    }));
    expect(html).toContain("可以核验公钥状态");
    expect(html).not.toContain("name=\"public_key_base64\"");
    expect(html).not.toContain("不可逆吊销</button>");
  });
});
