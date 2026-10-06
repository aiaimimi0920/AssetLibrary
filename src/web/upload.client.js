import {
  api,
  bindOperation,
  completeOperation,
  operationKey,
  resolveOperation,
} from "./api.client.js";

export function packagePolicies(kind) {
  if (kind === "art")
    return [
      ["art-zip-clamav-v1", "格式 + ClamAV 内容检查"],
      ["art-zip-manifest-v1", "仅格式检查（不可发布）"],
    ];
  if (["capability", "application"].includes(kind))
    return [[`${kind}-zip-clamav-v1`, "包体 + ClamAV 内容检查"]];
  return [];
}

/** 资源或身份切换后清除文件，避免将上一资源的包误传；刷新同一资源保留合法选择。 */
export function syncUploadForm(resource) {
  const select = document.getElementById("inspection-policy");
  const binding = resource ? `${resource.id}:${resource.kind}` : "";
  if (select.dataset.resource === binding) return;
  select.dataset.resource = binding;
  select.replaceChildren();
  for (const [value, label] of packagePolicies(resource?.kind)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  document.getElementById("package-file").value = "";
  document.getElementById("package-label").textContent =
    resource?.kind === "art"
      ? "Art ZIP（1–32 张静态 PNG，最多 8 MiB；使用 pack:art）"
      : ["capability", "application"].includes(resource?.kind)
        ? `${resource.kind === "capability" ? "Capability" : "应用包"} ZIP（1–32 个载荷，每个最多 1 MiB，整包最多 8 MiB；使用 pack:software）`
        : "请选择资源后上传匹配类型的 ZIP。";
}

/** 仅已绑定 ID 的不可逆终态可释放意图，不能按摘要猜测未知预约或历史记录。 */
export function confirmUploadClosed(upload) {
  if (!["cancelled", "expired", "rejected", "missing"].includes(upload?.state)) return;
  resolveOperation(
    `upload:${upload.resourceId}`,
    { size: upload.size, sha256: upload.sha256 },
    upload.id,
  );
}

/** 只对有界的本地文件计算摘要；上传使用 File 本体，不复制进 JSON/base64。 */
export async function uploadPackage(resource, file, policy, signal, reserved) {
  if (!resource) throw new Error("SELECT_RESOURCE_REQUIRED");
  if (!packagePolicies(resource.kind).some(([value]) => value === policy))
    throw new Error("RESOURCE_INSPECTION_POLICY_MISMATCH");
  if (
    !file ||
    file.size < 1 ||
    file.size > 8 * 1024 * 1024 ||
    !file.name.toLowerCase().endsWith(".zip")
  )
    throw new Error("PACKAGE_ZIP_REQUIRED_MAX_8_MIB");
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  signal.throwIfAborted();
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const body = { size: file.size, sha256 };
  const operation = operationKey(`upload:${resource.id}`, body);
  const upload = await api(`/v1/resources/${resource.id}/uploads`, {
    method: "POST",
    body,
    key: operation.key,
    signal,
  });
  // 在流式写入前暴露已创建的 ID，失败后可查询/取消，不把未知写入当作已回滚。
  bindOperation(operation, upload.id);
  reserved(upload);
  await api(upload.contentUrl, { method: "PUT", body: file, raw: true, signal });
  await api(`/v1/uploads/${upload.id}/complete`, { method: "POST", body: {}, signal });
  await api(`/v1/uploads/${upload.id}/inspection`, { method: "POST", body: { policy }, signal });
  completeOperation(operation);
  return upload;
}
