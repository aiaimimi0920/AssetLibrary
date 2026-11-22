import { api, completeOperation, operationKey } from "./api.client.js";
import { confirmAction, element } from "./render.client.js";

const spaces = ["general", "loom", "otter", "framelab"];
const categories = ["general", "models", "images", "materials", "audio", "effects", "templates"];
const styles = ["general", "pixel", "lowpoly", "realistic", "stylized", "handdrawn"];
const licenses = ["unspecified", "commercial", "personal", "open_source"];
const allowedFormats = [
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
const bindingWarning =
  "此次修改会增加资源 revision，使既有版本绑定失效，并阻止对应的新下载。历史审核和文件保留；后续需要创建并审核新版本。";

function parseFormats(raw) {
  const list = String(raw ?? "")
    .split(/[\s,，、/]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (list.length > 4) throw new Error("INVALID_ASSET_FORMATS");
  const seen = new Set();
  for (const item of list) {
    if (!allowedFormats.includes(item) || seen.has(item)) throw new Error("INVALID_ASSET_FORMATS");
    seen.add(item);
  }
  return [...seen].sort();
}

function requestedSpace() {
  try {
    const value = new URL(window.location.href).searchParams.get("space") ?? "";
    return spaces.includes(value) && value !== "general" ? value : "";
  } catch {
    return "";
  }
}

/** 管理当前资源的展示资料、适用空间与静态 PNG 封面；资源或身份切换时清空草稿。 */
export function initShowcaseManagement({ form, button, refreshControls, changed }) {
  let current = null;
  let principal = "";
  const preset = requestedSpace();

  function profileOf(resource) {
    return (
      resource?.profile ?? {
        space: "general",
        summary: "",
        detail: "",
        cover: null,
      }
    );
  }

  function attrsOf(resource) {
    return (
      resource?.assetAttributes ?? {
        category: "general",
        style: "general",
        formats: [],
        license: "unspecified",
      }
    );
  }

  function coverNote(cover) {
    return cover
      ? `当前封面：${cover.width}×${cover.height} PNG · ${cover.size} bytes · SHA-256 ${cover.sha256.slice(0, 16)}…`
      : "尚未设置封面（商店将显示类型图示占位）。仅支持不超过 1 MiB 的静态 RGBA8 PNG。";
  }

  function show(resource, identity) {
    const profile = profileOf(resource);
    const attrs = attrsOf(resource);
    if (
      current?.id !== resource?.id ||
      current?.revision !== resource?.revision ||
      principal !== identity
    ) {
      const freshOwned =
        resource?.state === "draft" &&
        resource.owner === identity &&
        resource.revision === 1 &&
        profile.space === "general" &&
        !profile.summary &&
        !profile.detail &&
        !profile.cover &&
        preset;
      element("resource-space").value = freshOwned ? preset : profile.space;
      element("resource-summary").value = profile.summary;
      element("resource-detail-text").value = profile.detail;
      element("resource-cover-file").value = "";
      element("resource-asset-category").value = attrs.category;
      element("resource-asset-style").value = attrs.style;
      element("resource-asset-formats").value = (attrs.formats ?? []).join(", ");
      element("resource-asset-license").value = attrs.license;
    }
    element("resource-cover-state").textContent = coverNote(profile.cover);
    current = resource;
    principal = identity;
  }

  function dirty() {
    if (!current) return false;
    const profile = profileOf(current);
    return (
      element("resource-space").value !== profile.space ||
      element("resource-summary").value.trim() !== profile.summary ||
      element("resource-detail-text").value.replaceAll("\r\n", "\n").trim() !== profile.detail
    );
  }

  function attrsDirty() {
    if (!current) return false;
    const attrs = attrsOf(current);
    let formatsChanged = true;
    try {
      const next = parseFormats(element("resource-asset-formats").value);
      formatsChanged = JSON.stringify(next) !== JSON.stringify(attrs.formats ?? []);
    } catch {
      formatsChanged = true;
    }
    return (
      element("resource-asset-category").value !== attrs.category ||
      element("resource-asset-style").value !== attrs.style ||
      element("resource-asset-license").value !== attrs.license ||
      formatsChanged
    );
  }

  function controls(busy, connected) {
    const disabled =
      busy || !connected || current?.state !== "draft" || current.owner !== principal;
    for (const id of ["resource-profile-form", "resource-cover-form", "resource-attributes-form"])
      for (const control of element(id).querySelectorAll("input,select,textarea,button"))
        control.disabled = disabled;
    element("resource-profile-save").disabled = disabled || !dirty();
    element("resource-cover-clear").disabled = disabled || !profileOf(current).cover;
    element("resource-attributes-save").disabled = disabled || !attrsDirty();
  }

  function owned() {
    if (current?.state !== "draft" || current.owner !== principal)
      throw new Error("SELECT_OWNED_RESOURCE_REQUIRED");
    return current;
  }

  async function mutation(path, method, body, signal, raw = false, keyBody = body) {
    const operation = operationKey(`showcase:${method}:${path}`, keyBody);
    try {
      const result = await api(path, { method, body, raw, signal, key: operation.key });
      completeOperation(operation);
      return result;
    } catch (error) {
      if ([400, 404, 409, 413, 415, 422].includes(error.status)) completeOperation(operation);
      throw error;
    }
  }

  form(
    "resource-profile-form",
    async (signal) => {
      const resource = owned();
      const space = element("resource-space").value;
      const summary = element("resource-summary").value.trim();
      const detail = element("resource-detail-text").value.replaceAll("\r\n", "\n").trim();
      if (!spaces.includes(space)) throw new Error("INVALID_SPACE");
      if (summary.length > 160 || /\p{Cc}/u.test(summary)) throw new Error("INVALID_SUMMARY");
      if (detail.length > 2000 || /[^\P{Cc}\n]/u.test(detail)) throw new Error("INVALID_DETAIL");
      if (!dirty()) return;
      if (!(await confirmAction("保存展示与空间设置", bindingWarning, "确认保存"))) return;
      signal.throwIfAborted();
      const result = await mutation(
        `/v1/resources/${resource.id}/profile`,
        "PUT",
        { revision: resource.revision, space, summary, detail },
        signal,
      );
      await changed(signal, result);
    },
    "作品展示与适用空间设置已保存；请创建并审核新版本以同步公开目录。",
  );

  form(
    "resource-cover-form",
    async (signal) => {
      const resource = owned();
      const file = element("resource-cover-file").files?.[0];
      if (
        !file ||
        file.size < 1 ||
        file.size > 1048576 ||
        !file.name.toLowerCase().endsWith(".png")
      )
        throw new Error("COVER_PNG_REQUIRED_MAX_1_MIB");
      if (!(await confirmAction("上传静态 PNG 封面", bindingWarning, "确认上传封面"))) return;
      signal.throwIfAborted();
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      signal.throwIfAborted();
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const result = await mutation(
        `/v1/resources/${resource.id}/cover?revision=${resource.revision}`,
        "PUT",
        file,
        signal,
        true,
        { revision: resource.revision, size: file.size, sha256 },
      );
      element("resource-cover-file").value = "";
      await changed(signal, result);
    },
    "静态 PNG 封面已校验并保存；请创建并审核新版本以同步公开目录。",
  );

  button(
    "resource-cover-clear",
    async (signal) => {
      const resource = owned();
      if (!profileOf(resource).cover) return;
      if (!(await confirmAction("清除作品封面", bindingWarning, "确认清除封面"))) return;
      signal.throwIfAborted();
      const result = await mutation(
        `/v1/resources/${resource.id}/cover`,
        "DELETE",
        { revision: resource.revision },
        signal,
      );
      await changed(signal, result);
    },
    "作品封面已清除；历史版本快照仍保留原记录。",
  );

  form(
    "resource-attributes-form",
    async (signal) => {
      const resource = owned();
      const category = element("resource-asset-category").value;
      const style = element("resource-asset-style").value;
      const formats = parseFormats(element("resource-asset-formats").value);
      const license = element("resource-asset-license").value;
      if (!categories.includes(category)) throw new Error("INVALID_ASSET_CATEGORY");
      if (!styles.includes(style)) throw new Error("INVALID_ASSET_STYLE");
      if (!licenses.includes(license)) throw new Error("INVALID_ASSET_LICENSE");
      if (!attrsDirty()) return;
      if (!(await confirmAction("保存素材细分属性", bindingWarning, "确认保存属性"))) return;
      signal.throwIfAborted();
      const result = await mutation(
        `/v1/resources/${resource.id}/attributes`,
        "PUT",
        { revision: resource.revision, category, style, formats, license },
        signal,
      );
      await changed(signal, result);
    },
    "素材细分属性已保存；请创建并审核新版本以同步公开目录。",
  );

  for (const id of [
    "resource-space",
    "resource-summary",
    "resource-detail-text",
    "resource-asset-formats",
  ])
    element(id).addEventListener("input", refreshControls);
  for (const id of [
    "resource-space",
    "resource-asset-category",
    "resource-asset-style",
    "resource-asset-license",
  ])
    element(id).addEventListener("change", refreshControls);

  return { show, controls, reset: () => show(null, "") };
}
