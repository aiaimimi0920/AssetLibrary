// Synthetic public projection only; never an identity or storage adapter.
export function publicDiscoveryFixture(packages, releases, send) {
  let mode = 'normal';
  const item = packages.items[0];
  const shard = item.id.slice(0, 2);
  return (request, response, url) => {
    if (request.method === 'POST' && url.pathname === '/fixture/discovery-mode') {
      const next = url.searchParams.get('mode');
      if (!['normal', 'removed', 'unavailable', 'injection'].includes(next)) {
        send(response, 400, { error: 'invalid mode' });
      } else {
        mode = next;
        send(response, 200, { mode });
      }
      return true;
    }
    if (request.method !== 'GET') return false;
    const isIndex = url.pathname === '/v1/public/sitemap';
    const leaf = /^\/v1\/public\/sitemap\/([0-9a-f]{2})$/.exec(url.pathname)?.[1];
    const isPackage = url.pathname === `/v1/public/packages/${item.slug}`;
    const isReleases = url.pathname === `/v1/public/packages/${item.slug}/releases`;
    const isPublisher = url.pathname === `/v1/public/publishers/${item.publisher.slug}`;
    if (!isIndex && !leaf && !isPackage && !isReleases && !isPublisher) return false;
    if (mode === 'unavailable') { send(response, 503, { error: 'unavailable' }); return true; }
    if (isIndex) send(response, 200, { schema_version: '1.0', shards: mode === 'removed' ? [] : [shard] });
    else if (leaf) send(response, 200, { schema_version: '1.0', shard: leaf, slugs: mode === 'removed' || leaf !== shard ? [] : [item.slug] });
    else if (mode === 'removed') send(response, 404, { error: 'not found' });
    else if (isPackage) send(response, 200, { ...item, ...(mode === 'injection'
      ? { summary: '</script><script>globalThis.discoveryInjected = true</script>' } : {}) });
    else if (isReleases) send(response, 200, releases);
    else send(response, 200, { schema_version: '1.0', publisher: item.publisher });
    return true;
  };
}
