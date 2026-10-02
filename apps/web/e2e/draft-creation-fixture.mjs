// Synthetic, in-memory creation endpoints; no external account or object storage.
export function draftCreationFixture({ packageTemplate, currentPackage, releaseTemplate, workspaceTemplate, send, jsonBody }) {
  const publisherId = packageTemplate.publisher_id;
  const packagePath = `/v1/me/publishers/${publisherId}/packages`;
  const releasePath = `/v1/me/packages/${packageTemplate.id}/releases`;
  const packageId = '99999999-9999-4999-8999-999999999991';
  const releaseId = '99999999-9999-4999-8999-999999999992';
  let attempts = [];
  let createdPackage = null;
  let createdRelease = null;
  let conflict = false;
  let held = false;
  let resume;
  const receipts = new Map();
  const state = () => ({ create_requests: attempts.length, attempts,
    packages: createdPackage ? [createdPackage] : [], releases: createdRelease ? [createdRelease] : [], pending: !!resume });

  async function control(request, response, url) {
    if (url.pathname === '/fixture/draft-creation-state' && request.method === 'GET') {
      send(response, 200, state());
      return true;
    }
    if (url.pathname === '/fixture/reset-draft-creation-state' && request.method === 'POST') {
      resume?.(false);
      resume = undefined;
      attempts = [];
      createdPackage = createdRelease = null;
      conflict = held = false;
      receipts.clear();
      send(response, 200, { reset: true });
      return true;
    }
    if (url.pathname === '/fixture/draft-creation-control' && request.method === 'POST') {
      const body = await jsonBody(request);
      conflict = body.conflict === true;
      held = body.hold === true;
      if (!held) { resume?.(true); resume = undefined; }
      send(response, 200, { configured: true });
      return true;
    }
    return false;
  }

  async function api(request, response, url) {
    if (request.method === 'POST' && [packagePath, releasePath].includes(url.pathname)) {
      const key = request.headers['idempotency-key'];
      const body = await jsonBody(request);
      attempts.push({ path: url.pathname, idempotency_key: key, body });
      if (resume) {
        send(response, 409, { error: 'conflict' });
        return true;
      }
      if (held && !await new Promise(resolve => { resume = resolve; })) {
        send(response, 409, { error: 'conflict' });
        return true;
      }
      if (conflict || typeof key !== 'string' || key.length < 8) {
        send(response, 409, { error: 'conflict' });
        return true;
      }
      const receiptKey = `${url.pathname}:${key}`;
      const previous = receipts.get(receiptKey);
      if (previous) {
        const matches = previous.body === JSON.stringify(body);
        send(response, matches ? 200 : 409, matches ? previous.value : { error: 'conflict' });
        return true;
      }
      if (url.pathname === packagePath ? createdPackage : createdRelease) {
        send(response, 409, { error: 'conflict' });
        return true;
      }
      const value = url.pathname === packagePath
        ? { ...packageTemplate, ...body, id: packageId, publisher_id: publisherId, status: 'draft' }
        : { ...releaseTemplate, ...body, id: releaseId, package_id: packageTemplate.id, status: 'draft' };
      if (url.pathname === packagePath) createdPackage = value;
      else createdRelease = value;
      receipts.set(receiptKey, { body: JSON.stringify(body), value });
      send(response, 200, value);
      return true;
    }
    if (request.method !== 'GET') return false;
    if (url.pathname === packagePath) {
      const summaries = [currentPackage(), ...(createdPackage ? [createdPackage] : [])]
        .map(({ description: _description, ...summary }) => summary);
      send(response, 200, { schema_version: '1.0', items: summaries, next_cursor: null });
    } else if (createdPackage && url.pathname === `/v1/me/packages/${packageId}`) {
      send(response, 200, createdPackage);
    } else if (createdPackage && url.pathname === `/v1/me/packages/${packageId}/releases`) {
      send(response, 200, { schema_version: '1.0', items: [], next_cursor: null });
    } else if (url.pathname === releasePath) {
      send(response, 200, { schema_version: '1.0',
        items: [releaseTemplate, ...(createdRelease ? [createdRelease] : [])], next_cursor: null });
    } else if (createdRelease && url.pathname === `/v1/me/releases/${releaseId}`) {
      send(response, 200, createdRelease);
    } else if (createdRelease && url.pathname === `/v1/me/releases/${releaseId}/workspace`) {
      send(response, 200, { ...workspaceTemplate, release_id: releaseId, artifacts: [],
        submission: null, feedback: [], can_upload: true });
    } else return false;
    return true;
  }
  return { control, api };
}
