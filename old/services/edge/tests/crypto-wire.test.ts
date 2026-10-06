import { expect, it } from "vitest";
import { verifyTicket, type TicketClaims } from "../src/ticket";
import fixture from "../../../fixtures/crypto/compatibility-v1.json";

interface Golden {
  ticket: { claims: TicketClaims; encoded_ticket: string; database_sha256_hex: string };
  hmac_boundaries: Array<{ key_bytes: number; signature_base64url: string; database_sha256_hex: string }>;
  sha256_boundaries: Array<{ size: number; sha256_hex: string }>;
  archive: { zip_base64: string; raw_sha256_hex: string; canonical_sha256_hex: string };
  signature: { public_key_base64: string; fingerprint: string; ed25519_base64: string };
}

const golden = fixture as Golden;
const encode = (value: string) => new TextEncoder().encode(value).buffer;
const base64url = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0)).buffer;
const digest = async (value: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
  byte => byte.toString(16).padStart(2, "0")).join("");

it("accepts the frozen Rust ticket through the production edge verifier", async () => {
  const claims = golden.ticket.claims;
  const expected = { issuer: claims.issuer, audience: claims.audience, path: claims.path, digest: claims.digest, now: 1_700_000_001 };
  const key = base64url(new Uint8Array(32).fill(42).buffer);
  expect(await verifyTicket(golden.ticket.encoded_ticket, key, expected)).toEqual(claims);
  expect(await verifyTicket(golden.ticket.encoded_ticket, base64url(new Uint8Array(32).fill(43).buffer), expected)).toBeNull();
  expect(await verifyTicket(`${golden.ticket.encoded_ticket}x`, key, expected)).toBeNull();
  expect(await verifyTicket(golden.ticket.encoded_ticket, key, { ...expected, path: "/wrong" })).toBeNull();
});

it("independently reproduces HMAC ticket bytes and database hashes with WebCrypto", async () => {
  const fields: Array<keyof TicketClaims> = ["issuer", "audience", "purpose", "session_id", "publisher_id", "package_id",
    "release_id", "artifact_id", "signing_key_id", "client_type", "digest", "object_key", "path", "nonce", "issued_at", "not_before", "expires_at"];
  const claims = Object.fromEntries(fields.map(field => [field, golden.ticket.claims[field]]));
  const prefix = `v1.${base64url(encode(JSON.stringify(claims)))}`;
  for (const vector of golden.hmac_boundaries) {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(vector.key_bytes).fill(42).buffer,
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const signature = await crypto.subtle.sign("HMAC", key, encode(prefix));
    expect(base64url(signature)).toBe(vector.signature_base64url);
    const encoded = `${prefix}.${base64url(signature)}`;
    expect(await digest(encode(encoded))).toBe(vector.database_sha256_hex);
    expect(await crypto.subtle.verify("HMAC", key, signature, encode(`${prefix}x`))).toBe(false);
    if (vector.key_bytes === 32) {
      expect(encoded).toBe(golden.ticket.encoded_ticket);
      expect(await digest(encode(encoded))).toBe(golden.ticket.database_sha256_hex);
    }
  }
});

it("independently verifies frozen SHA256 boundaries, archive identity and Ed25519 signature", async () => {
  for (const vector of golden.sha256_boundaries) {
    const bytes = Uint8Array.from({ length: vector.size }, (_, index) => index % 251);
    expect(await digest(bytes.buffer)).toBe(vector.sha256_hex);
  }
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  for (const [name, text] of [["a.txt", "one"], ["b.txt", "two"]] as const) {
    const bytes = new TextEncoder().encode(text);
    const size = new ArrayBuffer(8);
    new DataView(size).setBigUint64(0, BigInt(bytes.length), true);
    pieces.push(new TextEncoder().encode(name), new Uint8Array([0]), new Uint8Array(size), new Uint8Array([0]), bytes);
  }
  const canonical = new Uint8Array(pieces.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const piece of pieces) { canonical.set(piece, offset); offset += piece.length; }
  expect(await digest(canonical.buffer)).toBe(golden.archive.canonical_sha256_hex);
  expect(await digest(decode(golden.archive.zip_base64))).toBe(golden.archive.raw_sha256_hex);
  const publicBytes = decode(golden.signature.public_key_base64);
  expect(`sha256:${await digest(publicBytes)}`).toBe(golden.signature.fingerprint);
  const key = await crypto.subtle.importKey("raw", publicBytes, "Ed25519", false, ["verify"]);
  const signature = decode(golden.signature.ed25519_base64);
  expect(await crypto.subtle.verify("Ed25519", key, signature, encode(golden.archive.canonical_sha256_hex))).toBe(true);
  expect(await crypto.subtle.verify("Ed25519", key, signature, encode("wrong digest"))).toBe(false);
});
