import assert from "node:assert/strict";

export const imagePackages = [
  "libxml2-2.13.9-r2",
  "nodejs-24.18.1-r0",
  "pcre2-10.49-r0",
  "nghttp2-libs-1.70.0-r0",
];
const binaryPaths = [
  "/usr/bin/node",
  "/usr/bin/clamscan",
  "/usr/lib/libclamav.so.12",
  "/usr/lib/libxml2.so.2",
];

/** 从所属的只读、无网络容器读回实际二进制和 APK 清单，不以 Dockerfile 声明代替运行证据。 */
export async function inspectImageEnvironment(docker, name) {
  const probe = `import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const binaries={};
for (const name of ${JSON.stringify(binaryPaths)}) {
  binaries[name]={path:await realpath(name),sha256:createHash('sha256').update(await readFile(name)).digest('hex')};
}
console.log(JSON.stringify({osRelease:await readFile('/etc/os-release','utf8'),node:process.versions.node,binaries}));`;
  const environment = JSON.parse(
    await docker(["exec", name, "node", "--input-type=module", "--eval", probe]),
  );
  environment.packages = (await docker(["exec", name, "apk", "--no-network", "info", "-v"]))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  environment.linkedLibraries = await docker(["exec", name, "ldd", "/usr/bin/clamscan"]);
  validateImageEnvironment(environment);
  return environment;
}

export function validateImageEnvironment(environment) {
  assert(environment, "IMAGE_ENVIRONMENT_MISSING");
  assert.match(environment.osRelease, /^ID=alpine$/m, "IMAGE_OS_MISMATCH");
  assert.match(environment.osRelease, /^VERSION_ID=3\.24\.2$/m, "IMAGE_OS_VERSION_MISMATCH");
  assert.equal(environment.node, "24.18.1", "IMAGE_NODE_MISMATCH");
  assert(
    Array.isArray(environment.packages) && environment.packages.length > 0,
    "APK_INVENTORY_MISSING",
  );
  assert.equal(
    new Set(environment.packages).size,
    environment.packages.length,
    "APK_INVENTORY_DUPLICATED",
  );
  for (const name of imagePackages)
    assert(environment.packages.includes(name), `IMAGE_PACKAGE_MISMATCH:${name}`);
  assert.match(
    environment.linkedLibraries,
    /libxml2\.so\.2 => \/usr\/lib\/libxml2\.so\.2(?:\s|$)/,
    "IMAGE_LIBXML2_LINK_MISMATCH",
  );
  assert(
    !/not found|Error loading|Error relocating/.test(environment.linkedLibraries),
    "IMAGE_LINK_FAILURE",
  );
  for (const name of binaryPaths) {
    assert.match(
      environment.binaries?.[name]?.sha256 ?? "",
      /^[0-9a-f]{64}$/,
      `IMAGE_BINARY_MISSING:${name}`,
    );
    assert(environment.binaries[name].path.startsWith("/usr/"), "IMAGE_BINARY_PATH_INVALID");
  }
}

/** 全量 APK 身份逐项匹配，防止新发行版未被扫描器识别时把空报告当成零漏洞。 */
export function verifyImageCoverage(report, environment) {
  validateImageEnvironment(environment);
  assert.equal(report.Metadata?.OS?.Family, "alpine", "SCANNED_OS_MISMATCH");
  assert.equal(report.Metadata.OS.Name, "3.24.2", "SCANNED_OS_VERSION_MISMATCH");
  assert.notEqual(report.Metadata.OS.Eosl, true, "SCANNED_OS_UNSUPPORTED");
  const results = report.Results?.filter(
    (result) => result.Class === "os-pkgs" && result.Type === "alpine",
  );
  assert.equal(results?.length, 1, "OS_INVENTORY_MISSING");
  assert(
    Array.isArray(results[0].Packages) && results[0].Packages.length > 0,
    "OS_INVENTORY_EMPTY",
  );
  const packages = results[0].Packages.map((pkg) => {
    assert(typeof pkg.Name === "string" && typeof pkg.Version === "string", "OS_PACKAGE_INVALID");
    return `${pkg.Name}-${pkg.Version}`;
  }).sort();
  assert.deepEqual(packages, [...environment.packages].sort(), "OS_INVENTORY_MISMATCH");
  return {
    os: "alpine",
    version: "3.24.2",
    packages: packages.length,
    runtimeInventoryMatched: true,
  };
}
