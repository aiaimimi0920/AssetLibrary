export const element = (id) => document.getElementById(id);
export function notice(message, tone = "info") {
  element("notice").textContent = message;
  element("notice").dataset.tone = tone;
}
export function facts(id, value) {
  element(id).textContent = JSON.stringify(value, null, 2);
}

/** 只恢复因临时禁用而丢失的焦点；用户已移到其他控件时不抢回焦点。 */
export function restoreFocus(previous) {
  const active = document.activeElement;
  const closedDialog = active?.closest?.("dialog")?.open === false;
  if ((active === document.body || closedDialog) && previous?.isConnected && !previous.disabled)
    previous.focus();
}

export function text(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}
export function action(label, handler, className = "", protectedAction = true) {
  const button = text("button", label, className);
  button.type = "button";
  if (protectedAction) button.dataset.protected = "";
  else button.dataset.public = "";
  button.addEventListener("click", handler);
  return button;
}
export function resources(state, select) {
  const container = element("resources");
  container.replaceChildren();
  if (!state.resources.length) container.append(text("p", "没有可读的活动资源。", "muted"));
  for (const resource of state.resources) {
    const button = action(
      `${resource.title} · ${resource.owner === state.principal ? "owner" : "只读成员"}`,
      () => select(resource.id),
      "resource-row",
    );
    button.setAttribute("aria-current", String(resource.id === state.resource?.id));
    container.append(button);
  }
}

export function workspace(state, handlers) {
  const resource = state.resource;
  const owned = resource?.owner === state.principal;
  element("resource-state").textContent = resource
    ? `${resource.title} · revision ${resource.revision}`
    : "未选择";
  facts("resource-detail", resource ?? "请选择左侧资源。");
  element("uploads").replaceChildren();
  element("versions").replaceChildren();
  element("version-upload").replaceChildren();
  if (!resource) return;
  if (!owned) {
    element("uploads").append(
      text("p", "当前是目录只读成员，不能读取隔离上传或管理版本。", "muted"),
    );
    return;
  }
  if (!state.uploads.length) element("uploads").append(text("p", "尚无上传。", "muted"));
  for (const upload of state.uploads) {
    const row = text("div", "", "row");
    row.append(text("p", `${upload.id} · ${upload.state}`, "status"));
    row.append(text("p", `${upload.size} bytes · SHA-256 ${upload.sha256}`, "muted"));
    if (state.inspections[upload.id])
      row.append(text("p", `检查：${JSON.stringify(state.inspections[upload.id])}`, "muted"));
    const toolbar = text("div", "", "toolbar");
    toolbar.append(action("查询检查", () => handlers.inspection(upload.id)));
    if (["pending", "quarantined"].includes(upload.state))
      toolbar.append(action("取消上传", () => handlers.cancel(upload.id), "danger"));
    row.append(toolbar);
    element("uploads").append(row);
    if (upload.state === "quarantined") {
      const option = text("option", upload.id);
      option.value = upload.id;
      element("version-upload").append(option);
    }
  }
  if (!state.versions.length)
    element("versions").append(text("p", "尚无版本；创建前必须有当前 passed 检查。", "muted"));
  for (const version of state.versions) {
    const row = text("div", "", "row");
    row.append(
      text("p", `${version.label} · ${version.state} · revision ${version.revision}`, "status"),
    );
    row.append(text("p", `版本 ID：${version.id}`));
    row.append(text("p", `当前发布阻断：${version.publicationBlockers.join(" / ")}`, "muted"));
    const toolbar = text("div", "", "toolbar");
    toolbar.append(action("查看版本", () => handlers.readVersion(version.id)));
    if (version.state !== "withdrawn")
      toolbar.append(action("撤回版本", () => handlers.withdraw(version), "danger"));
    if (version.state === "approved")
      toolbar.append(action("请求发布（当前未准入）", () => handlers.publish(version)));
    if (version.publication)
      toolbar.append(
        action(`管理发布 · ${version.publication.state}`, () =>
          handlers.managePublication(version.publication.id),
        ),
      );
    row.append(toolbar);
    element("versions").append(row);
  }
}

export function reviewQueue(state, select) {
  const container = element("reviews");
  container.replaceChildren();
  element("reviews-state").textContent = state.reviewStatus;
  for (const version of state.reviews) {
    const row = text("div", "", "row");
    row.append(text("p", `${version.snapshot.title} · ${version.label}`, "status"));
    row.append(text("p", `提交者：${version.owner} · 版本 ID：${version.id}`, "muted"));
    row.append(
      text(
        "p",
        version.bindingCurrent ? "待独立审核" : "绑定已变化，不能批准，可查看后拒绝",
        "muted",
      ),
    );
    row.append(action("查看并审核", () => select(version.id)));
    container.append(row);
  }
}

export function clearView(state) {
  resources(state, () => {});
  workspace(state, {});
  reviewQueue(state, () => {});
  element("session-state").textContent = "未连接身份";
  element("new-title").value = "";
  element("review-id").value = "";
  element("review-reason").value = "";
  element("package-file").value = "";
  element("review-detail").textContent = "尚未读取版本。";
}

export async function confirmWithdrawal() {
  return confirmAction(
    "确认撤回",
    "此操作将关闭该版本，标签不能重用，历史审核会保留。",
    "确认撤回",
  );
}

export async function confirmAction(title, description, label) {
  const dialog = element("confirmation");
  element("confirmation-title").textContent = title;
  element("confirmation-description").textContent = description;
  element("confirmation-submit").textContent = label;
  const focused = document.activeElement;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => {
        restoreFocus(focused);
        resolve(dialog.returnValue === "confirm");
      },
      { once: true },
    ),
  );
}
