import {
  api,
  completeOperation,
  connected,
  logoutSession,
  operationKey,
  setCredential,
  setSession,
  stopRequests,
} from "./api.client.js";
import { initDistribution } from "./distribution.client.js";
import {
  clearView,
  confirmWithdrawal,
  element,
  facts,
  notice,
  resources,
  restoreFocus,
  reviewQueue,
  workspace,
} from "./render.client.js";
import { initResourceManagement } from "./resource.client.js";
import { confirmUploadClosed, syncUploadForm, uploadPackage } from "./upload.client.js";

function empty() {
  return {
    principal: "",
    resources: [],
    resource: null,
    uploads: [],
    versions: [],
    inspections: {},
    reviewed: null,
    reviews: [],
    reviewStatus: "尚未读取审核待办。",
    cursors: {},
  };
}
let state = empty();
let job = null;
let distribution;
let resourceManagement;
let naccount = false;

function controls() {
  syncUploadForm(state.resource);
  for (const button of document.querySelectorAll("[data-protected]"))
    button.disabled = !!job || !connected();
  for (const button of document.querySelectorAll("[data-public]")) button.disabled = !!job;
  for (const name of ["resources", "uploads", "versions", "reviews"])
    element(`more-${name}`).disabled = !!job || !connected() || !state.cursors[name];
  for (const form of ["upload-form", "version-form"])
    formControls(
      form,
      !!job || !connected() || !state.resource || state.resource.owner !== state.principal,
    );
  formControls("review-form", !!job || !connected() || state.reviewed?.state !== "pending_review");
  element("identity-form").querySelector("button").disabled = !!job;
  element("stop").disabled = !job && !distribution?.pendingDownload();
  distribution?.controls(!!job, connected());
  resourceManagement?.controls(!!job, connected());
}
function formControls(id, disabled) {
  for (const control of element(id).querySelectorAll("input,select,textarea,button"))
    control.disabled = disabled;
}
async function run(task, message) {
  if (job) return;
  const controller = new AbortController();
  const focused = document.activeElement;
  job = controller;
  controls();
  notice("正在处理…");
  try {
    await task(controller.signal);
    controller.signal.throwIfAborted();
    notice(message, "success");
  } catch (error) {
    if (job !== controller) return;
    if (error.identityRejected) {
      clearIdentity();
      notice("登录状态已失效，请重新登录。未自动重试操作。", "error");
      return;
    }
    notice(
      error.name === "AbortError"
        ? "请求已停止或超时。服务器可能已提交，请刷新真实状态后继续。"
        : error.message,
      "error",
    );
  } finally {
    if (job === controller) {
      job = null;
      controls();
      restoreFocus(focused);
    }
  }
}
function form(id, task, message) {
  element(id).addEventListener("submit", (event) => {
    event.preventDefault();
    run(task, message);
  });
}
function button(id, task, message) {
  element(id).addEventListener("click", () => run(task, message));
}
function display() {
  resources(state, select);
  workspace(state, handlers);
  resourceManagement?.show(state.resource, state.principal);
  controls();
}
async function listResources(signal, after = "") {
  const page = await api(`/v1/me/resources?limit=20${after ? `&after=${after}` : ""}`, { signal });
  state.resources = page.items;
  state.cursors.resources = page.nextCursor;
  display();
}
async function list(name, signal, after = "") {
  const page = await api(
    `/v1/resources/${state.resource.id}/${name}?limit=20${after ? `&after=${after}` : ""}`,
    { signal },
  );
  if (name === "uploads") for (const upload of page.items) confirmUploadClosed(upload);
  state[name] = page.items;
  state.cursors[name] = page.nextCursor;
}
async function refreshWorkspace(signal, id = state.resource?.id) {
  if (!id) throw new Error("SELECT_RESOURCE_REQUIRED");
  let resource;
  try {
    resource = await api(`/v1/resources/${id}`, { signal });
  } catch (error) {
    if (error.status === 404 && state.resource?.id === id) {
      state.resource = null;
      state.uploads = [];
      state.versions = [];
      state.cursors.uploads = null;
      state.cursors.versions = null;
      display();
    }
    throw error;
  }
  // 整个目标工作区读取成功后再切换，失败不得混用旧画面与新资源 ID。
  const pages =
    resource.owner === state.principal
      ? await Promise.all(
          ["uploads", "versions"].map((name) =>
            api(`/v1/resources/${id}/${name}?limit=20`, { signal }),
          ),
        )
      : [
          { items: [], nextCursor: null },
          { items: [], nextCursor: null },
        ];
  signal.throwIfAborted();
  state.resource = resource;
  state.inspections = {};
  for (const [index, name] of ["uploads", "versions"].entries()) {
    state[name] = pages[index].items;
    state.cursors[name] = pages[index].nextCursor;
  }
  for (const upload of state.uploads) confirmUploadClosed(upload);
  display();
}
function select(id) {
  run((signal) => refreshWorkspace(signal, id), "已读取当前资源。");
}
async function readVersion(id, signal) {
  const current = state;
  state.reviewed = null;
  element("review-detail").textContent = "正在读取当前版本事实…";
  controls();
  try {
    const version = await api(`/v1/versions/${id}`, { signal });
    state.reviewed = version;
    element("review-id").value = id;
    facts("review-detail", version);
    controls();
  } catch (error) {
    if (state === current)
      element("review-detail").textContent =
        error.name === "AbortError"
          ? "读取已停止或超时，请重新读取版本。"
          : `版本读取失败：${error.message}`;
    throw error;
  }
}
async function listReviews(signal, after = "") {
  const current = state;
  // 失败或取消时不保留可能已失权的旧待办，也不能把失败伪装成空队列。
  state.reviews = [];
  state.cursors.reviews = null;
  state.reviewStatus = "正在读取审核待办…";
  reviewQueue(state, handlers.readVersion);
  try {
    const page = await api(`/v1/reviews?limit=20${after ? `&after=${after}` : ""}`, { signal });
    state.reviews = page.items;
    state.cursors.reviews = page.nextCursor;
    state.reviewStatus = page.items.length
      ? `本页 ${page.items.length} 项待办；进入详情后重新读取当前事实。`
      : "当前页没有可审核的待办；刷新从第一页重新查询。";
  } catch (error) {
    if (state !== current || signal.aborted || !connected()) throw error;
    state.reviewStatus = `审核待办读取失败：${error.message}`;
    throw error;
  } finally {
    if (state === current) {
      if (signal.aborted && connected()) state.reviewStatus = "读取已停止，请重新读取审核待办。";
      reviewQueue(state, handlers.readVersion);
    }
  }
}
const handlers = {
  inspection: (id) =>
    run(async (signal) => {
      state.inspections[id] = await api(`/v1/uploads/${id}/inspection`, { signal });
      display();
    }, "已查询检查事实；passed 格式不等于发布准入。"),
  cancel: (id) =>
    run(async (signal) => {
      const closed = await api(`/v1/uploads/${id}`, { method: "DELETE", signal });
      confirmUploadClosed(closed);
      await refreshWorkspace(signal);
    }, "上传已取消；服务器按终态清理对象。"),
  readVersion: (id) => run((signal) => readVersion(id, signal), "已读取版本。"),
  withdraw: (version) =>
    run(async (signal) => {
      if (!(await confirmWithdrawal())) return;
      signal.throwIfAborted();
      await api(`/v1/versions/${version.id}/withdraw`, {
        method: "POST",
        body: { revision: version.revision },
        signal,
      });
      await refreshWorkspace(signal);
      if (state.reviewed?.id === version.id) await readVersion(version.id, signal);
    }, "撤回操作结束；当前状态以列表为准。"),
  publish: (version) =>
    run(async (signal) => {
      await api(`/v1/versions/${version.id}/publish`, {
        method: "POST",
        body: { revision: version.revision },
        signal,
      });
      await refreshWorkspace(signal);
    }, "已收到服务器发布响应。"),
  managePublication: (id) =>
    run(async (signal) => {
      await distribution.manage(id, signal);
      element("publication-heading").scrollIntoView({ block: "start" });
    }, "已读取发布管理记录。"),
};

