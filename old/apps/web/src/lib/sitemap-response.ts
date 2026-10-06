import { publicOrigin } from './public-origin';
import { sitemapShards, sitemapSlugs, validSitemapShard } from './sitemap-api';

const NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const MAX_XML_BYTES = 50 * 1024 * 1024;

function failure(status: number): Response {
  return new Response(status === 503 ? 'Public sitemap temporarily unavailable.\n' : 'Not found.\n', {
    status, headers: { 'cache-control': 'no-store', ...(status === 503 ? { 'retry-after': '60' } : {}) },
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function sitemapXml(urls: string[], index = false): Response {
  if (urls.length > 50_000 || urls.some((url) => url.length >= 2048)) return failure(503);
  const root = index ? 'sitemapindex' : 'urlset';
  const entry = index ? 'sitemap' : 'url';
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NAMESPACE}">`
    + urls.map((url) => `<${entry}><loc>${escapeXml(url)}</loc></${entry}>`).join('') + `</${root}>\n`;
  if (Buffer.byteLength(body, 'utf8') > MAX_XML_BYTES) return failure(503);
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function sitemapResponse(query: string): Promise<Response> {
  // No cursor, URL, or host from a crawler may select the upstream request.
  if (query.length > 32) return failure(404);
  const parameters = new URLSearchParams(query);
  const shard = parameters.get('shard');
  if (parameters.size && (parameters.size !== 1 || !shard
    || shard !== 'home' && !validSitemapShard(shard))) return failure(404);
  const origin = publicOrigin();
  if (!origin) return failure(503);
  try {
    if (shard === 'home') return sitemapXml([`${origin}/`]);
    if (!shard) {
      const shards = await sitemapShards();
      return sitemapXml([`${origin}/sitemap.xml?shard=home`, ...shards.map((id) => `${origin}/sitemap.xml?shard=${id}`)], true);
    }
    const slugs = await sitemapSlugs(shard);
    return slugs.length ? sitemapXml(slugs.map((slug) => `${origin}/packages/${slug}`)) : failure(404);
  } catch {
    return failure(503);
  }
}
