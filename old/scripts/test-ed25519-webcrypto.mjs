import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

// Public synthetic fixture seeds only. No network or account credentials.
const fixture = JSON.parse(readFileSync(new URL("../fixtures/crypto/ed25519-compatibility-v1.json", import.meta.url)));
assert.equal(fixture.keys.length, 5);
assert.equal(fixture.signatures.length, 70);
const keys = new Map();
for (const vector of fixture.keys) {
  const seed = Buffer.from(vector.seed_hex, "hex");
  // RFC 8410 PKCS8 v1. Rust separately checks the frozen exported DER/PEM bytes.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  assert.equal(Buffer.from(jwk.x, "base64url").toString("hex"), vector.public_key_hex, vector.id);
  const publicKey = await webcrypto.subtle.importKey("raw", Buffer.from(vector.public_key_hex, "hex"), "Ed25519", false, ["verify"]);
  keys.set(vector.id, { privateKey, publicKey });
}
for (const vector of fixture.signatures) {
  const key = keys.get(vector.key);
  const message = Buffer.from(vector.message_hex, "hex");
  const expected = Buffer.from(vector.signature_hex, "hex");
  const signature = Buffer.from(await webcrypto.subtle.sign("Ed25519", key.privateKey, message));
  assert.deepEqual(signature, expected, `${vector.key}/${vector.message}`);
  assert.equal(await webcrypto.subtle.verify("Ed25519", key.publicKey, expected, message), true);
  const tampered = Buffer.from(expected);
  tampered[0] ^= 1;
  assert.equal(await webcrypto.subtle.verify("Ed25519", key.publicKey, tampered, message), false);
}
console.log(`Ed25519 WebCrypto: ${keys.size} derived public keys, 70 signatures and 70 tampered signatures checked`);
