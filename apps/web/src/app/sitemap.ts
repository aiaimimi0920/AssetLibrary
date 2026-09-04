import type { MetadataRoute } from "next";

function publicOrigin(): string {
  const raw = process.env.ASSETLIBRARY_PUBLIC_URL ?? "http://localhost:3000";
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("AssetLibrary public URL must use HTTP or HTTPS");
  return url.origin;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: publicOrigin(), changeFrequency: "daily", priority: 1 }];
}
