import { api } from "./api.client.js";
import { distributionList, management } from "./distribution-render.client.js";
import { savePackage } from "./download.client.js";
import { confirmAction, element, facts } from "./render.client.js";

import { createDownloadTransfer } from "./resume-download.client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 管理状态只来自 owner API；身份切换全部清除，不由公开目录推断 owner 权限。 */
export function initDistribution({ run, button, form, refreshControls }) {
  let managed = null;
  let grant = null;
  const transfer = createDownloadTransfer((value) => {
    element("download-state").textContent = value
      ? `${value.offset} / ${value.total} bytes 已完整接收${value.resumable ? "；可手动继续，或放弃。" : "；正在下载并校验。"}`
      : "没有未完成下载。";
    refreshControls();
  });
  const cursors = { catalog: null, library: null };
  function controls(busy, connected) {
    const pending = transfer.snapshot();
    element("resume-download").disabled = busy || !connected || !pending?.resumable;
    element("discard-download").disabled = busy || !pending;
    element("publication-id").disabled = busy || !connected;
    element("more-catalog").disabled = busy || !cursors.catalog;
    element("more-library").disabled = busy || !connected || !cursors.library;
    element("unlist-publication").disabled = busy || !connected || managed?.state !== "published";
    element("download-managed").disabled = busy || !connected || managed?.state !== "published";
    for (const control of element("grant-read-form").querySelectorAll("input,button"))
      control.disabled = busy || !connected || !managed;
    element("grant-activate").disabled =
      busy ||
      !connected ||
      !managed ||
      !grant ||
      grant.state === "active" ||
      managed.state !== "published";
    element("grant-revoke").disabled = busy || !connected || !managed || grant?.state !== "active";
  }
  function reset() {
    transfer.clear();
    managed = null;
    grant = null;
    for (const name of ["catalog", "library"]) {
      cursors[name] = null;
      element(name).replaceChildren();
      element(`${name}-state`).textContent =
        name === "catalog"
          ? "点击读取公开目录；服务未准入时明确显示错误。"
          : "连接身份后读取独立下载授权的资源库。";
    }
    element("publication-id").value = "";
    element("grant-principal").value = "";
    facts("catalog-detail", "尚未读取公开详情。");
    management(null, null);
  }
  async function load(name, signal, after = "") {
    element(name).replaceChildren();
    cursors[name] = null;
    element(`${name}-state`).textContent = "正在读取…";
    try {
      const path = name === "catalog" ? "/v1/catalog" : "/v1/me/library";
      const page = await api(`${path}?limit=20${after ? `&after=${after}` : ""}`, {
        signal,
        publicRead: name === "catalog",
      });
      cursors[name] = page.nextAfter;
      distributionList(name, page.items, handlers);
      element(`${name}-state`).textContent = page.items.length
        ? `当前页 ${page.items.length} 项；目录可读不等于包体可下载。`
        : page.nextAfter
          ? "本页候选已失效，可继续下一页。"
          : "没有当前可分发记录。";
    } catch (error) {
      if (!signal.aborted) element(`${name}-state`).textContent = `读取失败：${error.message}`;
      throw error;
    }
  }
  async function manage(id, signal) {
    if (!uuid.test(id)) throw new Error("INVALID_PUBLICATION_ID");
    managed = null;
    grant = null;
    management(null, null);
    const value = await api(`/v1/publications/${id}`, { signal });
    managed = value;
    element("publication-id").value = id;
    management(managed, null);
  }
  async function readGrant(signal) {
    if (!managed) throw new Error("READ_OWNER_PUBLICATION_REQUIRED");
    const principal = element("grant-principal").value.trim();
    if (!/^[A-Za-z0-9:._@-]{1,200}$/.test(principal)) throw new Error("INVALID_PRINCIPAL");
    grant = null;
    management(managed, null);
    try {
      grant = await api(`/v1/publications/${managed.id}/grants/${encodeURIComponent(principal)}`, {
        signal,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
      grant = { principal, state: "absent", revision: 0 };
    }
    management(managed, grant);
  }
  async function changeGrant(method, signal) {
    if (!managed || !grant) throw new Error("READ_DOWNLOAD_GRANT_REQUIRED");
    const path = `/v1/publications/${managed.id}/grants/${encodeURIComponent(grant.principal)}`;
    const revision = grant.revision;
    if (
      method === "DELETE" &&
      !(await confirmAction(
        "撤销下载授权",
        `主体 ${grant.principal} 的旧票据和新续传将失效；已传字节无法收回。`,
        "确认撤销",
      ))
    )
      return;
    signal.throwIfAborted();
    grant = null;
    management(managed, null);
    try {
      grant = await api(path, { method, body: { revision }, signal });
    } catch (error) {
      if (!signal.aborted) facts("grant-detail", "提交结果未知或冲突，请先查询当前授权再继续。");
      throw error;
    }
    management(managed, grant);
  }
  async function download(publication, signal) {
    const result = await transfer.fetch(publication, signal);
    signal.throwIfAborted();
    savePackage(result.blob, result.versionId);
  }
  button(
    "resume-download",
    async (signal) => {
      const result = await transfer.fetch(null, signal, true);
      signal.throwIfAborted();
      savePackage(result.blob, result.versionId);
    },
    "包体长度及 SHA-256 已核对，已交给浏览器保存。",
  );
  button("discard-download", () => transfer.clear(), "未完成下载字节已丢弃。");
  const handlers = {
    detail: (id) =>
      run(async (signal) => {
        facts("catalog-detail", "正在读取当前公开详情…");
        facts("catalog-detail", await api(`/v1/catalog/${id}`, { signal, publicRead: true }));
      }, "已读取公开详情；包体仍独立授权。"),
    download: (publication) =>
      run(
        (signal) => download(publication, signal),
        "包体长度及 SHA-256 已核对，已交给浏览器保存。",
      ),
  };
  element("grant-principal").addEventListener("input", () => {
    grant = null;
    management(managed, null);
    refreshControls();
  });
  element("publication-id").addEventListener("input", () => {
    managed = null;
    grant = null;
    management(null, null);
    refreshControls();
  });
  for (const name of ["catalog", "library"]) {
    button(`refresh-${name}`, (signal) => load(name, signal), "已读取当前分发目录。");
    button(`more-${name}`, (signal) => load(name, signal, cursors[name]), "已读取下一页分发目录。");
  }
  form(
    "publication-read-form",
    (signal) => manage(element("publication-id").value.trim(), signal),
    "已读取 owner 发布记录。",
  );
  form("grant-read-form", readGrant, "已查询当前下载授权；独立于目录读成员。");
  button(
    "grant-activate",
    (signal) => changeGrant("PUT", signal),
    "授权操作结束；当前事实以查询结果为准。",
  );
  button(
    "grant-revoke",
    (signal) => changeGrant("DELETE", signal),
    "撤销操作结束；已传字节无法收回。",
  );
  button(
    "download-managed",
    (signal) => download(managed, signal),
    "包体长度及 SHA-256 已核对，已交给浏览器保存。",
  );
  button(
    "unlist-publication",
    async (signal) => {
      if (!managed) throw new Error("READ_OWNER_PUBLICATION_REQUIRED");
      if (
        !(await confirmAction(
          "确认下架",
          "下架是终态，新的下载和续传将拒绝。历史版本、审核和字节不会在此操作中删除。",
          "确认下架",
        ))
      )
        return;
      signal.throwIfAborted();
      const previous = managed;
      managed = null;
      grant = null;
      management(null, null);
      managed = await api(`/v1/publications/${previous.id}/unlist`, {
        method: "POST",
        body: { revision: previous.revision },
        signal,
      });
      management(managed, null);
    },
    "下架操作结束；当前发布状态以查询结果为准。",
  );
  reset();
  return {
    reset,
    controls,
    manage,
    clearDownload: transfer.clear,
    pendingDownload: () => !!transfer.snapshot(),
  };
}
