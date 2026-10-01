import { publicApiEndpoint } from './public-api';
import { validPublicSlug } from './public-origin';

export const SITEMAP_LEAF_LIMIT = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function validSitemapShard(value: string): boolean {
  return /^[0-9a-f]{2}$/.test(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing sitemap response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Sitemap response exceeds limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function request(path: string): Promise<unknown> {
  const url = publicApiEndpoint(path);
  if (url.username || url.password) throw new Error('Invalid sitemap API configuration');
  const response = await fetch(url, {
    cache: 'no-store', credentials: 'omit', redirect: 'error',
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Sitemap API unavailable');
  }
  return boundedJson(response);
}

export async function sitemapShards(): Promise<string[]> {
  const value = await request('/v1/public/sitemap');
  if (!record(value, ['schema_version', 'shards']) || value.schema_version !== '1.0'
    || !Array.isArray(value.shards) || value.shards.length > 256
    || !value.shards.every((shard): shard is string => typeof shard === 'string' && validSitemapShard(shard))
    || !value.shards.every((shard, i, shards) => i === 0 || shards[i - 1] < shard)) throw new Error('Invalid sitemap manifest');
  return value.shards;
}

export async function sitemapSlugs(shard: string): Promise<string[]> {
  if (!validSitemapShard(shard)) throw new Error('Invalid sitemap shard');
  const value = await request(`/v1/public/sitemap/${shard}`);
  if (!record(value, ['schema_version', 'shard', 'slugs']) || value.schema_version !== '1.0'
    || value.shard !== shard || !Array.isArray(value.slugs) || value.slugs.length > SITEMAP_LEAF_LIMIT
    || !value.slugs.every(validPublicSlug) || new Set(value.slugs).size !== value.slugs.length) {
    throw new Error('Invalid sitemap leaf');
  }
  return value.slugs;
}
