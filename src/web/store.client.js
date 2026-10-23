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
const codes = { art: "ART", capability: "CAP", mcp: "MCP", application: "APP" };
let scope = "public";
let cursor = null;
let selected = null;
let job = null;
let initialization = 0;
let filters = { q: "", kind: "" };
let opener = null;
let loginEnabled = false;
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
  for (const name of ["status", "detail-status"]) {
    element(name).textContent = message;
    element(name).dataset.tone = tone;
  }
}
function context() {
  const searching = !!filters.q || !!filters.kind;
  element("discovery").hidden = scope !== "public" || searching;
  element("context").textContent = scope === "public" ? "PUBLIC CATALOG" : "YOUR LIBRARY";
  element("heading").textContent =
    scope === "library"
      ? "我的下载资源库"
      : filters.q
        ? "搜索结果"
        : (kinds[filters.kind] ?? "全部资产");
  element("filter-summary").textContent = [
    kinds[filters.kind] ?? "全部类型",
    filters.q ? `名称包含「${filters.q}」` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  for (const name of ["all", ...Object.keys(kinds)])
    element(`category-${name}`).setAttribute(
      "aria-pressed",
      String((name === "all" ? "" : name) === filters.kind),
    );
  for (const name of ["public", "library"])
    element(name).setAttribute("aria-pressed", String(name === scope));
}
function cover(kind) {
  const node = text("div", "", "asset-cover");
  node.append(
    text("span", kinds[kind] ?? "资源包"),
    text("strong", codes[kind] ?? "PKG"),
    text("span", "类型图示 · 暂无内容预览"),
  );
  return node;
}
function showDetail(trigger) {
  opener = trigger;
  if (!element("detail").open) element("detail").showModal();
  element("detail-close").focus();
}
function controls() {
  const pending = transfer.snapshot();
  for (const control of document.querySelectorAll(".store button,.store input,.store select"))
    control.disabled = !!job;
  element("more").disabled = !!job || !cursor;
  element("library").disabled = !!job || !connected();
  element("download").disabled = !!job || !connected() || !selected;
  element("login-hint").hidden = connected() || !loginEnabled;
  element("resume").disabled = !!job || !connected() || !pending?.resumable;
  element("discard").disabled = !!job || !pending;
  element("stop").disabled = !job && !pending;
  element("transfer-stop").disabled = !job && !pending;
  element("transfer").hidden = !pending || pending.publication.id !== selected?.id;
  element("transfer-open").hidden = !pending;
  element("transfer-open").disabled = false;
  element("detail-close").disabled = false;
  element("transfer-open").textContent = pending?.resumable ? "下载任务 · 可继续" : "下载任务";
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
      element("detail").close();
      element("empty").hidden = true;
      element("session").textContent = "登录已失效，请重新登录";
      element("login").hidden = false;
      element("logout").hidden = true;
      cursor = null;
      scope = "public";
      context();
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
    const body = text("div", "", "asset-body");
    const title = text("h3", item.title);
    title.title = item.title;
    body.append(text("p", kinds[item.kind] ?? item.kind, "asset-type"), title);
    const meta = text("p", "", "asset-meta");
    const size =
      item.size < 1024
        ? `${item.size} B`
        : item.size < 1024 * 1024
          ? `${(item.size / 1024).toFixed(1)} KiB`
          : `${(item.size / 1024 / 1024).toFixed(2)} MiB`;
    meta.append(text("span", `版本 ${item.label}`), text("span", size));
    body.append(meta);
    const bottom = text("div", "", "asset-bottom");
    bottom.append(
      text(
        "p",
        item.scanStatus === "not_scanned" ? "△ 未扫描" : "资格以下载时校验为准",
        "asset-warning",
      ),
    );
    const button = text("button", "查看详情 ↗", "asset-open");
    button.type = "button";
    button.setAttribute("aria-label", `查看资产：${item.title}`);
    button.addEventListener("click", () => run((signal) => detail(item.id, signal, button)));
    bottom.append(button);
    body.append(bottom);
    card.append(cover(item.kind), body);
    element("results").append(card);
  }
}
async function load(signal, after = "") {
  cursor = null;
  selected = null;
  element("detail").close();
  element("empty").hidden = true;
  element("results").replaceChildren();
  context();
  status("正在读取当前目录…");
  const params = new URLSearchParams({ limit: "20" });
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (after) params.set("after", after);
  const page = await api(`${scope === "public" ? "/v1/catalog" : "/v1/me/library"}?${params}`, {
    signal,
    publicRead: scope === "public",
  });
  signal.throwIfAborted();
  cursor = page.nextAfter;
  render(page.items);
  element("empty").hidden = page.items.length !== 0;
  element("empty-title").textContent = cursor ? "本页没有可用资产" : "没有匹配的资产";
  element("empty-hint").textContent = cursor
    ? "本页候选已失效，仍可手动读取下一页。"
    : "试试其他名称或资源类型，也可稍后手动刷新。";
  status(
    page.items.length
      ? `本页 ${page.items.length} 项资产`
      : cursor
        ? "本页候选已失效，请继续下一页。"
        : "没有匹配的资产。可调整筛选或稍后刷新。",
  );
}
async function detail(id, signal, trigger) {
  selected = null;
  element("detail").close();
  const item = await api(`/v1/catalog/${id}`, { signal, publicRead: true });
  signal.throwIfAborted();
  presentDetail(item, trigger);
  status("已读取当前公开详情。下载仍需独立授权。");
}
function presentDetail(item, trigger) {
  selected = item;
  element("detail").scrollTop = 0;
  element("detail-title").textContent = item.title;
  element("detail-kind").textContent = kinds[item.kind] ?? item.kind;
  element("detail-cover").replaceChildren(cover(item.kind));
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
  showDetail(trigger);
  controls();
}
function click(id, task) {
  element(id).addEventListener("click", () => run(task));
}
element("search").addEventListener("submit", (event) => {
  event.preventDefault();
  if (job) return;
  filters.q = element("query").value.trim();
  return run((signal) => load(signal));
});
for (const name of ["public", "library"])
  click(name, async (signal) => {
    scope = name;
    await load(signal);
  });
for (const kind of ["all", ...Object.keys(kinds)])
  click(`category-${kind}`, (signal) => {
    filters = { q: element("query").value.trim(), kind: kind === "all" ? "" : kind };
    return load(signal);
  });
element("detail-close").addEventListener("click", () => element("detail").close());
element("detail").addEventListener("close", () => {
  const target =
    opener?.isConnected && !opener.disabled && !opener.hidden
      ? opener
      : transfer.snapshot()
        ? element("transfer-open")
        : element("query");
  target.focus({ preventScroll: true });
});
element("transfer-open").addEventListener("click", () => {
  const pending = transfer.snapshot();
  if (pending) presentDetail(pending.publication, element("transfer-open"));
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
function stop() {
  initialization += 1;
  job?.abort();
  stopRequests();
}
element("stop").addEventListener("click", stop);
element("transfer-stop").addEventListener("click", stop);
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
    loginEnabled = !!session.enabled;
    element("session").textContent = session.principal
      ? `已登录 · ${session.principal}`
      : "访客浏览";
    element("login").hidden = !session.enabled || !!session.principal;
    element("logout").hidden = !session.principal;
    element("session").title = element("session").textContent;
    if (session.principal) setSession(session.csrf);
  }
  if (new URL(window.location.href).searchParams.get("auth") === "failed")
    status("登录未完成，请重试。", "error");
  controls();
})();
