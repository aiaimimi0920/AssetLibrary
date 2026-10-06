import { Buffer } from "node:buffer";
import type {
  PublisherSigningKey,
  PublisherSigningKeyPage,
} from "./publisher-signing-key-contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyId = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const fingerprint = /^sha256:[a-f0-9]{64}$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function dateTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && rfc3339.test(value) && Number.isFinite(Date.parse(value));
}

export function isCanonicalEd25519PublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}

export function parsePublisherSigningKey(value: unknown): PublisherSigningKey {
  const keys = ["publisher_id", "key_id", "algorithm", "public_key_base64", "fingerprint",
    "status", "created_at", "revoked_at"];
  if (!exact(value, keys)
    || typeof value.publisher_id !== "string" || !uuid.test(value.publisher_id)
    || typeof value.key_id !== "string" || !keyId.test(value.key_id)
    || value.algorithm !== "ed25519"
    || !isCanonicalEd25519PublicKey(value.public_key_base64)
    || typeof value.fingerprint !== "string" || !fingerprint.test(value.fingerprint)
    || !["active", "revoked"].includes(String(value.status))
    || !dateTime(value.created_at)
    || value.status === "active" && value.revoked_at !== null
    || value.status === "revoked" && !dateTime(value.revoked_at)) {
    throw new Error("Invalid Publisher signing-key contract");
  }
  return value as unknown as PublisherSigningKey;
}

export function parsePublisherSigningKeyPage(value: unknown): PublisherSigningKeyPage {
  if (!exact(value, ["schema_version", "items", "next_cursor"])
    || value.schema_version !== "1.0" || !Array.isArray(value.items) || value.items.length > 100
    || !(value.next_cursor === null
      || typeof value.next_cursor === "string" && value.next_cursor.length <= 256)) {
    throw new Error("Invalid Publisher signing-key page contract");
  }
  return {
    schema_version: "1.0",
    items: value.items.map(parsePublisherSigningKey),
    next_cursor: value.next_cursor,
  };
}
