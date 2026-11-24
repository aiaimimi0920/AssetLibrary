export const storeKinds = {
  art: "Art",
  capability: "能力包",
  mcp: "MCP",
  application: "应用",
};

export const applicationSpaces = {
  loom: {
    id: "loom",
    name: "Loom",
    letter: "L",
    kind: "WORKFLOW & CREATION",
    tagline: "把想法连接成作品。",
    description: "聚合已审核关联 Loom 空间的应用本体、Art 节点、MCP 工具与能力包。",
  },
  otter: {
    id: "otter",
    name: "Otter",
    letter: "O",
    kind: "DESKTOP & TOOLS",
    tagline: "让你的桌面，多一点可能。",
    description: "聚合已审核关联 Otter 空间的应用本体、桌面扩展与自动化能力。",
  },
  framelab: {
    id: "framelab",
    name: "FrameLab",
    letter: "F",
    kind: "IMAGE & MEDIA",
    tagline: "为每一帧，找到新的表达。",
    description: "聚合已审核关联 FrameLab 空间的应用本体、影像工具与素材扩展。",
  },
};

export const spaceLabels = {
  general: "跨应用通用",
  loom: "Loom 内容空间",
  otter: "Otter 内容空间",
  framelab: "FrameLab 内容空间",
};

export const assetCategoryLabels = {
  models: "3D 与场景",
  images: "2D 与 UI",
  materials: "材质与贴图",
  audio: "声音与音乐",
  effects: "特效与动画",
  templates: "代码与模板",
};

export const assetStyleLabels = {
  general: "通用风格",
  pixel: "像素",
  lowpoly: "低多边形",
  realistic: "写实",
  stylized: "风格化",
  handdrawn: "手绘",
};

export const assetFormatOptions = [
  "PNG",
  "SVG",
  "ASEPRITE",
  "GLB",
  "FBX",
  "BLEND",
  "SHADER",
  "WAV",
  "OGG",
  "LUT",
  "GDSCRIPT",
  "ZIP",
];

export const assetLicenseLabels = {
  unspecified: "以包内说明为准",
  commercial: "允许商业创作",
  personal: "仅限个人／非商用",
  open_source: "开源许可",
};

export const storeViews = {
  home: { title: "发现好东西", kinds: Object.keys(storeKinds) },
  games: { title: "游戏", unavailable: "游戏商店尚未开放。", kinds: [] },
  apps: { title: "应用", section: "applications", kinds: ["application"] },
  loom: { title: "Loom 扩展", section: "loom", kinds: ["art", "capability", "mcp"] },
  assets: { title: "素材", section: "assets", kinds: ["art"] },
  community: { title: "社区", unavailable: "社区频道尚未开放。", kinds: [] },
  library: { title: "我的资源库", kinds: Object.keys(storeKinds) },
  ...Object.fromEntries(
    Object.values(applicationSpaces).map((space) => [
      `app:${space.id}`,
      { title: `${space.name} 内容空间`, space: space.id, kinds: Object.keys(storeKinds) },
    ]),
  ),
};