form(
  "identity-form",
  async (signal) => {
    const value = element("credential").value;
    element("credential").value = "";
    setCredential(value);
    state = empty();
    clearView(state);
    distribution.reset();
    resourceManagement.reset();
    try {
      const identity = await api("/v1/me", { signal });
      state.principal = identity.principal;
      await listResources(signal);
      element("session-state").textContent = `身份已验证 · ${identity.principal}`;
    } catch (error) {
      setCredential("");
      state = empty();
      clearView(state);
      distribution.reset();
      resourceManagement.reset();
      throw error;
    }
  },
  "身份已验证，目录来自 D1 当前授权。",
);
function clearIdentity() {
  job?.abort();
  job = null;
  setCredential("");
  state = empty();
  element("credential").value = "";
  element("confirmation").close("cancel");
  clearView(state);
  distribution.reset();
  resourceManagement.reset();
  element("naccount-login").hidden = !naccount;
  controls();
}
element("disconnect").addEventListener("click", async () => {
  if (naccount && connected()) {
    job?.abort();
    stopRequests();
    try {
      window.location.assign(await logoutSession());
    } catch (error) {
      notice(error.message, "error");
    }
    return;
  }
  clearIdentity();
  notice("身份和当前视图已清除；服务器数据未删除。");
});
element("stop").addEventListener("click", () => {
  job?.abort();
  stopRequests();
  controls();
  element("confirmation").close("cancel");
});
button("refresh-resources", (signal) => listResources(signal), "资源目录已刷新。");
button(
  "more-resources",
  (signal) => listResources(signal, state.cursors.resources),
  "已读取下一页资源。",
);
button("refresh-workspace", refreshWorkspace, "当前资源已刷新。");
button("refresh-reviews", (signal) => listReviews(signal), "已读取当前审核待办。");
button(
  "more-reviews",
  (signal) => listReviews(signal, state.cursors.reviews),
  "已读取下一页审核待办。",
);
for (const name of ["uploads", "versions"])
  button(
    `more-${name}`,
    async (signal) => {
      await list(name, signal, state.cursors[name]);
      display();
    },
    "已读取下一页。",
  );
