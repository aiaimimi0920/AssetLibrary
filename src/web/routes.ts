import api from "./api.client.js";
import app from "./app.client.js";
import assetMarket from "./asset-market.client.js";
import assetMarketStyle from "./asset-market.css";
import beaver from "./beaver.svg";
import distribution from "./distribution.client.js";
import distributionRender from "./distribution-render.client.js";
import download from "./download.client.js";
import page from "./index.html";
import render from "./render.client.js";
import resource from "./resource.client.js";
import resumeDownload from "./resume-download.client.js";
import showcase from "./showcase.client.js";
import store from "./store.client.js";
import storeStyle from "./store.css";
import storePage from "./store.html";
import storeShell from "./store-shell.css";
import storeView from "./store-view.client.js";
import style from "./style.css";
import upload from "./upload.client.js";

const assets: Record<string, [string, string]> = {
  "/": [storePage, "text/html"],
  "/workspace": [page, "text/html"],
  "/store.client.js": [store, "text/javascript"],
  "/store.css": [storeStyle, "text/css"],
  "/store-shell.css": [storeShell, "text/css"],
  "/asset-market.css": [assetMarketStyle, "text/css"],
  "/store-view.client.js": [storeView, "text/javascript"],
  "/asset-market.client.js": [assetMarket, "text/javascript"],
  "/beaver.svg": [beaver, "image/svg+xml"],
  "/app.client.js": [app, "text/javascript"],
  "/api.client.js": [api, "text/javascript"],
  "/render.client.js": [render, "text/javascript"],
  "/resource.client.js": [resource, "text/javascript"],
  "/showcase.client.js": [showcase, "text/javascript"],
  "/upload.client.js": [upload, "text/javascript"],
  "/distribution.client.js": [distribution, "text/javascript"],
  "/distribution-render.client.js": [distributionRender, "text/javascript"],
  "/download.client.js": [download, "text/javascript"],
  "/resume-download.client.js": [resumeDownload, "text/javascript"],
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
      // 原生 POST 表单须保留同源 Origin；跨站不发送 Referer。
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self' https://naccount-auth.aiaimimi.com; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
