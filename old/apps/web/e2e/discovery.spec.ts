import { expect, test } from './browser-contract';
import robotsParser from 'robots-parser';

const fixture = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? '18900')}`;

test.afterEach(async ({ request }) => {
  expect((await request.post(`${fixture}/fixture/discovery-mode?mode=normal`)).ok()).toBe(true);
});

test('runtime sitemap traverses only published package URLs and refreshes without stale success', async ({ request }) => {
  await request.post(`${fixture}/fixture/discovery-mode?mode=normal`);
  const index = await request.get('/sitemap.xml', { headers: { 'x-forwarded-host': 'attacker.invalid' } });
  expect(index.status()).toBe(200);
  expect(index.headers()['content-type']).toContain('application/xml');
  expect(index.headers()['cache-control']).toContain('no-store');
  const xml = await index.text();
  expect(xml).toContain('<sitemapindex');
  expect(xml).not.toContain('attacker.invalid');
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  expect(locations).toHaveLength(2);
  expect(new Set(locations).size).toBe(locations.length);
  for (const location of locations) {
    const leaf = await request.get(location);
    expect(leaf.status()).toBe(200);
    expect(await leaf.text()).toContain('<urlset');
    expect(await leaf.text()).not.toMatch(/browser-private|bearer|\/publisher\//);
  }
  const packageLeaf = locations.find((location) => location.endsWith('shard=01'))!;
  expect(await (await request.get(packageLeaf)).text()).toContain('/packages/neuro-starter-art');
  await request.post(`${fixture}/fixture/discovery-mode?mode=removed`);
  expect((await request.get(packageLeaf)).status()).toBe(404);
  expect(await (await request.get('/sitemap.xml')).text()).not.toContain('shard=01');
  await request.post(`${fixture}/fixture/discovery-mode?mode=unavailable`);
  const unavailable = await request.get('/sitemap.xml');
  expect(unavailable.status()).toBe(503);
  expect(await unavailable.text()).not.toContain('<sitemapindex');
  expect((await request.get('/sitemap.xml?cursor=untrusted')).status()).toBe(404);
});

test('package structured data matches canonical SSR facts, including historical release pages', async ({ page, request }) => {
  await request.post(`${fixture}/fixture/discovery-mode?mode=injection`);
  await page.goto('/packages/neuro-starter-art');
  await expect(page.getByRole('heading', { level: 1, name: 'Neuro Starter Art' })).toBeVisible();
  const schema = page.locator('script[type="application/ld+json"]');
  await expect(schema).toHaveCount(1);
  const encoded = await schema.textContent();
  expect(encoded).not.toContain('<');
  const parsed = JSON.parse(encoded!);
  expect(parsed['@type']).toBe('CreativeWork');
  expect(parsed.description).toContain('</script>');
  expect(parsed.url).toBe(new URL('/packages/neuro-starter-art', page.url()).href);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', parsed.url);
  expect(await page.evaluate(() => Object.hasOwn(globalThis, 'discoveryInjected'))).toBe(false);
  await page.goto('/packages/neuro-starter-art?cursor=historical');
  await expect(schema).toHaveCount(1);
  expect(JSON.parse((await schema.textContent())!)).toEqual(parsed);
  expect(parsed).not.toHaveProperty('softwareVersion');
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /publisher$');
  expect(robots).toContain('Disallow: /publisher/');
  expect(robots).toContain('Allow: /publishers/');
  expect(robots).toContain('Sitemap: http://127.0.0.1:');
  const matcher = robotsParser(new URL('/robots.txt', page.url()).href, robots);
  for (const path of ['/publisher', '/publisher?publisher=fixture', '/publisher/packages',
    '/operator', '/operator?cursor=fixture', '/operator/submissions', '/v1/public/packages']) {
    expect(matcher.isAllowed(new URL(path, page.url()).href, 'Googlebot'), path).toBe(false);
  }
  for (const path of ['/', '/packages/neuro-starter-art', '/publishers/neuro-fixture-publisher',
    '/publishers/neuro-fixture-publisher?cursor=fixture']) {
    expect(matcher.isAllowed(new URL(path, page.url()).href, 'Googlebot'), path).toBe(true);
  }
  await request.post(`${fixture}/fixture/discovery-mode?mode=removed`);
  await page.goto('/packages/neuro-starter-art');
  await expect(page.getByRole('heading', { level: 1, name: '没有这个已发布包' })).toBeVisible();
  await expect(schema).toHaveCount(0);
  const directives = await page.locator('meta[name="robots"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('content')));
  expect(directives.some((value) => value?.includes('noindex'))).toBe(true);
});
