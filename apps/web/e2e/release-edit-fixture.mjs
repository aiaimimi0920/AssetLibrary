// One synthetic principal/target; not a replacement for PostgreSQL concurrency tests.
export function releaseEditFixture(template, { send, jsonBody }) {
  let release = structuredClone(template);
  let attempts = [];
  let writes = 0;
  let revision = 0;
  const receipts = new Map();
  const path = `/v1/me/releases/${template.id}`;
  // Fixtures use canonical millisecond UTC timestamps, not every RFC3339 precision.
  const nextRevision = () => new Date(Date.parse(template.updated_at) + ++revision).toISOString();
  const current = () => structuredClone(release);

  function normalized(body) {
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const line = value => typeof value === 'string' && value.length > 0 && value.length <= 160
      && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
    if (!exact(body, ['expected_updated_at', 'compatibility', 'permissions'])
      || typeof body.expected_updated_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body.expected_updated_at)
      || !Number.isFinite(Date.parse(body.expected_updated_at))
      || !exact(body.compatibility, ['products']) || !Array.isArray(body.compatibility.products)
      || body.compatibility.products.length > 2
      || body.compatibility.products.some(product => !exact(product, ['name', 'version_requirement'])
        || !['loom', 'hook'].includes(product.name) || !line(product.version_requirement) || product.version_requirement.length > 100)
      || new Set(body.compatibility.products.map(product => product.name)).size !== body.compatibility.products.length
      || !Array.isArray(body.permissions) || body.permissions.length > 64
      || body.permissions.some(permission => !line(permission))
      || new Set(body.permissions).size !== body.permissions.length) return null;
    return { expected_updated_at: body.expected_updated_at,
      compatibility: { products: body.compatibility.products.map(product => ({ name: product.name,
        version_requirement: product.version_requirement })) }, permissions: [...body.permissions] };
  }

  async function control(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/fixture/release-edit-state') {
      send(response, 200, { release: current(), attempts, patch_requests: attempts.length, writes });
    } else if (request.method === 'POST' && url.pathname === '/fixture/reset-release-edit') {
      release = structuredClone(template);
      attempts = [];
      writes = revision = 0;
      receipts.clear();
      send(response, 200, { reset: true });
    } else if (request.method === 'POST' && url.pathname === '/fixture/concurrent-release-edit') {
      release = { ...release, permissions: ['concurrent.permission'],
        compatibility: { products: [{ name: 'loom', version_requirement: '>=0.4.0' }] }, updated_at: nextRevision() };
      writes++;
      send(response, 200, current());
    } else return false;
    return true;
  }

  async function api(request, response, url) {
    if (url.pathname !== path) return false;
    if (request.method === 'GET') { send(response, 200, current()); return true; }
    if (request.method !== 'PATCH') return false;
    const raw = await jsonBody(request);
    const key = request.headers['idempotency-key'];
    attempts.push({ path, idempotency_key: key, body: raw });
    const body = normalized(raw);
    if (!body || typeof key !== 'string' || key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
      send(response, 400, { error: 'invalid_request' });
      return true;
    }
    const receiptKey = `synthetic-principal:publisher.release.update:${template.id}:${key}`;
    const digest = JSON.stringify(body);
    const previous = receipts.get(receiptKey);
    // This handler runs after bearer authorization; replay precedes stale-revision checks.
    if (previous) {
      send(response, previous.digest === digest ? 200 : 409,
        previous.digest === digest ? structuredClone(previous.value) : { error: 'conflict' });
      return true;
    }
    if (release.status !== 'draft' || Date.parse(body.expected_updated_at) !== Date.parse(release.updated_at)) {
      send(response, 409, { error: 'conflict' });
      return true;
    }
    release = { ...release, compatibility: structuredClone(body.compatibility),
      permissions: [...body.permissions], updated_at: nextRevision() };
    writes++;
    receipts.set(receiptKey, { digest, value: current() });
    send(response, 200, current());
    return true;
  }
  return { current, control, api };
}