form(
  "create-form",
  async (signal) => {
    const body = { kind: element("new-kind").value, title: element("new-title").value };
    const operation = operationKey("create", body);
    state.resource = await api("/v1/resources", {
      method: "POST",
      body,
      key: operation.key,
      signal,
    });
    completeOperation(operation);
    state.uploads = [];
    state.versions = [];
    state.inspections = {};
    state.cursors.uploads = null;
    state.cursors.versions = null;
    element("new-title").value = "";
    display();
    try {
      await listResources(signal);
      await refreshWorkspace(signal);
    } catch (error) {
      if (error.name !== "AbortError")
        error.message = `资源已创建；后续读取失败，请刷新，不必重新创建。${error.message}`;
      throw error;
    }
  },
  "资源已创建。",
);
form(
  "upload-form",
  async (signal) => {
    await uploadPackage(
      state.resource,
      element("package-file").files[0],
      element("inspection-policy").value,
      signal,
      (upload) => {
        state.uploads = [upload, ...state.uploads.filter((item) => item.id !== upload.id)].slice(
          0,
          20,
        );
        display();
        notice(`已保留上传 ID ${upload.id}；正在写入包体。`);
      },
    );
    element("package-file").value = "";
    await refreshWorkspace(signal);
  },
  "包体上传完成并申请检查；等待后台执行，可点击查询检查。",
);
form(
  "version-form",
  async (signal) => {
    await api(`/v1/resources/${state.resource.id}/versions`, {
      method: "POST",
      body: {
        label: element("version-label").value,
        uploadId: element("version-upload").value,
        resourceRevision: state.resource.revision,
      },
      signal,
    });
    await refreshWorkspace(signal);
  },
  "不可变版本已创建，等待独立审核。",
);
form(
  "read-version-form",
  (signal) => readVersion(element("review-id").value.trim(), signal),
  "已读取版本事实。",
);
form(
  "review-form",
  async (signal) => {
    const version = state.reviewed;
    if (!version) throw new Error("READ_VERSION_REQUIRED");
    await api(`/v1/versions/${version.id}/review`, {
      method: "POST",
      body: {
        revision: version.revision,
        decision: element("review-decision").value,
        reason: element("review-reason").value,
      },
      signal,
    });
    await readVersion(version.id, signal);
    state.reviews = state.reviews.filter((item) => item.id !== version.id);
    state.reviewStatus = "审核决定已记录，已移除当前待办；刷新可获取其他最新变化。";
    reviewQueue(state, handlers.readVersion);
  },
  "独立审核决定已记录；批准不自动开放发布。",
);
distribution = initDistribution({ run, button, form, refreshControls: controls });
resourceManagement = initResourceManagement({
  form,
  button,
  refreshControls: controls,
  async changed(signal, result) {
    const closed = result.state === "deleted";
    state.reviewed = null;
    element("review-id").value = "";
    element("review-detail").textContent = "资源已变更，请重新读取版本。";
    distribution.reset();
    state.resource = closed ? null : result;
    state.uploads = [];
    state.versions = [];
    state.inspections = {};
    state.cursors.uploads = null;
    state.cursors.versions = null;
    display();
    await listResources(signal);
    if (!closed) await refreshWorkspace(signal);
  },
});
controls();

async function restoreSession() {
  try {
    const response = await fetch("/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
    const session = await response.json();
    naccount = session.enabled === true;
    element("identity-form").hidden = naccount;
    element("naccount-login").hidden = !naccount || !!session.principal;
    element("identity-note").hidden = naccount;
    element("disconnect").textContent = naccount ? "退出登录" : "清除身份与当前视图";
    if (naccount && session.principal) {
      setSession(session.csrf);
      state.principal = session.principal;
      element("session-state").textContent = `已登录 · ${session.principal}`;
      await run((signal) => listResources(signal), "已登录。");
    }
    if (new URL(window.location.href).searchParams.get("auth") === "failed")
      notice("登录未完成，请重试。", "error");
    controls();
  } catch {
    notice("无法读取登录状态，请稍后重试。", "error");
  }
}
restoreSession();
