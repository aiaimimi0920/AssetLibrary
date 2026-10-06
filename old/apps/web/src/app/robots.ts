import type { MetadataRoute } from "next";
import { publicOrigin } from '@/lib/public-origin';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin();
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/packages/", "/publishers/"], disallow: ["/publisher$", "/publisher?", "/publisher/", "/operator$", "/operator?", "/operator/", "/v1/"] },
    ],
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
