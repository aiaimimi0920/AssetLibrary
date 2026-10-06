import assert from "node:assert/strict";
import path from "node:path";

export const nativeEnginePaths = [
  "/usr/bin/clamscan",
  "/usr/lib/libclamav.so.12",
  "/usr/lib/libfreshclam.so.4",
  "/usr/lib/libclamunrar.so",
  "/usr/lib/libclamunrar_iface.so",
];

function installedTarget(installed, name) {
  let current = name;
  const visited = new Set();
  for (let depth = 0; depth < 16; depth++) {
    assert(current.startsWith("/usr/") && !/[\\:\0]/.test(current), "NATIVE_INSTALL_PATH_INVALID");
    assert(!visited.has(current), "NATIVE_INSTALL_LINK_CYCLE");
    visited.add(current);
    const record = installed[current.slice(1)];
    assert(record && typeof record === "object", "NATIVE_INSTALL_TARGET_MISSING");
    if (!Object.hasOwn(record, "link")) {
      assert.match(record.sha256 ?? "", /^[0-9a-f]{64}$/, "NATIVE_INSTALL_DIGEST_INVALID");
      return current;
    }
    assert(
      typeof record.link === "string" &&
        record.link.length > 0 &&
        !/[\\:\0]/.test(record.link) &&
        !Object.hasOwn(record, "sha256"),
      "NATIVE_INSTALL_LINK_INVALID",
    );
    // 受控安装只生成同目录文件链接；拒绝中间路径组件，避免词法折叠冒充 POSIX realpath。
    const targetName = path.posix.basename(record.link);
    assert(
      targetName !== "." &&
        targetName !== ".." &&
        (record.link === targetName ||
          record.link === path.posix.join(path.posix.dirname(current), targetName)),
      "NATIVE_INSTALL_LINK_PATH_UNSUPPORTED",
    );
    current = path.posix.resolve(path.posix.dirname(current), record.link);
  }
  throw new Error("NATIVE_INSTALL_LINK_DEPTH_EXCEEDED");
}

/** 构建证明与候选运行共用同一身份边界，不允许任一入口只比较报告自选的终点摘要。 */
export function verifyInstalledEngine(installed, binaries) {
  for (const name of nativeEnginePaths) {
    const binary = binaries[name];
    assert(typeof binary?.path === "string", "NATIVE_PRODUCT_BINARY_MISSING");
    assert.match(binary.sha256, /^[0-9a-f]{64}$/, "NATIVE_PRODUCT_BINARY_DIGEST_INVALID");
    // 安装清单决定期望 realpath；不能由运行报告挑选另一个合法安装文件充当该引擎。
    assert.equal(
      binary.path,
      installedTarget(installed, name),
      "NATIVE_PRODUCT_BINARY_PATH_MISMATCH",
    );
    assert.equal(
      installed[binary.path.slice(1)]?.sha256,
      binary.sha256,
      `NATIVE_PRODUCT_BINARY_CHANGED:${name}`,
    );
  }
}
