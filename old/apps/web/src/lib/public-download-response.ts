import 'server-only';
import { publicApiEndpoint } from './public-api';
import { publicOrigin } from './public-origin';
import { downloadOrigin, parseDownloadSelection, parsePublicDownload } from './public-download-contract';

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers });

async function boundedJson(source: Request | Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    await source.body?.cancel().catch(() => undefined);
    throw new Error('Download request cancelled');
  }
  const reader = source.body?.getReader();
  if (!reader) throw new Error('Missing download response');
  let rejectAbort: (reason: Error) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => rejectAbort(new Error('Download request cancelled'));
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error('Download response exceeds limit');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function preparePublicDownload(request: Request): Promise<Response> {
  const configuredOrigin = publicOrigin();
  if (!configuredOrigin || request.headers.get('origin') !== configuredOrigin) return failure(403, 'origin');
  if (new URL(request.url).search || request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    return failure(400, 'invalid_request');
  }
  const origin = downloadOrigin(process.env.ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL);
  if (!origin) return failure(503, 'not_configured');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
  let selection;
  try { selection = parseDownloadSelection(await boundedJson(request, 2048, signal)); }
  catch { return failure(400, 'invalid_request'); }
  try {
    const url = publicApiEndpoint(`/v1/public/artifacts/${selection.artifact_id}/download`);
    if (url.username || url.password) return failure(503, 'not_configured');
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { accept: 'application/json' }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(response.status === 404 ? 404 : 503, response.status === 404 ? 'not_available' : 'unavailable');
    }
    const destination = parsePublicDownload(await boundedJson(response, 8192, signal), selection, origin);
    return Response.json({ download_url: destination }, { headers });
  } catch { return failure(503, 'unavailable'); }
}
