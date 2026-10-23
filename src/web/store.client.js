import {
  api,
  connected,
  logoutSession,
  readSession,
  setCredential,
  setSession,
  stopRequests,
} from "./api.client.js";
import { savePackage } from "./download.client.js";
import { createDownloadTransfer } from "./resume-download.client.js";

const element = (id) => document.getElementById(`store-${id}`);
const kinds = {
  art: "Art 素材",
  capability: "Capability 能力",
  mcp: "MCP 工具",
  application: "应用程序",
};
let scope = "public";
let cursor = null;
let selected = null;
let job = null;
let initialization = 0;
let filters = { q: "", kind: "" };
const transfer = createDownloadTransfer((pending) => {
  element("download-status").textContent = pending
    ? `${pending.offset} / ${pending.total} bytes${pending.resumable ? "；可手动继续。" : "；正在下载并校验。"}`
    : "没有未完成下载。";
  controls();
});
function text(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}
function status(message, tone = "info") {
  element("status").textContent = message;
  element("status").dataset.tone = tone;
}
function controls() {
  const pending = transfer.snapshot();
  for (const control of document.querySelectorAll(".store button,.store input,.store select"))
    control.disabled = !!job;
  element("more").disabled = !!job || !cursor;
  element("library").disabled = !!job || !connected();
  element("download").disabled = !!job || !connected() || !selected;
  element("login-hint").hidden = connected();
  element("resume").disabled = !!job || !connected() || !pending?.resumable;
  element("discard").disabled = !!job || !pending;
  element("stop").disabled = !job && !pending;
  element("results").setAttribute("aria-busy", String(!!job));
}
async function run(task) {
  if (job) return;
  const controller = new AbortController();
  job = controller;
  controls();
  try {
    await task(controller.signal);
    controller.signal.throwIfAborted();
  } catch (error) {
    if (error.identityRejected) {
      setCredential("");
      selected = null;
      transfer.clear();
      element("results").replaceChildren();
      element("detail").hidden = true;
      element("session").textContent = "登录已失效，请重新登录";
      element("login").hidden = false;
      element("logout").hidden = true;
      cursor = null;
    }
    status(
      error.name === "AbortError"
        ? "请求已停止或超时；不会自动重试。"
        : `操作失败：${error.message}`,
      "error",
    );
  } finally {
    job = null;
    controls();
  }
}
function render(items) {
  element("results").replaceChildren();
  for (const item of items) {
    const card = text("article", "", "asset-card");
    card.append(text("span", kinds[item.kind] ?? item.kind, "asset-type"));
    card.append(text("h3", item.title));
    card.append(
      text("p", `版本 ${item.label} · ${(item.size / 1024 / 1024).toFixed(2)} MiB`, "muted"),
    );
    card.append(
      text(
        "p",
        item.scanStatus === "not_scanned" ? "未进行恶意代码扫描" : "下载前仍须校验当前资格",
        "asset-warning",
      ),
    );
    const button = text("button", "查看资产");
    button.type = "button";
    button.addEventListener("click", () => run((signal) => detail(item.id, signal)));
    card.append(button);
    element("results").append(card);
  }
}
async function load(signal, after = "") {
  cursor = null;
  selected = null;
  element("detail").hidden = true;
  element("results").replaceChildren();
  status("正在读取当前目录…");
  const params = new URLSearchParams({ limit: "20" });
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (after) params.set("after", after);
  const page = await api(`${scope === "public" ? "/v1/catalog" : "/v1/me/library"}?${params}`, {
    signal,
    publicRead: scope === "public",
  });
  cursor = page.nextAfter;
  render(page.items);
  status(
    page.items.length
      ? `本页 ${page.items.length} 项资产`
      : cursor
        ? "本页候选已失效，请继续下一页。"
        : "没有匹配的资产。可调整筛选或稍后刷新。",
  );
}
async function detail(id, signal) {
  selected = null;
  element("detail").hidden = true;
  const item = await api(`/v1/catalog/${id}`, { signal, publicRead: true });
  selected = item;
  element("detail-title").textContent = item.title;
  element("facts").replaceChildren();
  for (const [label, value] of [
    ["资源类型", kinds[item.kind] ?? item.kind],
    ["版本", item.label],
    ["包体大小", `${item.size} bytes`],
    [
      "内容检查",
      item.scanStatus === "not_scanned" ? "未进行恶意代码扫描" : "已记录检查；不保证绝对安全",
    ],
    ["SHA-256", item.sha256],
    ["发布 ID", item.id],
  ])
    element("facts").append(text("dt", label), text("dd", value));
  element("detail").hidden = false;
  element("detail").focus({ preventScroll: true });
  element("detail").scrollIntoView({ block: "nearest" });
  status("已读取当前公开详情。下载仍需独立授权。");
}
function click(id, task) {
  element(id).addEventListener("click", () => run(task));
}
element("search").addEventListener("submit", (event) => {
  event.preventDefault();
  if (job) return;
  filters = { q: element("query").value.trim(), kind: element("kind").value };
  run((signal) => load(signal));
});
for (const name of ["public", "library"])
  click(name, async (signal) => {
    scope = name;
    for (const tab of ["public", "library"])
      element(tab).setAttribute("aria-pressed", String(tab === scope));
    element("heading").textContent = scope === "public" ? "发现资产" : "我的下载资源库";
    await load(signal);
  });
click("refresh", (signal) => load(signal));
click("more", (signal) => load(signal, cursor));
async function download(signal, resume = false) {
  const result = await transfer.fetch(resume ? null : selected, signal, resume);
  signal.throwIfAborted();
  savePackage(result.blob, result.versionId);
  status("长度与 SHA-256 已校验，已交给浏览器保存。", "success");
}
click("download", (signal) => download(signal));
click("resume", (signal) => download(signal, true));
click("discard", () => transfer.clear());
click("logout", async () => {
  const url = await logoutSession();
  window.location.assign(url);
});
element("stop").addEventListener("click", () => {
  initialization += 1;
  job?.abort();
  stopRequests();
});
window.addEventListener("pagehide", () => {
  initialization += 1;
  job?.abort();
  stopRequests();
});

// 目录与 session 各读取一次；登录状态不可阻止匿名目录查询，也不启动后台轮询。
export const ready = (async () => {
  const current = initialization;
  const [session] = await Promise.all([
    readSession().catch(() => null),
    run((signal) => load(signal)),
  ]);
  if (current !== initialization) return;
  if (!session) element("session").textContent = "登录状态暂不可用；仍可浏览公开目录";
  else {
    element("session").textContent = session.principal
      ? `已登录 · ${session.principal}`
      : "访客浏览";
    element("login").hidden = !session.enabled || !!session.principal;
    element("logout").hidden = !session.principal;
    if (session.principal) setSession(session.csrf);
  }
  if (new URL(window.location.href).searchParams.get("auth") === "failed")
    status("登录未完成，请重试。", "error");
  controls();
})();
