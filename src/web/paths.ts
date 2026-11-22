/** 20 个公开静态前端入口白名单，供路由与流量护栏共用而不引入静态文本模块加载器。 */
export const WEB_ASSET_PATHS = new Set([
  "/",
  "/workspace",
  "/store.client.js",
  "/store.css",
  "/store-shell.css",
  "/asset-market.css",
  "/store-view.client.js",
  "/asset-market.client.js",
  "/beaver.svg",
  "/app.client.js",
  "/api.client.js",
  "/render.client.js",
  "/resource.client.js",
  "/showcase.client.js",
  "/upload.client.js",
  "/distribution.client.js",
  "/distribution-render.client.js",
  "/download.client.js",
  "/resume-download.client.js",
  "/style.css",
]);

export function isWebAssetPath(pathname: string): boolean {
  return WEB_ASSET_PATHS.has(pathname);
}
