import { api, completeOperation, operationKey } from "./api.client.js";
import { confirmAction, element, facts } from "./render.client.js";

const bindingWarning =
  "此次修改会增加资源 revision，使既有版本绑定失效，并阻止对应的新下载。历史审核和文件保留；后续需要创建并审核新版本。";

/** 只持有当前资源的编辑和指定成员状态；身份/资源切换清除，不推断下载权限。 */
export function initResourceManagement({ form, button, refreshControls, changed }) {
  let current = null;
  let principal = "";
  let membership = null;
  function clearMember() {
    membership = null;
    facts("member-detail", "输入主体并查询目录读权限；此权限不允许上传、审核或下载包体。");
  }
  function show(resource, identity) {
    if (
      current?.id !== resource?.id ||
      current?.revision !== resource?.revision ||
      principal !== identity
    ) {
      element("resource-title").value = resource?.title ?? "";
      element("member-principal").value = "";
      clearMember();
    }
    current = resource;
    principal = identity;
  }
  function controls(busy, connected) {
    const disabled =
      busy || !connected || current?.state !== "draft" || current.owner !== principal;
    for (const id of ["resource-edit-form", "member-read-form"])
      for (const control of element(id).querySelectorAll("input,button"))
        control.disabled = disabled;
    element("resource-save").disabled =
      disabled || element("resource-title").value.trim() === current?.title;
    element("resource-close").disabled = disabled;
    element("member-grant").disabled = disabled || !membership || membership.active;
    element("member-revoke").disabled = disabled || !membership?.active;
  }
  function owned() {
    if (current?.state !== "draft" || current.owner !== principal)
      throw new Error("SELECT_OWNED_RESOURCE_REQUIRED");
    return current;
  }
  async function mutation(path, method, body, signal) {
    const operation = operationKey(`resource:${method}:${path}`, body);
    try {
      const result = await api(path, { method, body, signal, key: operation.key });
      completeOperation(operation);
      return result;
    } catch (error) {
      // 确定未写入的终态可释放键；网络/取消/503 仍保留原意图，绝不自动重试。
      if ([400, 404, 409].includes(error.status)) completeOperation(operation);
      throw error;
    }
  }
  form(
    "resource-edit-form",
    async (signal) => {
      const resource = owned();
      const title = element("resource-title").value.trim();
      if (!title || title.length > 200 || /\p{Cc}/u.test(title)) throw new Error("INVALID_TITLE");
      if (title === resource.title) return;
      if (!(await confirmAction("修改资源标题", bindingWarning, "确认修改"))) return;
      signal.throwIfAborted();
      const result = await mutation(
        `/v1/resources/${resource.id}`,
        "PATCH",
        { title, revision: resource.revision },
        signal,
      );
      await changed(signal, result);
    },
    "标题操作结束，当前版本绑定状态以刷新结果为准。",
  );
  button(
    "resource-close",
    async (signal) => {
      const resource = owned();
      if (
        !(await confirmAction(
          "关闭资源",
          "关闭后资源从活动目录消失，目录读成员解除，相关新下载停止；不可恢复。保留历史记录和文件，不物理清空数据。",
          "确认关闭资源",
        ))
      )
        return;
      signal.throwIfAborted();
      const result = await mutation(
        `/v1/resources/${resource.id}`,
        "DELETE",
        { revision: resource.revision },
        signal,
      );
      await changed(signal, result);
    },
    "资源关闭操作结束；历史数据保留。",
  );
  form(
    "member-read-form",
    async (signal) => {
      const resource = owned();
      const member = element("member-principal").value.trim();
      if (!/^[A-Za-z0-9:._@-]{1,200}$/.test(member)) throw new Error("INVALID_PRINCIPAL");
      if (member === principal) throw new Error("OWNER_MEMBERSHIP_IMMUTABLE");
      clearMember();
      membership = await api(`/v1/resources/${resource.id}/members/${encodeURIComponent(member)}`, {
        signal,
      });
      facts("member-detail", membership);
    },
    "已读取指定主体的当前目录读权限。",
  );
  async function changeMember(method, signal) {
    const resource = owned();
    const member = membership;
    if (!member || member.principal !== element("member-principal").value.trim())
      throw new Error("READ_DIRECTORY_MEMBER_REQUIRED");
    if (
      !(await confirmAction(
        method === "PUT" ? "授予目录读权限" : "撤销目录读权限",
        `${member.principal}：仅影响目录读取，不授予包体下载。${bindingWarning}`,
        "确认权限变更",
      ))
    )
      return;
    signal.throwIfAborted();
    const result = await mutation(
      `/v1/resources/${resource.id}/members/${encodeURIComponent(member.principal)}`,
      method,
      { revision: member.resourceRevision },
      signal,
    );
    await changed(signal, result);
  }
  button(
    "member-grant",
    (signal) => changeMember("PUT", signal),
    "目录授权操作结束，请查询当前权限。",
  );
  button(
    "member-revoke",
    (signal) => changeMember("DELETE", signal),
    "目录撤销操作结束，请查询当前权限。",
  );
  element("resource-title").addEventListener("input", refreshControls);
  element("member-principal").addEventListener("input", () => {
    clearMember();
    refreshControls();
  });
  return { show, controls, reset: () => show(null, "") };
}
