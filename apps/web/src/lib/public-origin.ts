// Canonical links come only from operator configuration, never request headers.
export function publicOrigin(): string | undefined {
  const raw = process.env.ASSETLIBRARY_PUBLIC_URL;
  if (!raw) return undefined;
  if (raw.length > 300 || /[\u0000-\u0020\u007f?#]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function validPublicSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}
