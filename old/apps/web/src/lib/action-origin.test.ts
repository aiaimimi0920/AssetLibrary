import { describe, expect, it, vi } from "vitest";
import { isTrustedActionOrigin } from "./action-origin";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

describe("server action origin policy", () => {
  it("accepts only the configured HTTPS origin", () => {
    expect(isTrustedActionOrigin("https://assets.neuro.example", "https://assets.neuro.example/store"))
      .toBe(true);
    expect(isTrustedActionOrigin("https://attacker.example", "https://assets.neuro.example"))
      .toBe(false);
    expect(isTrustedActionOrigin(null, "https://assets.neuro.example")).toBe(false);
  });

  it("permits loopback HTTP without permitting remote plaintext origins", () => {
    expect(isTrustedActionOrigin("http://127.0.0.1:3000", "http://127.0.0.1:3000"))
      .toBe(true);
    expect(isTrustedActionOrigin("http://assets.example", "http://assets.example"))
      .toBe(false);
    expect(isTrustedActionOrigin("null", "https://assets.neuro.example")).toBe(false);
  });
});
