import type { PublishedReleaseArtifact } from './public-details';

export type DownloadSelection = Omit<PublishedReleaseArtifact, 'signing_key_id'>;
const keys = ['artifact_id', 'release_id', 'digest', 'size_bytes', 'media_type', 'file_name'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown, fields: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

export function parseDownloadSelection(value: unknown): DownloadSelection {
  if (!record(value, keys)
    || typeof value.artifact_id !== 'string' || !uuid.test(value.artifact_id)
    || typeof value.release_id !== 'string' || !uuid.test(value.release_id)
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.size_bytes !== 'number' || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1
    || typeof value.media_type !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(value.media_type)
    || typeof value.file_name !== 'string' || !/^[A-Za-z0-9._-]{1,180}$/.test(value.file_name)
    || value.file_name === '.' || value.file_name === '..') throw new Error('Invalid download selection');
  return value as unknown as DownloadSelection;
}

export function selectDownloadArtifact(artifact: PublishedReleaseArtifact): DownloadSelection {
  return { artifact_id: artifact.artifact_id, release_id: artifact.release_id, digest: artifact.digest,
    size_bytes: artifact.size_bytes, media_type: artifact.media_type, file_name: artifact.file_name };
}

export function downloadOrigin(configured: string | undefined): string | undefined {
  if (!configured || configured.length > 300 || /[\u0000-\u0020\u007f?#\\]/.test(configured)) return undefined;
  try {
    const url = new URL(configured);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch { return undefined; }
}

export function parsePublicDownload(value: unknown, expected: DownloadSelection, origin: string): string {
  if (!record(value, ['schema_version', 'artifact', 'download_url']) || value.schema_version !== '1.0') {
    throw new Error('Invalid public download contract');
  }
  const artifact = parseDownloadSelection(value.artifact);
  if (keys.some((key) => artifact[key as keyof DownloadSelection] !== expected[key as keyof DownloadSelection])) {
    throw new Error('Public download identity changed');
  }
  const destination = `${origin}/public/sha256/${artifact.digest}/${artifact.file_name}`;
  // Exact comparison excludes redirects, alternate encodings, queries and bearer URLs.
  if (value.download_url !== destination) throw new Error('Invalid public download destination');
  return destination;
}
