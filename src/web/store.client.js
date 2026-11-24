import {
  api,
  connected,
  logoutSession,
  readSession,
  setCredential,
  setSession,
  stopRequests,
} from "./api.client.js";
import { assetFactEntries, initAssetMarket, renderAssetBadges } from "./asset-market.client.js";
import { savePackage } from "./download.client.js";
import { createDownloadTransfer } from "./resume-download.client.js";
import {
  applicationSpaces,
  applyStoreActionLocks,
  bindModalScrollLock,
  paintStoreView,
  readStoreRoute,
  renderStoreCards,
  renderStoreCover,
  spaceLabels,
  storeRoute,
  storeViews,
} from "./store-view.client.js";

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
let mutating = false;
let initialization = 0;
let initializing = true;
let filters = { q: "", kind: "" };
let opener = null;
let publishOpener = null;
let loginEnabled = false;
const initialRoute = readStoreRoute(window.location.hash);
let view = initialRoute.view === "library" ? "home" : initialRoute.view;
filters = initialRoute.view === "library" ? filters : initialRoute.filters;
const viewFilters = new Map();
let pendingRoute = null;
let assetMarket;
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
  paintStoreView(element, view, filters);
  assetMarket?.syncHubControls();
  element("query").value = filters.q;
  element("query").placeholder = storeViews[view].unavailable
    ? "搜索现有作品…"
    : view === "assets" && filters.mode === "requests"
      ? "搜索求购标题或说明…"
      : storeViews[view].space
        ? `搜索 ${applicationSpaces[storeViews[view].space].name} 空间作品…`
        : "搜索名称…";
}
function writeRoute(replace = true) {
  const hash = storeRoute(view, filters);
  if (window.location.hash !== hash)
    window.history?.[replace ? "replaceState" : "pushState"](null, "", hash);
}
async function changeView(next, signal, routeFilters, replace = false) {
  if (next === "library" && !connected()) {
    status("请先登录后查看资源库。", "error");
    writeRoute();
    return;
  }
  viewFilters.set(view, { ...filters });
  view = next;
  scope = next === "library" ? "library" : "public";
  filters = routeFilters ?? viewFilters.get(next) ?? { q: "", kind: "" };
  writeRoute(replace);
  await load(signal);
}
function cover(item) {
  return renderStoreCover(item, kinds, codes);
}
function showDetail(trigger) {
  opener = trigger;
  if (!element("detail").open) element("detail").showModal();
  element("detail-close").focus();
}
function controls() {
  const pending = transfer.snapshot();
  const busy = !!job || initializing;
  applyStoreActionLocks(element, {
    busy,
    mutating,
    connected: connected(),
    cursor,
    selected,
    pending,
  });
  element("login-hint").hidden = connected() || !loginEnabled;
  element("transfer").hidden = !pending || pending.publication.id !== selected?.id;
  element("transfer-open").hidden = !pending;
  element("transfer-open").textContent = pending?.resumable ? "下载任务 · 可继续" : "下载任务";
  element("results").setAttribute("aria-busy", String(busy));
  element("publish-login").hidden = connected() || !loginEnabled;
  element("publish-hint").textContent = loginEnabled
    ? "登录后继续操作。"
    : "账号服务暂不可用，请稍后再试。";
  assetMarket?.controls(busy, mutating);
}
function clearIdentity() {
  setCredential("");
  selected = null;
  transfer.clear();
  assetMarket?.reset();
  element("results").replaceChildren();
  element("detail").close();
  element("publish-dialog").close();
  element("empty").hidden = true;
  element("login").hidden = !loginEnabled;
  element("logout").hidden = true;
  element("session").title = "";
  cursor = null;
  scope = "public";
  view = "home";
  filters = { q: "", kind: "" };
  viewFilters.clear();
  writeRoute();
  context();
}
async function run(task, { exclusive = false } = {}) {
  if (job) return;
  const controller = new AbortController();
  job = controller;
  mutating = exclusive;
  controls();
  try {
    await task(controller.signal);
    controller.signal.throwIfAborted();
  } catch (error) {
    if (error.identityRejected) {
      clearIdentity();
      element("session").textContent = "登录已失效，请重新登录";
    }
    if (!(error.name === "AbortError" && pendingRoute)) {
      status(
        error.name === "AbortError"
          ? "请求已停止或超时；不会自动重试。"
          : `操作失败：${error.message}`,
        "error",
      );
    }
  } finally {
    job = null;
    mutating = false;
    controls();
    if (!initializing && pendingRoute) {
      const route = pendingRoute;
      pendingRoute = null;
      await run((signal) => changeView(route.view, signal, route.filters, true));
    }
  }
}

