// Loopback-only synthetic HTTP fixture, not a storage or verification adapter.
export function publicDownloadFixture(releases, port, send) {
  const { signing_key_id: _key, ...artifact } = releases.items[0].artifacts[0];
  const path = `/public/sha256/${artifact.digest}/${artifact.file_name}`;
  const url = `http://localhost:${port}${path}`;
  let mode = 'normal';
  const pending = new Set();
  let state;
  const reset = () => { state = { resolve_count: 0, object_count: 0,
    api_credentials_received: false, object_credentials_received: false, referrer_received: false }; };
  reset();
  const release = () => { for (const response of pending) {
    if (!response.destroyed) send(response, 200, { schema_version: '1.0', artifact, download_url: url });
  } pending.clear(); };
  return (request, response, location) => {
    if (request.method === 'POST' && location.pathname === '/fixture/download-mode') {
      const next = location.searchParams.get('mode');
      if (!['normal', 'revoked', 'unavailable', 'mismatch', 'redirect', 'delayed'].includes(next)) {
        send(response, 400, { error: 'invalid mode' });
      } else { release(); mode = next; reset(); send(response, 200, { mode }); }
      return true;
    }
    if (request.method === 'POST' && location.pathname === '/fixture/release-download') {
      release(); send(response, 200, { released: true }); return true;
    }
    if (request.method === 'GET' && location.pathname === '/fixture/download-state') {
      send(response, 200, state); return true;
    }
    if (request.method !== 'GET') return false;
    if (location.pathname === `/v1/public/artifacts/${artifact.artifact_id}/download`) {
      state.resolve_count++;
      state.api_credentials_received ||= Boolean(request.headers.cookie || request.headers.authorization);
      if (mode === 'delayed') {
        pending.add(response); response.on('close', () => pending.delete(response));
      } else if (mode === 'revoked' || mode === 'unavailable') {
        send(response, mode === 'revoked' ? 404 : 503, { error: 'not available' });
      } else {
        send(response, 200, { schema_version: '1.0',
          artifact: mode === 'mismatch' ? { ...artifact, size_bytes: 1 } : artifact,
          download_url: mode === 'redirect' ? `${url}?token=must-not-escape` : url });
      }
      return true;
    }
    if (location.pathname === path) {
      state.object_count++;
      state.object_credentials_received ||= Boolean(request.headers.cookie || request.headers.authorization);
      state.referrer_received ||= Boolean(request.headers.referer);
      if (mode === 'revoked') send(response, 404, { error: 'not available' });
      else {
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': artifact.size_bytes,
          'content-disposition': `attachment; filename="${artifact.file_name}"`, 'cache-control': 'no-store' });
        response.end(Buffer.alloc(artifact.size_bytes, 42));
      }
      return true;
    }
    return false;
  };
}