export function readStoreRoute(hash = "") {
  const [name, search = ""] = hash.replace(/^#/, "").split("?");
  let view = "home";
  if (name.startsWith("app/")) {
    const spaceId = name.slice(4);
    if (Object.hasOwn(applicationSpaces, spaceId)) view = `app:${spaceId}`;
  } else if (Object.hasOwn(storeViews, name) && !name.startsWith("app:")) {
    view = name;
  }
  const params = new URLSearchParams(search);
  const kind = params.get("kind") || "";
  const filters = {
    q: (params.get("q") || "").trim().slice(0, 100),
    kind: storeViews[view].kinds.includes(kind) ? kind : "",
  };
  if (view === "assets") {
    if (params.get("mode") === "requests") filters.mode = "requests";
    if (params.get("scope") === "mine") filters.scope = "mine";
    const category = params.get("category") || "";
    if (Object.hasOwn(assetCategoryLabels, category)) filters.category = category;
    const style = params.get("style") || "";
    if (Object.hasOwn(assetStyleLabels, style)) filters.style = style;
    const format = (params.get("format") || "").toUpperCase();
    if (assetFormatOptions.includes(format)) filters.format = format;
    const license = params.get("license") || "";
    if (license !== "unspecified" && Object.hasOwn(assetLicenseLabels, license))
      filters.license = license;
    const space = params.get("space") || "";
    if (Object.hasOwn(spaceLabels, space)) filters.space = space;
  }
  return { view, filters };
}

export function storeRoute(view, filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (view === "assets") {
    for (const key of ["mode", "scope", "category", "style", "format", "license", "space"]) {
      if (filters[key]) params.set(key, filters[key]);
    }
  }
  const path = view.startsWith("app:") ? `app/${view.slice(4)}` : view;
  return `#${path}${params.size ? `?${params}` : ""}`;
}

/** 只更新商店壳层，所有目录、身份与下载操作仍由原有客户端拥有。 */
export function paintStoreView(element, view, filters) {
  const config = storeViews[view];
  const available = !config.unavailable;
  const isRequests = view === "assets" && filters.mode === "requests";
  const space = config.space ? applicationSpaces[config.space] : null;
  document.title = `${isRequests ? "求购广场" : config.title} · Trove`;
  element("discovery").hidden = view !== "home" || !!filters.q || !!filters.kind;
  element("space").hidden = !space;
  if (space) {
    element("space-letter").textContent = space.letter;
    element("space-letter").dataset.space = space.id;
    element("space-kind").textContent = space.kind;
    element("space-title").textContent = `${space.name} 内容空间`;
    element("space-tagline").textContent = space.tagline;
    element("space-description").textContent = space.description;
  }
  element("catalog").hidden = !available || isRequests;
  element("unavailable").hidden = available;
  element("unavailable-title").textContent = config.title;
  element("unavailable-hint").textContent = config.unavailable || "";
  element("heading").textContent = filters.q ? "搜索结果" : config.title;
  element("context").textContent =
    view === "library"
      ? "YOUR LIBRARY"
      : space
        ? `SPACE / ${space.id.toUpperCase()}`
        : "TROVE / DISCOVER";
  element("filter-summary").textContent = [
    space ? `${space.name} 空间` : "",
    filters.kind ? storeKinds[filters.kind] : "",
    filters.q ? `名称包含「${filters.q}」` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  for (const name of ["home", "games", "apps", "loom", "assets", "community", "library"]) {
    const button = element(
      name === "home" ? "public" : name === "library" ? name : `section-${name}`,
    );
    button.setAttribute("aria-pressed", String(name === view));
  }
  for (const name of ["all", ...Object.keys(storeKinds)]) {
    const button = element(`category-${name}`);
    button.hidden = name !== "all" && !config.kinds.includes(name);
    button.setAttribute("aria-pressed", String((name === "all" ? "" : name) === filters.kind));
  }
}

/** 生成商店卡片与详情封面；公开封面附带内容摘要短指纹以最大化浏览器与边缘缓存复用。 */
export function renderStoreCover(item, kinds, codes) {
  const makeNode = (tag, value, className = "") => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const kind = typeof item === "string" ? item : item?.kind;
  const coverFact = typeof item === "object" ? item?.cover : null;
  if (coverFact?.url) {
    const node = makeNode("div", "", "asset-cover has-image");
    const image = document.createElement("img");
    image.className = "asset-cover-image";
    const versionSuffix =
      typeof coverFact.sha256 === "string" && /^[0-9a-f]{16,64}$/.test(coverFact.sha256)
        ? `?v=${coverFact.sha256.slice(0, 16)}`
        : "";
    image.setAttribute("src", `${coverFact.url}${versionSuffix}`);
    image.setAttribute("alt", "");
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    if (coverFact.width) image.setAttribute("width", String(coverFact.width));
    if (coverFact.height) image.setAttribute("height", String(coverFact.height));
    node.append(image);
    return node;
  }
  const node = makeNode("div", "", "asset-cover");
  node.append(
    makeNode("span", kinds[kind] ?? "资源包"),
    makeNode("strong", codes[kind] ?? "PKG"),
    makeNode("span", "类型图示 · 暂无内容预览"),
  );
  return node;
}

/** 渲染商店卡片列表；单张卡片启用 content-visibility 与封面短指纹。 */
export function renderStoreCards(container, items, { kinds, codes, renderBadges, onDetail }) {
  const makeNode = (tag, value, className = "") => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  container.replaceChildren();
  for (const item of items) {
    const card = makeNode("article", "", "asset-card");
    const body = makeNode("div", "", "asset-body");
    const title = makeNode("h3", item.title);
    title.title = item.title;
    const spaceTag =
      item.space && item.space !== "general" && applicationSpaces[item.space]
        ? ` · ${applicationSpaces[item.space].name} 空间`
        : "";
    body.append(makeNode("p", `${kinds[item.kind] ?? item.kind}${spaceTag}`, "asset-type"), title);
    const badges = renderBadges(item);
    if (badges) body.append(badges);
    if (item.summary) body.append(makeNode("p", item.summary, "asset-summary"));
    const meta = makeNode("p", "", "asset-meta");
    const size =
      item.size < 1024
        ? `${item.size} B`
        : item.size < 1024 * 1024
          ? `${(item.size / 1024).toFixed(1)} KiB`
          : `${(item.size / 1024 / 1024).toFixed(2)} MiB`;
    meta.append(makeNode("span", `版本 ${item.label}`), makeNode("span", size));
    body.append(meta);
    const bottom = makeNode("div", "", "asset-bottom");
    bottom.append(
      makeNode(
        "p",
        item.scanStatus === "not_scanned" ? "△ 未扫描" : "资格以下载时校验为准",
        "asset-warning",
      ),
    );
    const button = makeNode("button", "查看详情 ↗", "asset-open");
    button.type = "button";
    button.setAttribute("aria-label", `查看资产：${item.title}`);
    button.addEventListener("click", () => onDetail(item.id, button));
    bottom.append(button);
    body.append(bottom);
    card.append(renderStoreCover(item, kinds, codes), body);
    container.append(card);
  }
}

/** 读取期间保持顶部导航、分类与搜索框随时可点（支持抢占式切换），仅锁定写操作与分页动作。 */
export function applyStoreActionLocks(
  element,
  { busy, mutating, connected, cursor, selected, pending },
) {
  for (const id of [
    "publish",
    "space-publish",
    "asset-publish",
    "request-open",
    "refresh",
    "requests-refresh",
    "req-submit",
    "req-response-submit",
    "req-close-action",
    "logout",
  ]) {
    const node = element(id);
    if (node) node.disabled = busy;
  }
  for (const navId of [
    "public",
    "section-games",
    "section-apps",
    "section-loom",
    "section-assets",
    "section-community",
  ]) {
    const node = element(navId);
    if (node) node.disabled = mutating;
  }
  for (const control of document.querySelectorAll(".store button,.store input,.store select")) {
    if (control.className === "asset-open" || control.className === "am-request-open") {
      control.disabled = mutating;
    }
  }
  element("query").disabled = mutating;
  element("more").disabled = busy || !cursor;
  element("library").disabled = mutating || !connected || (busy && !connected);
  element("download").disabled = busy || !connected || !selected;
  element("resume").disabled = busy || !connected || !pending?.resumable;
  element("discard").disabled = busy || !pending;
  element("stop").disabled = !busy && !pending;
  element("transfer-stop").disabled = !busy && !pending;
  element("transfer-open").disabled = false;
  element("detail-close").disabled = false;
}

/** 阻止原生 dialog 遮罩区滚轮穿透至文档根滚动容器。 */
export function bindModalScrollLock(element) {
  window.addEventListener(
    "wheel",
    (event) => {
      for (const id of ["detail", "publish-dialog", "request-compose", "request-detail"]) {
        const dialog = element(id);
        if (!dialog?.open || !dialog.getBoundingClientRect) continue;
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          event.preventDefault();
        }
        return;
      }
    },
    { passive: false },
  );
}
