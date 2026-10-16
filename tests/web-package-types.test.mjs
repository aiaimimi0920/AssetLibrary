import assert from "node:assert/strict";
import test from "node:test";
import { browserModules } from "./web-client-fixture.mjs";

test("三类资源只显示匹配策略；换资源/清除身份丢弃旧文件，刷新保留 Art 合法选择", async (t) => {
  const original = globalThis.document;
  t.after(() => {
    globalThis.document = original;
  });
  const nodes = new Map();
  const node = () => ({
    value: "",
    dataset: {},
    children: [],
    append(item) {
      this.children.push(item);
    },
    replaceChildren() {
      this.children = [];
    },
  });
  globalThis.document = {
    createElement: node,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
  };
  const { upload } = await browserModules();
  const art = { id: "art-a", kind: "art" };
  upload.syncUploadForm(art);
  const select = nodes.get("inspection-policy");
  const file = nodes.get("package-file");
  assert.equal(select.children.length, 3);
  assert.equal(select.children[2].value, "loom-art-zip-clamav-v1");
  select.value = "art-zip-manifest-v1";
  file.value = "old.zip";
  upload.syncUploadForm(art);
  assert.equal(select.value, "art-zip-manifest-v1");
  assert.equal(file.value, "old.zip");
  for (const kind of ["capability", "application"]) {
    upload.syncUploadForm({ id: kind, kind });
    assert.deepEqual(
      select.children.map((o) => o.value),
      kind === "capability"
        ? ["capability-zip-clamav-v1", "loom-capability-zip-clamav-v1"]
        : ["application-zip-clamav-v1"],
    );
    assert.equal(file.value, "");
    assert.match(
      nodes.get("package-label").textContent,
      kind === "capability" ? /Loom 原生包/ : /pack:software/,
    );
    file.value = "old.zip";
  }
  upload.syncUploadForm(null);
  assert.equal(file.value, "");
  assert.equal(select.children.length, 0);
  assert.deepEqual(upload.packagePolicies("__proto__"), []);
});

test("上传前拒绝类型/策略失配与非 ZIP/超大文件，不读取文件、不预约或上传", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = () => {
    throw new Error("UNEXPECTED_NETWORK");
  };
  const { api, upload } = await browserModules();
  api.setCredential("synthetic-token");
  for (const [kind, policy] of [
    ["art", "capability-zip-clamav-v1"],
    ["capability", "art-zip-clamav-v1"],
    ["application", "capability-zip-clamav-v1"],
    ["unknown", "art-zip-manifest-v1"],
    ["application", "loom-capability-zip-clamav-v1"],
    ["art", "loom-capability-zip-clamav-v1"],
    ["capability", "loom-art-zip-clamav-v1"],
  ]) {
    await assert.rejects(
      upload.uploadPackage({ id: "r", kind }, null, policy, new AbortController().signal, () => {}),
      /RESOURCE_INSPECTION_POLICY_MISMATCH/,
    );
  }
  for (const file of [undefined, { name: "bad.js", size: 1 }, { name: "big.zip", size: 8388609 }])
    await assert.rejects(
      upload.uploadPackage(
        { id: "r", kind: "capability" },
        file,
        "capability-zip-clamav-v1",
        new AbortController().signal,
        () => {},
      ),
      /PACKAGE_ZIP_REQUIRED_MAX_8_MIB/,
    );
});

for (const [kind, policy] of [
  ["art", "art-zip-clamav-v1"],
  ["capability", "capability-zip-clamav-v1"],
  ["application", "application-zip-clamav-v1"],
  ["art", "loom-art-zip-clamav-v1"],
  ["capability", "loom-capability-zip-clamav-v1"],
])
  test(`${policy} 浏览器上传原 File，完成后申请对应策略，不增加生产旁路`, async (t) => {
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    const { api, upload } = await browserModules();
    api.setCredential("synthetic-token");
    const file = new File(["test bytes"], "input.zip");
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, ...options });
      return Response.json(
        url.endsWith("/uploads") ? { id: "upload", contentUrl: "/v1/uploads/upload/content" } : {},
      );
    };
    let reserved;
    await upload.uploadPackage(
      { id: "r", kind },
      file,
      policy,
      new AbortController().signal,
      (row) => {
        reserved = row.id;
      },
    );
    assert.equal(reserved, "upload");
    assert.equal(calls.length, 4);
    assert.equal(calls[1].body, file);
    assert.equal(calls[2].url, "/v1/uploads/upload/complete");
    assert.deepEqual(JSON.parse(calls[3].body), { policy });
  });
