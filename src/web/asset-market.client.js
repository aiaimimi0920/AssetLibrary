import { api, completeOperation, connected, operationKey } from "./api.client.js";
import {
  assetCategoryLabels,
  assetFormatOptions,
  assetLicenseLabels,
  assetStyleLabels,
  spaceLabels,
} from "./store-view.client.js";

function text(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function parseFormatInput(raw, requireNonEmpty = false) {
  const tokens = String(raw ?? "")
    .split(/[\s,，、/]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if ((requireNonEmpty && tokens.length === 0) || tokens.length > 4)
    throw new Error("INVALID_ASSET_FORMATS");
  const seen = new Set();
  for (const item of tokens) {
    if (!assetFormatOptions.includes(item) || seen.has(item))
      throw new Error("INVALID_ASSET_FORMATS");
    seen.add(item);
  }
  return [...seen].sort();
}

export function renderAssetBadges(item) {
  const attrs = item?.assetAttributes;
  if (!attrs) return null;
  const labels = [];
  if (attrs.category && attrs.category !== "general" && assetCategoryLabels[attrs.category])
    labels.push(assetCategoryLabels[attrs.category]);
  if (attrs.style && attrs.style !== "general" && assetStyleLabels[attrs.style])
    labels.push(assetStyleLabels[attrs.style]);
  if (Array.isArray(attrs.formats) && attrs.formats.length)
    labels.push(attrs.formats.slice(0, 2).join(" / "));
  if (attrs.license && attrs.license !== "unspecified" && assetLicenseLabels[attrs.license])
    labels.push(assetLicenseLabels[attrs.license]);
  if (!labels.length) return null;
  const wrap = text("div", "", "asset-badges");
  for (const label of labels) wrap.append(text("span", label, "asset-badge"));
  return wrap;
}

export function assetFactEntries(item) {
  const attrs = item?.assetAttributes;
  if (!attrs) return [];
  const rows = [];
  if (attrs.category && attrs.category !== "general" && assetCategoryLabels[attrs.category])
    rows.push(["素材分类", assetCategoryLabels[attrs.category]]);
  if (attrs.style && attrs.style !== "general" && assetStyleLabels[attrs.style])
    rows.push(["视觉风格", assetStyleLabels[attrs.style]]);
  if (Array.isArray(attrs.formats) && attrs.formats.length)
    rows.push(["文件格式", attrs.formats.join(", ")]);
  rows.push(["许可范围", assetLicenseLabels[attrs.license] ?? assetLicenseLabels.unspecified]);
  return rows;
}

/** 管理 #assets 素材细分筛选与求购广场；不引入后台轮询或虚拟商品。 */
export function initAssetMarket({
  element,
  run,
  getView,
  getFilters,
  setFilters,
  reloadView,
  promptLogin,
  isLoginEnabled,
  refreshControls,
}) {
  let requestCursor = null;
  let activeRequest = null;
  let requestOpener = null;
  let composeOpener = null;

  function requestStatus(message, tone = "info") {
    for (const id of ["requests-status", "req-detail-status"]) {
      element(id).textContent = message;
      element(id).dataset.tone = tone;
    }
  }

  function syncHubControls() {
    const inAssets = getView() === "assets";
    const filters = getFilters();
    const isRequests = filters.mode === "requests";
    element("asset-hub").hidden = !inAssets;
    element("requests-panel").hidden = !inAssets || !isRequests;
    if (!inAssets) return;

    element("am-mode-market").setAttribute("aria-pressed", String(!isRequests));
    element("am-mode-requests").setAttribute("aria-pressed", String(isRequests));
    for (const cat of ["all", ...Object.keys(assetCategoryLabels)]) {
      const value = cat === "all" ? "" : cat;
      element(`am-cat-${cat}`).setAttribute(
        "aria-pressed",
        String((filters.category || "") === value),
      );
    }
    element("am-style").value = filters.style || "";
    element("am-format").value = filters.format || "";
    element("am-license").value = filters.license || "";
    element("am-space").value = filters.space || "";
    element("am-scope").value = connected() && filters.scope === "mine" ? "mine" : "public";
    element("am-scope-wrap").hidden = !isRequests || !connected();
    renderChips(filters);
  }

  function renderChips(filters) {
    const chips = element("am-chips");
    chips.replaceChildren();
    const entries = [
      filters.q ? ["q", `关键词：${filters.q}`] : null,
      filters.category ? ["category", assetCategoryLabels[filters.category]] : null,
      filters.style ? ["style", `风格：${assetStyleLabels[filters.style]}`] : null,
      filters.format ? ["format", `格式：${filters.format}`] : null,
      filters.license ? ["license", assetLicenseLabels[filters.license]] : null,
      filters.space ? ["space", spaceLabels[filters.space]] : null,
      filters.mode === "requests" && connected() && filters.scope === "mine"
        ? ["scope", "我发布的求购"]
        : null,
    ].filter(Boolean);
    for (const [key, label] of entries) {
      const chip = text("button", `${label} ×`, "am-chip");
      chip.type = "button";
      chip.setAttribute("aria-label", `清除筛选：${label}`);
      chip.addEventListener("click", () =>
        run((signal) => {
          const next = { ...getFilters() };
          delete next[key];
          if (key === "q") {
            next.q = "";
            element("query").value = "";
          }
          setFilters(next);
          return reloadView(signal);
        }),
      );
      chips.append(chip);
    }
  }

  function renderRequests(items) {
    const list = element("requests-results");
    list.replaceChildren();
    for (const item of items) {
      const card = text("article", "", "am-request-card");
      const top = text("div", "", "am-request-top");
      const stateBadge = item.state === "closed" ? " · 已关闭" : "";
      top.append(
        text(
          "span",
          `${assetCategoryLabels[item.category] ?? item.category}${stateBadge}`,
          "am-request-category",
        ),
        text("span", item.budgetNote || "协作／预算面议", "am-request-budget"),
      );
      const heading = text("h3", item.title);
      const desc = text("p", item.description, "am-request-desc");
      const tags = text("div", "", "am-request-tags");
      if (item.style && assetStyleLabels[item.style])
        tags.append(text("span", assetStyleLabels[item.style], "am-tag"));
      for (const fmt of item.formats ?? []) tags.append(text("span", fmt, "am-tag"));
      tags.append(
        text("span", spaceLabels[item.space] ?? spaceLabels.general, "am-tag"),
        text("span", assetLicenseLabels[item.license] ?? item.license, "am-tag"),
      );
      const footer = text("div", "", "am-request-footer");
      footer.append(
        text("span", `期望周期 ${item.periodDays} 天 · 已有 ${item.responseCount} 份方案`),
      );
      const openBtn = text("button", "查看需求 ↗", "am-request-open");
      openBtn.type = "button";
      openBtn.setAttribute("aria-label", `查看求购需求：${item.title}`);
      openBtn.addEventListener("click", () =>
        run((signal) => openRequestDetail(item, signal, openBtn)),
      );
      footer.append(openBtn);
      card.append(top, heading, desc, tags, footer);
      list.append(card);
    }
  }

  async function loadRequests(signal, after = "", reload = false) {
    requestCursor = null;
    element("requests-empty").hidden = true;
    element("requests-results").replaceChildren();
    syncHubControls();
    const filters = getFilters();
    const mine = connected() && filters.scope === "mine";
    element("requests-heading").textContent = mine ? "我发布的求购" : "求购广场";
    element("requests-summary").textContent = mine
      ? "管理本人发布的开放与已关闭求购记录"
      : "浏览已登录创作者发布的真实素材定制与共创需求";
    requestStatus("正在读取求购需求…");
    const params = new URLSearchParams({ limit: "20" });
    for (const key of ["category", "style", "format", "license", "space", "q"]) {
      if (filters[key]) params.set(key, filters[key]);
    }
    if (after) params.set("after", after);
    const page = await api(`${mine ? "/v1/me/asset-requests" : "/v1/asset-requests"}?${params}`, {
      signal,
      publicRead: !mine,
      reload: !mine && reload,
    });
    signal.throwIfAborted();
    requestCursor = page.nextAfter;
    renderRequests(page.items);
    element("requests-empty").hidden = page.items.length !== 0;
    requestStatus(
      page.items.length ? `本页 ${page.items.length} 项求购需求` : "当前筛选下暂无求购需求。",
    );
  }

  async function openRequestDetail(summaryItem, signal, trigger) {
    activeRequest = null;
    element("request-detail").close();
    const mine = connected() && getFilters().scope === "mine";
    const item = mine
      ? summaryItem
      : await api(`/v1/asset-requests/${summaryItem.id}`, { signal, publicRead: true });
    signal.throwIfAborted();
    let responseData = null;
    if (connected()) {
      responseData = await api(`/v1/asset-requests/${item.id}/responses?limit=20`, { signal });
      signal.throwIfAborted();
    }
    const detailItem = responseData?.request ?? item;
    activeRequest = {
      item: detailItem,
      viewerRole: responseData?.viewerRole ?? "guest",
      responses: responseData?.items ?? [],
    };
    presentRequestDetail(trigger);
  }

  function presentRequestDetail(trigger) {
    const { item, viewerRole, responses } = activeRequest;
    requestOpener = trigger;
    element("request-detail").scrollTop = 0;
    element("req-detail-kicker").textContent =
      `${assetCategoryLabels[item.category] ?? item.category} · ${item.state === "closed" ? "已关闭" : "开放征集中"}`;
    element("request-detail-title").textContent = item.title;
    element("req-detail-description").textContent = item.description;
    const facts = element("req-detail-facts");
    facts.replaceChildren();
    for (const [label, value] of [
      ["协作／预算说明", item.budgetNote || "面议（平台不含支付）"],
      ["期望周期", `${item.periodDays} 天`],
      ["目标格式", (item.formats ?? []).join(", ")],
      ["视觉风格", assetStyleLabels[item.style] ?? item.style],
      ["适用空间", spaceLabels[item.space] ?? spaceLabels.general],
      ["许可要求", assetLicenseLabels[item.license] ?? item.license],
      ["交付要求", item.delivery],
      ["已收方案数", `${item.responseCount} 份`],
    ]) {
      facts.append(text("dt", label), text("dd", value));
    }

    const isOwner = viewerRole === "requester";
    element("req-close-action").hidden = !isOwner || item.state !== "open";
    element("req-login-hint").hidden = connected() || !isLoginEnabled();
    element("req-response-form").hidden =
      !connected() || isOwner || item.state !== "open" || responses.length > 0;

    element("req-responses-heading").textContent = isOwner
      ? `收到的方案（${responses.length}）`
      : connected()
        ? "我的方案响应"
        : "方案响应";
    const list = element("req-responses-list");
    list.replaceChildren();
    if (responses.length) {
      for (const resp of responses) {
        const box = text("div", "", "am-response-item");
        const header = isOwner ? `来自 ${resp.responder}` : "我已提交的方案";
        box.append(text("strong", header), text("p", resp.message));
        if (resp.publicationId) {
          box.append(
            text(
              "small",
              `关联已发布作品：${resp.publicationTitle || resp.publicationId}`,
              "muted",
            ),
          );
        }
        list.append(box);
      }
    } else if (isOwner) {
      list.append(text("p", "暂未收到创作者方案响应。", "muted"));
    } else if (connected() && item.state !== "open") {
      list.append(text("p", "该求购已关闭，不再接受新方案。", "muted"));
    }
    element("req-detail-status").textContent = "";
    if (!element("request-detail").open) element("request-detail").showModal();
    element("request-detail-close").focus();
    refreshControls();
  }

  async function mutateWithKey(scopeName, path, body, signal) {
    const op = operationKey(scopeName, body);
    try {
      const res = await api(path, { method: "POST", body, signal, key: op.key });
      completeOperation(op);
      return res;
    } catch (error) {
      if ([400, 404, 409, 422].includes(error.status)) completeOperation(op);
      throw error;
    }
  }

  element("am-mode-market").addEventListener("click", () =>
    run((signal) => {
      const next = { ...getFilters() };
      delete next.mode;
      delete next.scope;
      setFilters(next);
      return reloadView(signal);
    }),
  );
  element("am-mode-requests").addEventListener("click", () =>
    run((signal) => {
      setFilters({ ...getFilters(), mode: "requests" });
      return reloadView(signal);
    }),
  );
  for (const cat of ["all", ...Object.keys(assetCategoryLabels)]) {
    element(`am-cat-${cat}`).addEventListener("click", () =>
      run((signal) => {
        const next = { ...getFilters() };
        if (cat === "all") delete next.category;
        else next.category = cat;
        setFilters(next);
        return reloadView(signal);
      }),
    );
  }
  for (const [id, key] of [
    ["am-style", "style"],
    ["am-format", "format"],
    ["am-license", "license"],
    ["am-space", "space"],
    ["am-scope", "scope"],
  ]) {
    element(id).addEventListener("change", () =>
      run((signal) => {
        const next = { ...getFilters() };
        const val = element(id).value;
        if (!val || (key === "scope" && val === "public")) delete next[key];
        else next[key] = val;
        setFilters(next);
        return reloadView(signal);
      }),
    );
  }
  element("am-reset").addEventListener("click", () =>
    run((signal) => {
      const mode = getFilters().mode;
      element("query").value = "";
      setFilters(mode === "requests" ? { q: "", kind: "", mode: "requests" } : { q: "", kind: "" });
      return reloadView(signal);
    }),
  );
  element("asset-publish").addEventListener("click", () =>
    promptLogin("", element("asset-publish"), "登录后发布素材", "/auth/login?returnTo=workspace"),
  );
  element("request-open").addEventListener("click", () => {
    if (!connected()) {
      promptLogin("", element("request-open"), "请先登录后发布求购", "/auth/login");
      return;
    }
    composeOpener = element("request-open");
    element("req-compose-status").textContent = "";
    element("request-compose").showModal();
    element("request-compose-close").focus();
    refreshControls();
  });
  element("request-compose-close").addEventListener("click", () =>
    element("request-compose").close(),
  );
  element("request-compose").addEventListener("close", () =>
    (composeOpener?.isConnected && !composeOpener.hidden
      ? composeOpener
      : element("request-open")
    ).focus({
      preventScroll: true,
    }),
  );
  element("request-detail-close").addEventListener("click", () =>
    element("request-detail").close(),
  );
  element("request-detail").addEventListener("close", () =>
    (requestOpener?.isConnected && !requestOpener.hidden ? requestOpener : element("query")).focus({
      preventScroll: true,
    }),
  );
  element("requests-refresh").addEventListener("click", () =>
    run((signal) => loadRequests(signal, "", true)),
  );
  element("requests-more").addEventListener("click", () =>
    run((signal) => loadRequests(signal, requestCursor)),
  );

  element("request-form").addEventListener("submit", (event) => {
    event.preventDefault();
    return run(async (signal) => {
      const body = {
        title: element("req-title").value.trim(),
        category: element("req-category").value,
        style: element("req-style").value,
        space: element("req-space").value,
        formats: parseFormatInput(element("req-formats").value, true),
        license: element("req-license").value,
        periodDays: Number(element("req-period").value),
        budgetNote: element("req-budget").value.trim(),
        delivery: element("req-delivery").value.replaceAll("\r\n", "\n").trim(),
        description: element("req-description").value.replaceAll("\r\n", "\n").trim(),
      };
      await mutateWithKey("asset-request:create", "/v1/asset-requests", body, signal);
      element("req-title").value = "";
      element("req-budget").value = "";
      element("req-delivery").value = "";
      element("req-description").value = "";
      element("request-compose").close();
      setFilters({ ...getFilters(), mode: "requests" });
      await reloadView(signal, true);
      requestStatus("求购需求已发布。", "success");
    });
  });

  element("req-response-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!activeRequest?.item) return;
    return run(async (signal) => {
      const pubRaw = element("req-response-pub").value.trim();
      const body = {
        message: element("req-response-message").value.replaceAll("\r\n", "\n").trim(),
        publicationId: pubRaw ? pubRaw : null,
      };
      const id = activeRequest.item.id;
      await mutateWithKey(
        `asset-request:respond:${id}`,
        `/v1/asset-requests/${id}/responses`,
        body,
        signal,
      );
      element("req-response-message").value = "";
      element("req-response-pub").value = "";
      await openRequestDetail(activeRequest.item, signal, requestOpener);
      await loadRequests(signal, "", true);
      requestStatus("方案已提交。", "success");
    });
  });

  element("req-close-action").addEventListener("click", () => {
    if (!activeRequest?.item) return;
    return run(async (signal) => {
      const { id, revision } = activeRequest.item;
      const closed = await mutateWithKey(
        `asset-request:close:${id}`,
        `/v1/asset-requests/${id}/close`,
        { revision },
        signal,
      );
      activeRequest.item = closed;
      element("request-detail").close();
      await loadRequests(signal, "", true);
      requestStatus("求购需求已关闭。", "success");
    });
  });

  return {
    syncHubControls,
    loadRequests,
    controls(busy) {
      element("requests-more").disabled = busy || !requestCursor;
      element("requests-results").setAttribute("aria-busy", String(busy));
      element("request-compose-close").disabled = false;
      element("request-detail-close").disabled = false;
    },
    reset() {
      requestCursor = null;
      activeRequest = null;
      element("requests-results").replaceChildren();
      element("request-compose").close();
      element("request-detail").close();
    },
  };
}
