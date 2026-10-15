import type { NAccountEnv } from "./naccount-config";

export function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function hash(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function pkce(verifier: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function encryptionKey(env: NAccountEnv) {
  const bytes = Uint8Array.from((env.NACCOUNT_SESSION_KEY ?? "").match(/../g) ?? [], (v) =>
    Number.parseInt(v, 16),
  );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** 令牌和 PKCE verifier 仅以绑定用途和行身份的密文持久化。 */
export async function seal(env: NAccountEnv, value: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await encryptionKey(env),
    new TextEncoder().encode(value),
  );
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(data)))}`;
}
export async function unseal(env: NAccountEnv, value: string, context: string) {
  const [iv, data] = value.split(".").map((v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
  if (!iv || !data || iv.length !== 12) throw new Error("SESSION_CIPHERTEXT_INVALID");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
      await encryptionKey(env),
      data,
    ),
  );
}
export async function expireAuth(db: D1Database) {
  const now = Date.now();
  const result = await db.batch([
    db
      .prepare(
        "DELETE FROM auth_transactions WHERE state_hash IN (SELECT state_hash FROM auth_transactions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM auth_sessions WHERE session_hash IN (SELECT session_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)",
      )
      .bind(now),
  ]);
  return result.reduce((sum, item) => sum + item.meta.changes, 0);
}
