import type { PublishedPackage } from './contracts';
import { publicOrigin, validPublicSlug } from './public-origin';

function boundedText(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0)
    && value.length <= maximum * 2 && [...value].length <= maximum;
}

export function discoverablePackage(value: PublishedPackage): boolean {
  return value.status === 'published' && validPublicSlug(value.slug)
    && ['art', 'capability', 'app_update'].includes(value.kind)
    && boundedText(value.name, 160) && boundedText(value.summary, 1000, true)
    && !!value.publisher && validPublicSlug(value.publisher.slug)
    && boundedText(value.publisher.display_name, 160);
}

export function packageStructuredData(value: PublishedPackage): string | undefined {
  const origin = publicOrigin();
  if (!origin || !discoverablePackage(value)) return undefined;
  const url = `${origin}/packages/${value.slug}`;
  // A package is not necessarily a standalone application. Do not invent
  // prices, reviews, download URLs, or a latest release from a cursor page.
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    '@id': `${url}#package`,
    url,
    identifier: value.slug,
    name: value.name,
    description: value.summary,
    publisher: {
      '@id': `${origin}/publishers/${value.publisher.slug}`,
      name: value.publisher.display_name,
    },
  };
  return JSON.stringify(data).replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
