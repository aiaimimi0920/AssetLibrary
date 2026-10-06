import "server-only";

import { headers } from "next/headers";

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
      || url.username || url.password || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isTrustedActionOrigin(origin: string | null, publicUrl: string | undefined): boolean {
  if (!origin) return false;
  const expected = safeOrigin(publicUrl ?? "http://localhost:3000");
  const actual = safeOrigin(origin);
  return expected !== null && actual === expected;
}

export async function hasTrustedActionOrigin(): Promise<boolean> {
  const requestHeaders = await headers();
  return isTrustedActionOrigin(
    requestHeaders.get("origin"),
    process.env.ASSETLIBRARY_PUBLIC_URL,
  );
}
