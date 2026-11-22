import { HttpError } from "../http";
import { isWebAssetPath } from "../web/paths";

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface TrafficLimitEnv {
  RATE_LIMIT_PUBLIC?: RateLimiterBinding;
  RATE_LIMIT_AUTH?: RateLimiterBinding;
  RATE_LIMIT_WRITE?: RateLimiterBinding;
  RATE_LIMIT_PUBLIC_PER_MIN?: string;
  RATE_LIMIT_AUTH_PER_MIN?: string;
  RATE_LIMIT_WRITE_PER_MIN?: string;
}

export class RateLimitError extends HttpError {
  constructor(public retryAfter: number) {
    super(429, "RATE_LIMITED");
  }
}

type BucketKind = "public" | "auth" | "write";

interface WindowRecord {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_URL_LENGTH = 2048;
const MAX_TRACKED_KEYS = 2048;
const DEFAULT_LIMITS: Record<BucketKind, number> = {
  public: 300,
  auth: 15,
  write: 120,
};

const windows = new Map<string, WindowRecord>();

export function resetMemoryRateLimits(): void {
  windows.clear();
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) return fallback;
  return parsed;
}

/** 将 IPv6 归一化到 /64 前缀，防止攻击者轮换同一 /64 子网内的接口标识绕过限流。 */
export function normalizeClientIp(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 64 || !/^[0-9a-f:.]+$/.test(trimmed)) return null;
  if (!trimmed.includes(":")) return trimmed;

  const halves = trimmed.split("::");
  if (halves.length > 2) return trimmed;
  const parseSide = (part: string) =>
    part ? part.split(":").filter((piece) => piece.length > 0) : [];
  const left = parseSide(halves[0] ?? "");
  const right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  const ipv4Tail = right.at(-1)?.includes(".") || left.at(-1)?.includes(".") ? 1 : 0;
  const totalGroups = 8 - ipv4Tail;
  const missing = halves.length === 2 ? Math.max(0, totalGroups - left.length - right.length) : 0;
  const full = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (full.length < 4) return trimmed;
  return `${full
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

function classifyBucket(request: Request, pathname: string): BucketKind | null {
  if (["GET", "HEAD"].includes(request.method) && isWebAssetPath(pathname)) return null;
  if (pathname === "/auth/login" || pathname === "/auth/callback") return "auth";
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) return "write";
  return "public";
}

function evictIfNeeded(now: number): void {
  if (windows.size < MAX_TRACKED_KEYS) return;
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
    if (windows.size < MAX_TRACKED_KEYS) return;
  }
  const oldest = windows.keys().next().value;
  if (oldest !== undefined) windows.delete(oldest);
}

function checkMemoryWindow(key: string, limit: number, now: number): void {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.delete(key);
    evictIfNeeded(now);
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (existing.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    throw new RateLimitError(retryAfter);
  }
  existing.count += 1;
}

export async function enforceTrafficGuard(
  request: Request,
  env: TrafficLimitEnv,
  now = Date.now(),
): Promise<void> {
  if (request.url.length > MAX_URL_LENGTH) {
    throw new HttpError(414, "URI_TOO_LONG");
  }
  const pathname = new URL(request.url).pathname;
  const bucket = classifyBucket(request, pathname);
  if (!bucket) return;

  const clientKey = normalizeClientIp(request.headers.get("CF-Connecting-IP"));
  const nativeBinding =
    bucket === "auth"
      ? env.RATE_LIMIT_AUTH
      : bucket === "write"
        ? env.RATE_LIMIT_WRITE
        : env.RATE_LIMIT_PUBLIC;

  if (!clientKey) {
    if (nativeBinding) {
      const outcome = await nativeBinding.limit({ key: `${bucket}:local` });
      if (!outcome.success) throw new RateLimitError(10);
    }
    return;
  }

  const scopedKey = `${bucket}:${clientKey}`;
  const limit =
    bucket === "auth"
      ? parseLimit(env.RATE_LIMIT_AUTH_PER_MIN, DEFAULT_LIMITS.auth)
      : bucket === "write"
        ? parseLimit(env.RATE_LIMIT_WRITE_PER_MIN, DEFAULT_LIMITS.write)
        : parseLimit(env.RATE_LIMIT_PUBLIC_PER_MIN, DEFAULT_LIMITS.public);
  checkMemoryWindow(scopedKey, limit, now);

  if (nativeBinding) {
    const outcome = await nativeBinding.limit({ key: scopedKey });
    if (!outcome.success) throw new RateLimitError(10);
  }
}
