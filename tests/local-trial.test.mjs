import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { replaceOnce } from "../scripts/trial/bundle.mjs";
import { createTrialRuntime } from "../scripts/trial/runtime.mjs";
import { serveTrial } from "../scripts/trial/server.mjs";
import { readPackage } from "../src/web/download.client.js";
import { fixture } from "./fixture.mjs";

let runtime;
let server;
let stopRequests = 0;
const tokens = new Map();
before(async () => {
  runtime = await createTrialRuntime(path.dirname(process.env.ASSETLIBRARY_BUNDLE));
  server = await serveTrial(runtime, {
    onStop: () => {
      stopRequests++;
    },
  });
  for (const number of ["10001", "10002", "10003", "10004"]) {
    const response = await local("login", { number });
    assert.equal(response.status, 200);
    tokens.set(number, (await response.json()).token);
  }
});
after(async () => {
  await server?.close();
  await runtime?.dispose();
});
function local(action, body) {
  return fetch(`${server.origin}/__trial/${action}`, {
    method: "POST",
    headers: {
      origin: server.origin,
      "content-type": "application/json",
      "x-assetlibrary-trial": "1",
    },
    body: JSON.stringify(body),
  });
}
async function api(method, route, body, number = "10001", extra = {}) {
  const response = await fetch(`${server.origin}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens.get(number)}`,
      "idempotency-key": randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("虚构编号通过原 RS256 验证；本地入口拒绝任意主体、外站、DNS rebinding 和内部控制路径", async () => {
  assert.deepEqual((await api("GET", "/v1/me")).body, { principal: "trial:10001" });
  assert.equal((await local("login", { number: "99999" })).status, 400);
  assert.equal((await local("login", { number: "10001", admin: true })).status, 400);
  assert.equal((await local("tick", [])).status, 400);
  assert.equal((await fetch(`${server.origin}/__trial/stop`)).status, 403);
  assert.equal(stopRequests, 0);
  for (const headers of [{ origin: "https://foreign.invalid" }, { "sec-fetch-site": "cross-site" }])
    assert.equal(
      (await fetch(`${server.origin}/`, { headers })).status,
      403,
      JSON.stringify(headers),
    );
  const rebinding = await new Promise((resolve, reject) => {
    http
      .get(server.origin, { headers: { host: "foreign.invalid" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      })
      .on("error", reject);
  });
  assert.equal(rebinding, 403);
  assert.equal((await fetch(`${server.origin}/__trial/login`)).status, 403);
  assert.equal((await fetch(`${server.origin}/cdn-cgi/local/scheduled`)).status, 404);
  assert.equal((await fetch(`${server.origin}/v1/me`)).status, 401);
  const page = await (await fetch(server.origin)).text();
  assert.match(page, /本地全流程体验 · 非生产环境/);
  assert.match(page, /虚构体验编号/);
  assert.match(page, /合成 AV/);
  assert.match(page, /id="credential" hidden/);
  assert.match(page, /__trial\/sample.zip/);
});

test("从空库经 HTTP 完整上传、实际格式检查、独立审核、发布、字节下载、撤销及下架", async () => {
  const bytes = Buffer.from(
    await (await fetch(`${server.origin}/__trial/sample.zip`)).arrayBuffer(),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const created = await api("POST", "/v1/resources", { kind: "art", title: "本地体验完整闭环" });
  assert.equal(created.status, 201);
  const resource = created.body;
  const reserved = await api("POST", `/v1/resources/${resource.id}/uploads`, {
    size: bytes.length,
    sha256,
  });
  assert.equal(reserved.status, 201);
  const upload = reserved.body;
  const put = await fetch(`${server.origin}/v1/uploads/${upload.id}/content`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${tokens.get("10001")}`,
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  assert.equal(put.status, 200, await put.text());
  assert.equal((await api("POST", `/v1/uploads/${upload.id}/complete`, {})).status, 200);
  assert.equal(
    (await api("POST", `/v1/uploads/${upload.id}/inspection`, { policy: "art-zip-clamav-v1" }))
      .status,
    201,
  );
  assert.equal((await local("tick", {})).status, 200);
  const checked = await api("GET", `/v1/uploads/${upload.id}/inspection`);
  assert.equal(checked.body.state, "passed", JSON.stringify(checked.body));
  const version = await api("POST", `/v1/resources/${resource.id}/versions`, {
    label: "v1",
    uploadId: upload.id,
    resourceRevision: 1,
  });
  assert.equal(version.status, 201);
  const id = version.body.id;
  assert.equal((await api("POST", `/v1/versions/${id}/publish`, { revision: 1 })).status, 409);
  assert.equal(
    (
      await api("POST", `/v1/versions/${id}/review`, {
        revision: 1,
        decision: "approved",
        reason: "拒绝自审",
      })
    ).status,
    404,
  );
  const review = await api(
    "POST",
    `/v1/versions/${id}/review`,
    { revision: 1, decision: "approved", reason: "本地虚构身份独立审核" },
    "10002",
  );
  assert.equal(review.status, 200);
  const published = await api("POST", `/v1/versions/${id}/publish`, {
    revision: review.body.revision,
  });
  assert.equal(published.status, 201, JSON.stringify(published));
  const publication = published.body;
  const route = `/v1/publications/${publication.id}`;
  assert.equal((await api("POST", `${route}/tickets`, {}, "10003")).status, 404);
  assert.equal(
    (await api("PUT", `${route}/grants/trial:10003`, { revision: 0 }, "10004")).status,
    404,
  );
  const granted = await api("PUT", `${route}/grants/trial:10003`, { revision: 0 });
  assert.equal(granted.status, 200);
  const catalog = await api("GET", "/v1/catalog");
  assert.ok(catalog.body.items.some((item) => item.id === publication.id));
  const ticket = await api("POST", `${route}/tickets`, {}, "10003");
  assert.equal(ticket.status, 201);
  const headers = {
    authorization: `Bearer ${tokens.get("10003")}`,
    "x-download-ticket": ticket.body.ticket,
  };
  const content = await fetch(`${server.origin}${route}/content`, { headers });
  assert.equal(content.status, 200);
  // 使用真实 HTTP 响应驱动实际浏览器解码器，不用 Node Response 的 header 掩盖 workerd 传输。
  const saved = await readPackage(content, new AbortController().signal, publication);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes);
  const range = await fetch(`${server.origin}${route}/content`, {
    headers: { ...headers, range: "bytes=0-15" },
  });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 16));
  assert.equal(
    (await api("DELETE", `${route}/grants/trial:10003`, { revision: granted.body.revision }))
      .status,
    200,
  );
  const revoked = await fetch(`${server.origin}${route}/content`, {
    headers: { ...headers, range: "bytes=16-" },
  });
  assert.equal(revoked.status, 404);
  await revoked.arrayBuffer();
  assert.equal((await api("POST", `${route}/tickets`, {}, "10003")).status, 404);
  assert.equal(
    (await api("POST", `${route}/unlist`, { revision: publication.revision })).status,
    200,
  );
  assert.equal((await api("POST", `${route}/tickets`, {})).status, 404);
  assert.equal((await api("GET", `/v1/catalog/${publication.id}`)).status, 404);
});

test("模拟 AV 不允许畸形 ZIP 发布；仍由真实格式检查失败关闭", async () => {
  const bytes = Buffer.from("not a ZIP");
  const resource = (await api("POST", "/v1/resources", { kind: "art", title: "畸形包对照" })).body;
  const upload = (
    await api("POST", `/v1/resources/${resource.id}/uploads`, {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  ).body;
  const response = await fetch(`${server.origin}/v1/uploads/${upload.id}/content`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${tokens.get("10001")}`,
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await api("POST", `/v1/uploads/${upload.id}/complete`, {});
  await api("POST", `/v1/uploads/${upload.id}/inspection`, { policy: "art-zip-clamav-v1" });
  await local("tick", {});
  assert.equal((await api("GET", `/v1/uploads/${upload.id}/inspection`)).body.state, "rejected");
  assert.equal(
    (
      await api("POST", `/v1/resources/${resource.id}/versions`, {
        label: "v1",
        uploadId: upload.id,
        resourceRevision: 1,
      })
    ).status,
    409,
  );
});

test("普通候选字节不变且拒绝体验 token/登录/发布准入；内存变换严格单点", async () => {
  const bytes = await readFile(process.env.ASSETLIBRARY_BUNDLE);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), runtime.sourceHash);
  assert.match(bytes.toString(), /throw new HttpError\(409, cloudScanBlocker\)/);
  assert.doesNotMatch(bytes.toString(), /LOCAL TRIAL ONLY|__trial\/login|trial:10001/);
  assert.throws(() => replaceOnce("x x", "x", "y"), /TRIAL_SOURCE_CONTRACT_CHANGED/);
  const production = await fixture();
  try {
    assert.equal(
      (await production.request("GET", "/v1/me", undefined, { token: tokens.get("10001") })).status,
      401,
    );
    const catalog = await production.request("GET", "/v1/catalog");
    assert.equal(catalog.status, 503);
    assert.equal(catalog.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
    assert.equal((await production.mf.dispatchFetch("http://localhost/__trial/login")).status, 401);
    assert.doesNotMatch(
      await (await production.mf.dispatchFetch("http://localhost/")).text(),
      /虚构体验编号|__trial/,
    );
  } finally {
    await production.dispose();
  }
});

test("只有同源显式停止请求触发所属服务收尾，不通过 GET 停止或清空数据", async () => {
  assert.equal((await local("stop", {})).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopRequests, 1);
  assert.ok(
    (await runtime.db.prepare("SELECT COUNT(*) AS count FROM resources").first()).count >= 2,
  );
});