function navigateStore(nextView, nextFilters) {
  if (mutating) return;
  if (job || initializing) {
    pendingRoute = { view: nextView, filters: nextFilters };
    if (job) job.abort();
    return;
  }
  return run((signal) => changeView(nextView, signal, nextFilters));
}
function render(items) {
  renderStoreCards(element("results"), items, {
    kinds,
    codes,
    renderBadges: renderAssetBadges,
    onDetail: (id, button) => run((signal) => detail(id, signal, button)),
  });
}
async function load(signal, after = "", reload = false) {
  cursor = null;
  selected = null;
  element("detail").close();
  element("empty").hidden = true;
  context();
  writeRoute();
  if (storeViews[view].unavailable) {
    element("results").replaceChildren();
    status(storeViews[view].unavailable);
    return;
  }
  if (view === "assets" && filters.mode === "requests") {
    element("results").replaceChildren();
    await assetMarket.loadRequests(signal, after, reload);
    return;
  }
  status("正在读取当前目录…");
  const params = new URLSearchParams({ limit: "20" });
  if (storeViews[view].section) params.set("section", storeViews[view].section);
  if (storeViews[view].space) params.set("space", storeViews[view].space);
  if (view === "assets") {
    for (const key of ["category", "style", "format", "license", "space"]) {
      if (filters[key]) params.set(key, filters[key]);
    }
  }
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (after) params.set("after", after);
  let page;
  try {
    page = await api(`${scope === "public" ? "/v1/catalog" : "/v1/me/library"}?${params}`, {
      signal,
      publicRead: scope === "public",
      reload: scope === "public" && reload,
    });
  } catch (error) {
    if (!pendingRoute) element("results").replaceChildren();
    throw error;
  }
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
  const hostSpace =
    item.space && applicationSpaces[item.space] ? applicationSpaces[item.space] : null;
  element("detail").scrollTop = 0;
  element("detail-title").textContent = item.title;
  element("detail-kind").textContent = kinds[item.kind] ?? item.kind;
  element("detail-summary").textContent = item.summary ?? "";
  element("detail-summary").hidden = !item.summary;
  element("detail-description").textContent = item.detail ?? "";
  element("detail-description").hidden = !item.detail;
  element("detail-space").hidden = !hostSpace;
  if (hostSpace) {
    element("detail-space").setAttribute("href", `#app/${hostSpace.id}`);
    element("detail-space").textContent = `进入 ${hostSpace.name} 内容空间 →`;
  }
  element("detail-cover").replaceChildren(cover(item));
  element("detail-cover-note").textContent = item.cover?.url
    ? `发布者提供的已审核静态 PNG 封面（${item.cover.width}×${item.cover.height}），不代表包内全部内容。`
    : "类型图示，不代表包内内容预览。";
  element("facts").replaceChildren();
  for (const [label, value] of [
    ["适用空间", spaceLabels[item.space] ?? spaceLabels.general],
    ["资源类型", kinds[item.kind] ?? item.kind],
    ...assetFactEntries(item),
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
function click(id, task, exclusive = false) {
  element(id).addEventListener("click", () => run(task, { exclusive }));
}
element("search").addEventListener("submit", (event) => {
  event.preventDefault();
  if (mutating) return;
  const q = element("query").value.trim();
  const targetView = storeViews[view].unavailable ? "home" : view;
  const nextFilters = storeViews[view].unavailable ? { q, kind: "" } : { ...filters, q };
  return navigateStore(targetView, nextFilters);
});
for (const name of ["public", "library"])
  element(name).addEventListener("click", () => navigateStore(name === "public" ? "home" : name));
for (const name of ["games", "apps", "loom", "assets", "community"])
  element(`section-${name}`).addEventListener("click", () => navigateStore(name));
for (const kind of ["all", ...Object.keys(kinds)])
  element(`category-${kind}`).addEventListener("click", () =>
    navigateStore(view, {
      ...filters,
      q: element("query").value.trim(),
      kind: kind === "all" ? "" : kind,
    }),
  );
element("detail-close").addEventListener("click", () => element("detail").close());
element("detail-space").addEventListener("click", (event) => {
  const spaceId = selected?.space;
  if (!spaceId || !applicationSpaces[spaceId]) return;
  event.preventDefault();
  opener = null;
  element("detail").close();
  void run((signal) => changeView(`app:${spaceId}`, signal));
});
function publish(
  targetSpace = "",
  trigger = element("publish"),
  titleText = "登录后发布作品",
  loginAction = "/auth/login?returnTo=workspace",
) {
  if (job || initializing) return;
  if (connected())
    window.location.assign(targetSpace ? `/workspace?space=${targetSpace}` : "/workspace");
  else {
    publishOpener = trigger;
    element("publish-title").textContent = titleText;
    element("publish-login").setAttribute("action", loginAction);
    element("publish-dialog").showModal();
    element("publish-close").focus();
  }
}
assetMarket = initAssetMarket({
  element,
  run,
  getView: () => view,
  getFilters: () => filters,
  setFilters: (next) => {
    filters = next;
  },
  navigateFilters: (next) => navigateStore("assets", next),
  reloadView: (signal, reload = false) => load(signal, "", reload),
  promptLogin: publish,
  isLoginEnabled: () => loginEnabled,
  refreshControls: controls,
});
element("publish").addEventListener("click", () => publish("", element("publish")));
element("space-publish").addEventListener("click", () =>
  publish(storeViews[view].space || "", element("space-publish")),
);
element("publish-close").addEventListener("click", () => element("publish-dialog").close());
element("publish-dialog").addEventListener("close", () =>
  (publishOpener?.isConnected && !publishOpener.hidden
    ? publishOpener
    : element("publish")
  ).focus(),
);
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
click("refresh", (signal) => load(signal, "", true));
click("more", (signal) => load(signal, cursor));
async function download(signal, resume = false) {
  const result = await transfer.fetch(resume ? null : selected, signal, resume);
  signal.throwIfAborted();
  savePackage(result.blob, result.versionId);
  status("长度与 SHA-256 已校验，已交给浏览器保存。", "success");
}
click("download", (signal) => download(signal), true);
click("resume", (signal) => download(signal, true), true);
click("discard", () => transfer.clear());
click(
  "logout",
  async (signal) => {
    const url = await logoutSession();
    clearIdentity();
    element("session").textContent = "已退出登录";
    signal.throwIfAborted();
    window.location.assign(url);
  },
  true,
);
function stop() {
  initialization += 1;
  pendingRoute = null;
  writeRoute();
  job?.abort();
  stopRequests();
}
element("stop").addEventListener("click", stop);
element("transfer-stop").addEventListener("click", stop);
window.addEventListener("pagehide", () => {
  initialization += 1;
  job?.abort();
  stopRequests();
  pendingRoute = null;
});
bindModalScrollLock(element);
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#store-main") return;
  pendingRoute = readStoreRoute(window.location.hash);
  if (job) job.abort();
  else if (!initializing) {
    const route = pendingRoute;
    pendingRoute = null;
    return run((signal) => changeView(route.view, signal, route.filters, true));
  }
});

// 目录与 session 各读取一次；登录状态不可阻止匿名目录查询，也不启动后台轮询。
export const ready = (async () => {
  controls();
  const current = initialization;
  const [session] = await Promise.all([
    readSession().catch(() => null),
    initialRoute.view === "library" ? Promise.resolve() : run((signal) => load(signal)),
  ]);
  if (current !== initialization) {
    initializing = false;
    controls();
    return;
  }
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
  const route = pendingRoute ?? (initialRoute.view === "library" ? initialRoute : null);
  pendingRoute = null;
  initializing = false;
  if (route) {
    if (route.view !== "library" || connected())
      await run((signal) => changeView(route.view, signal, route.filters, true));
    else {
      await run((signal) => changeView("home", signal, { q: "", kind: "" }, true));
      status("请先登录后查看资源库。", "error");
    }
  }
  if (new URL(window.location.href).searchParams.get("auth") === "failed")
    status("登录未完成，请重试。", "error");
  controls();
})();
