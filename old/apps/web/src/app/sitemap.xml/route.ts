import { sitemapResponse } from '@/lib/sitemap-response';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return sitemapResponse(new URL(request.url).search);
}
