import api from "./api.client.js";
import app from "./app.client.js";
import distribution from "./distribution.client.js";
import distributionRender from "./distribution-render.client.js";
import download from "./download.client.js";
import page from "./index.html";
import render from "./render.client.js";
import style from "./style.css";
import upload from "./upload.client.js";

const assets: Record<string, [string, string]> = {
  "/": [page, "text/html"],
  "/app.client.js": [app, "text/javascript"],
  "/api.client.js": [api, "text/javascript"],
  "/render.client.js": [render, "text/javascript"],
  "/upload.client.js": [upload, "text/javascript"],
  "/distribution.client.js": [distribution, "text/javascript"],
  "/distribution-render.client.js": [distributionRender, "text/javascript"],
  "/download.client.js": [download, "text/javascript"],
  "/style.css": [style, "text/css"],
};

/** 公开的只有固定 UI 字节；业务仍经过同源 Bearer 身份与 D1 授权。 */
export function webRoutes(request: Request): Response | null {
  const asset = assets[new URL(request.url).pathname];
  if (!asset || !["GET", "HEAD"].includes(request.method)) return null;
  return new Response(request.method === "HEAD" ? null : asset[0], {
    headers: {
      "Content-Type": `${asset[1]}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
