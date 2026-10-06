import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadOrigin, parseDownloadSelection, parsePublicDownload } from './public-download-contract';
import { preparePublicDownload } from './public-download-response';

vi.mock('server-only', () => ({}));
const artifact = { artifact_id: '018f47d2-4a75-7fa1-a12b-9a1f19d46eb1',
  release_id: '018f47d2-4a75-7fa1-a12b-9a1f19d46eb0', digest: '42'.repeat(32),
  size_bytes: 4096, media_type: 'application/zip', file_name: 'neuro-starter-art-1.2.0.zip' };
const origin = 'https://download.example';
const url = `${origin}/public/sha256/${artifact.digest}/${artifact.file_name}`;
const contract = { schema_version: '1.0', artifact, download_url: url };

function request(body: unknown = artifact, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('https://catalog.example/downloads/prepare', { method: 'POST',
    headers: { origin: 'https://catalog.example', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal });
}

beforeEach(() => {
  vi.stubEnv('ASSETLIBRARY_PUBLIC_URL', 'https://catalog.example');
  vi.stubEnv('ASSETLIBRARY_API_URL', 'https://api.example');
  vi.stubEnv('ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL', origin);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('public download contract', () => {
  it('requires an exact valid immutable artifact identity', () => {
    expect(parseDownloadSelection(artifact)).toEqual(artifact);
    expect(parsePublicDownload(contract, artifact, origin)).toBe(url);
    for (const patch of [{ artifact_id: '../private' }, { release_id: '0'.repeat(36) },
      { digest: artifact.digest.toUpperCase().replace('4', 'A') }, { size_bytes: 0 },
      { size_bytes: Number.MAX_SAFE_INTEGER + 1 }, { media_type: 'text/html\n' },
      { file_name: '../hidden.zip' }, { file_name: '..' }, { access_token: 'not-allowed' }]) {
      expect(() => parseDownloadSelection({ ...artifact, ...patch })).toThrow();
    }
    for (const field of Object.keys(artifact)) {
      const changed = { ...artifact, [field]: field === 'size_bytes' ? 8192
        : field === 'digest' ? 'ab'.repeat(32) : field.endsWith('_id')
          ? '11111111-1111-4111-8111-111111111111' : 'different' };
      expect(() => parsePublicDownload({ ...contract, artifact: changed }, artifact, origin)).toThrow();
    }
    expect(() => parsePublicDownload({ ...contract, access_token: 'private' }, artifact, origin)).toThrow();
    expect(() => parsePublicDownload({ ...contract, schema_version: '2.0' }, artifact, origin)).toThrow();
  });

  it('requires configured HTTPS origin, permitting HTTP only for explicit loopback development', () => {
    expect(downloadOrigin(origin)).toBe(origin);
    expect(downloadOrigin('https://DOWNLOAD.example:443/')).toBe(origin);
    expect(downloadOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    for (const invalid of [undefined, '', 'https://u:p@download.example', 'https://download.example/base',
      'https://download.example?q=secret', 'https://download.example#x', 'https://download.example\n',
      'https://download.example\\', 'http://download.example', 'https://' + 'x'.repeat(300)]) {
      expect(downloadOrigin(invalid)).toBeUndefined();
    }
  });

  it('rejects alternate hosts, private paths, encoded paths, redirects and token URLs', () => {
    for (const bad of [url + '?token=private', url + '#fragment', url.replace(origin, 'https://evil.example'),
      url.replace('/public/', '/restricted/'), url.replace('/public/', '/%70ublic/'),
      url.replace(origin, 'https://download.example.evil.example'), url.replace('https://', 'https://user@'),
      'javascript:alert(1)', '//' + url.slice(8)]) {
      expect(() => parsePublicDownload({ ...contract, download_url: bad }, artifact, origin)).toThrow();
    }
  });
});

describe('public download preparation', () => {
  it('freshly resolves public metadata without forwarding browser credentials or fetching bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(contract));
    vi.stubGlobal('fetch', fetchMock);
    const response = await preparePublicDownload(request(artifact, { cookie: 'private-cookie', authorization: 'Bearer private' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ download_url: url });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].href).toBe(`https://api.example/v1/public/artifacts/${artifact.artifact_id}/download`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { accept: 'application/json' } });
    expect(Object.keys(fetchMock.mock.calls[0][1].headers)).toEqual(['accept']);
  });

  it('rejects hostile origin, malformed input and missing destination configuration before fetching', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const req of [request(artifact, { origin: 'https://evil.example' }),
      request(artifact, { origin: '' }), request(artifact, { 'content-type': 'text/plain' }),
      request({ ...artifact, size_bytes: -1 }), request({ padding: 'x'.repeat(3000) })]) {
      expect((await preparePublicDownload(req)).status).toBeGreaterThanOrEqual(400);
    }
    vi.stubEnv('ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL', '');
    expect((await preparePublicDownload(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects revoked/private/non-Art or unavailable artifacts and never returns a stale link', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(contract))
      .mockResolvedValueOnce(new Response('private body', { status: 404 }))
      .mockResolvedValueOnce(new Response('private body', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await preparePublicDownload(request())).status).toBe(200);
    for (const status of [404, 503]) {
      const response = await preparePublicDownload(request());
      expect(response.status).toBe(status);
      expect(await response.text()).not.toMatch(/download_url|private body/);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed on changed identity, invalid JSON, oversized data and redirect/network errors', async () => {
    for (const response of [Response.json({ ...contract, artifact: { ...artifact, size_bytes: 12 } }),
      Response.json({ ...contract, download_url: url + '?token=private' }), new Response('<html>bad</html>'),
      new Response('x'.repeat(8193)), new Response(new Uint8Array([0xff]))]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const result = await preparePublicDownload(request());
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: 'unavailable' });
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('untrusted redirect target')));
    expect((await preparePublicDownload(request())).status).toBe(503);
  });

  it('propagates cancellation and cancels a stalled upstream body', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      queueMicrotask(() => controller.abort());
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(body);
    }));
    const response = await preparePublicDownload(request(artifact, {}, controller.signal));
    expect(response.status).toBe(503);
    expect(cancelled).toBe(true);
  });
});
