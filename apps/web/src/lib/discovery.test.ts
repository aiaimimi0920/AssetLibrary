import { afterEach, describe, expect, it, vi } from 'vitest';
import robotsParser from 'robots-parser';
import robots from '../app/robots';
import { publicOrigin } from './public-origin';
import { packageStructuredData } from './package-structured-data';
import type { PublishedPackage } from './contracts';
import { sitemapResponse, sitemapXml } from './sitemap-response';
import { sitemapShards, sitemapSlugs } from './sitemap-api';

const published: PublishedPackage = {
  id: 'public-package', slug: 'safe-art', name: 'Safe Art', kind: 'art', status: 'published',
  summary: '</script><script>globalThis.injected = true</script> & \u2028',
  publisher: { id: 'public-publisher', slug: 'safe-publisher', display_name: 'Publisher' },
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function setup(body: unknown, status = 200) {
  vi.stubEnv('ASSETLIBRARY_PUBLIC_URL', 'https://catalog.example');
  vi.stubEnv('ASSETLIBRARY_API_URL', 'https://api.example');
  const fetchMock = vi.fn().mockImplementation(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('canonical public discovery', () => {
  it('uses only a validated configured origin and fails closed if absent or malformed', () => {
    for (const raw of ['', 'https://u:p@catalog.example', 'https://catalog.example/path',
      'https://catalog.example?secret=value', 'https://catalog.example#fragment',
      'javascript:alert(1)', 'https://catalog.example\n', ' https://catalog.example']) {
      vi.stubEnv('ASSETLIBRARY_PUBLIC_URL', raw);
      expect(publicOrigin()).toBeUndefined();
      expect(packageStructuredData(published)).toBeUndefined();
      expect(robots().sitemap).toBeUndefined();
    }
    vi.stubEnv('ASSETLIBRARY_PUBLIC_URL', 'https://CATALOG.example:443/');
    expect(publicOrigin()).toBe('https://catalog.example');
  });

  it('emits escaped package-level facts without unknown fields, releases or invented claims', () => {
    setup(null);
    const serialized = packageStructuredData({ ...published, bearer: 'must-not-leak' } as PublishedPackage)!;
    expect(serialized).not.toContain('<');
    expect(serialized).not.toContain('must-not-leak');
    const parsed = JSON.parse(serialized);
    expect(parsed.description).toBe(published.summary);
    expect(parsed.url).toBe('https://catalog.example/packages/safe-art');
    expect(parsed['@type']).toBe('CreativeWork');
    expect(parsed.publisher).toEqual({ '@id': 'https://catalog.example/publishers/safe-publisher', name: 'Publisher' });
    for (const key of ['offers', 'aggregateRating', 'softwareVersion', 'downloadUrl', 'principal', 'id']) {
      expect(parsed).not.toHaveProperty(key);
    }
    for (const status of ['suspended', 'archived'] as const) {
      expect(packageStructuredData({ ...published, status })).toBeUndefined();
    }
    expect(packageStructuredData({ ...published, slug: '../operator' })).toBeUndefined();
    expect(packageStructuredData({ ...published, name: 'x'.repeat(161) })).toBeUndefined();
  });

  it('keeps public publishers crawlable while disallowing exact private roots and children', () => {
    setup(null);
    expect(robots()).toMatchObject({ sitemap: 'https://catalog.example/sitemap.xml', rules: [{
      allow: ['/', '/packages/', '/publishers/'],
      disallow: ['/publisher$', '/publisher?', '/publisher/', '/operator$', '/operator?', '/operator/', '/v1/'],
    }] });
    const rules = robots().rules;
    if (!Array.isArray(rules)) throw new Error('Expected robots groups');
    const text = rules.flatMap((group) => [
      `User-agent: ${group.userAgent}`,
      ...[group.allow ?? []].flat().map((path) => `Allow: ${path}`),
      ...[group.disallow ?? []].flat().map((path) => `Disallow: ${path}`),
    ]).join('\n');
    const matcher = robotsParser('https://catalog.example/robots.txt', text);
    for (const path of ['/publisher', '/publisher?publisher=p', '/publisher/signing-keys',
      '/operator', '/operator?cursor=c', '/operator/moderation', '/v1/public/packages']) {
      expect(matcher.isAllowed(`https://catalog.example${path}`, 'Googlebot'), path).toBe(false);
    }
    for (const path of ['/', '/packages/safe-art', '/publishers/safe-publisher', '/publishers/safe-publisher?cursor=c']) {
      expect(matcher.isAllowed(`https://catalog.example${path}`, 'Googlebot'), path).toBe(true);
    }
  });
});

describe('bounded runtime sitemap', () => {
  it('returns an index and leaf with root-level canonical URLs and no request credentials', async () => {
    const fetchMock = setup({ schema_version: '1.0', shards: ['00', 'ff'] });
    const response = await sitemapResponse('');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<sitemapindex');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].href).toBe('https://api.example/v1/public/sitemap');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
    fetchMock.mockImplementation(async () => Response.json({ schema_version: '1.0', shard: '00', slugs: ['safe-art', 'other-art'] }));
    const leaf = await sitemapResponse('?shard=00');
    expect(await leaf.text()).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://catalog.example/packages/safe-art</loc></url><url><loc>https://catalog.example/packages/other-art</loc></url></urlset>\n');
  });

  it('rejects corrupt, oversized, repeated, and cross-shard projections without partial XML', async () => {
    const malformed = [
      { schema_version: '1.0', shards: ['00', '00'] },
      { schema_version: '1.0', shards: ['ff', '00'] },
      { schema_version: '1.0', shards: ['GG'] },
      { schema_version: '1.0', shards: [], principal: 'hidden' },
      { schema_version: '2.0', shards: [] },
      { schema_version: '1.0', shards: Array(257).fill('00') },
    ];
    for (const value of malformed) {
      setup(value);
      const response = await sitemapResponse('');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('sitemapindex');
    }
    for (const value of [
      { schema_version: '1.0', shard: '01', slugs: ['safe-art'] },
      { schema_version: '1.0', shard: '00', slugs: ['safe-art', 'safe-art'] },
      { schema_version: '1.0', shard: '00', slugs: ['../publisher/private'] },
      { schema_version: '1.0', shard: '00', slugs: Array.from({ length: 5001 }, (_, i) => `package-${i}`) },
    ]) {
      setup(value);
      expect((await sitemapResponse('?shard=00')).status).toBe(503);
    }
  });

  it('bounds response bytes and cancels the stream on overflow', async () => {
    setup(null);
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel,
    }))));
    await expect(sitemapShards()).rejects.toThrow('limit');
    expect(cancel).toHaveBeenCalled();
  });

  it('distinguishes an empty catalog/removed shard from dependency failure and never caches old values', async () => {
    const fetchMock = setup({ schema_version: '1.0', shards: [] });
    const empty = await sitemapResponse('');
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('/sitemap.xml?shard=home');
    fetchMock.mockImplementation(async () => Response.json({ schema_version: '1.0', shard: '00', slugs: [] }));
    expect((await sitemapResponse('?shard=00')).status).toBe(404);
    fetchMock.mockImplementation(async () => new Response('private upstream body', { status: 503 }));
    const failed = await sitemapResponse('');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private upstream body');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects historical/invalid/cursor routes before making an upstream call', async () => {
    const fetchMock = setup(null);
    for (const query of ['?shard=0', '?shard=FF', '?shard=000', '?secret=x', '?shard=00&shard=01', '?shard=home&cursor=x']) {
      expect((await sitemapResponse(query)).status).toBe(404);
    }
    expect((await sitemapResponse('?cursor=' + 'a'.repeat(10_000))).status).toBe(404);
    await expect(sitemapSlugs('0'.repeat(1000))).rejects.toThrow('Invalid sitemap shard');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes XML and enforces protocol entry/URL bounds', async () => {
    expect(await sitemapXml(['https://catalog.example/?a=1&b=<"\'>']).text()).toContain('&amp;b=&lt;&quot;&apos;&gt;');
    expect(sitemapXml(Array(50_001).fill('https://catalog.example/')).status).toBe(503);
    expect(sitemapXml(['https://catalog.example/' + 'a'.repeat(2048)]).status).toBe(503);
  });
});
