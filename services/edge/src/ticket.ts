export interface TicketClaims {
  issuer: string;
  audience: string;
  purpose: string;
  session_id: string;
  publisher_id: string;
  package_id: string;
  release_id: string;
  artifact_id: string;
  signing_key_id: string;
  client_type: "web" | "loom" | "hook" | "cli";
  digest: string;
  object_key: string;
  path: string;
  nonce: string;
  issued_at: number;
  not_before: number;
  expires_at: number;
}

export interface TicketExpectation {
  issuer: string;
  audience: string;
  path: string;
  digest: string;
  now: number;
}

const claimKeys: ReadonlyArray<keyof TicketClaims> = [
  "issuer", "audience", "purpose", "session_id", "publisher_id", "package_id",
  "release_id", "artifact_id", "signing_key_id", "client_type", "digest", "object_key", "path",
  "nonce", "issued_at", "not_before", "expires_at",
];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;

export async function verifyTicket(
  token: string,
  secret: string,
  expected: TicketExpectation,
): Promise<TicketClaims | null> {
  if (token.length > 4096) return null;
  const segments = token.split(".");
  if (segments.length !== 3 || segments[0] !== "v1") return null;
  const payload = segments[1];
  const signature = segments[2];
  if (!payload || !signature) return null;
  try {
    const keyBytes = decodeBase64Url(secret);
    if (keyBytes.byteLength < 32) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(`v1.${payload}`),
    );
    if (!valid) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    if (!isClaims(parsed) || !validClaims(parsed, expected)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return token.length > 0 ? token : null;
}

function isClaims(value: unknown): value is TicketClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== claimKeys.length || keys.some((key) => !claimKeys.includes(key as keyof TicketClaims))) {
    return false;
  }
  return typeof record.issuer === "string"
    && typeof record.audience === "string"
    && typeof record.purpose === "string"
    && typeof record.signing_key_id === "string"
    && ["web", "loom", "hook", "cli"].includes(record.client_type as string)
    && typeof record.digest === "string"
    && typeof record.object_key === "string"
    && typeof record.path === "string"
    && typeof record.issued_at === "number"
    && typeof record.not_before === "number"
    && typeof record.expires_at === "number"
    && [record.session_id, record.publisher_id, record.package_id, record.release_id,
      record.artifact_id, record.nonce].every((id) => typeof id === "string" && uuidPattern.test(id));
}

function validClaims(claims: TicketClaims, expected: TicketExpectation): boolean {
  const canonicalKey = `sha256/${claims.digest.slice(0, 2)}/${claims.digest}`;
  return claims.issuer === expected.issuer
    && claims.audience === expected.audience
    && claims.purpose === "download"
    && claims.path === expected.path
    && claims.digest === expected.digest
    && digestPattern.test(claims.digest)
    && claims.object_key === canonicalKey
    && /^[!-~]{1,200}$/.test(claims.signing_key_id)
    && claims.not_before <= expected.now + 5
    && claims.issued_at <= expected.now + 30
    && claims.expires_at > expected.now
    && claims.expires_at > claims.issued_at
    && claims.expires_at - claims.issued_at <= 900;
}

function decodeBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}
