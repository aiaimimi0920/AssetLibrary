import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);

if (command === "keygen" && args.length === 1) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(args[0], privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const jwk = publicKey.export({ format: "jwk" });
  process.stdout.write(Buffer.from(jwk.x, "base64url").toString("base64"));
} else if (command === "sign" && args.length === 3) {
  const challenge = JSON.parse(readFileSync(args[1], "utf8"));
  const installedAt = Number(args[2]);
  if (!Number.isSafeInteger(installedAt) || installedAt <= 0) throw new Error("invalid timestamp");
  const payload = [
    "assetlibrary-install-receipt-v1",
    `receipt_id=${challenge.receipt_id}`,
    `download_session_id=${challenge.download_session_id}`,
    `release_id=${challenge.artifact.release_id}`,
    `artifact_id=${challenge.artifact.artifact_id}`,
    `canonical_sha256=${challenge.artifact.digest}`,
    `archive_sha256=${challenge.archive_sha256}`,
    `host_profile_sha256=${challenge.host_profile_sha256}`,
    `nonce=${challenge.nonce}`,
    `client_instance_id=${challenge.client_instance_id}`,
    `installed_at=${installedAt}`,
    "",
  ].join("\n");
  const privateKey = readFileSync(args[0], "utf8");
  process.stdout.write(sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"));
} else {
  throw new Error("usage: sign-install-receipt.mjs keygen <private.pem> | sign <private.pem> <challenge.json> <epoch>");
}
