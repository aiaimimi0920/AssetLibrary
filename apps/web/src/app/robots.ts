import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/packages/"], disallow: ["/publisher", "/operator", "/v1/"] },
    ],
    sitemap: "/sitemap.xml",
  };
}
