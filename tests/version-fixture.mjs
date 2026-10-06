import assert from "node:assert/strict";
import { prepared, read, start } from "./inspection-fixture.mjs";
import { tick } from "./upload-fixture.mjs";
import { hostWorker } from "./worker-fixture.mjs";

export const reviewerConfig = JSON.stringify(["user:reviewer", "user:reviewer2", "user:alice"]);

export async function checkedUpload(f) {
  const upload = await prepared(f);
  assert.equal((await start(f, upload)).status, 201);
  await tick(f);
  assert.equal((await read(f, upload)).body.state, "passed");
  return upload;
}
export async function creationBody(f, upload, changes = {}) {
  const resource = await f.request("GET", `/v1/resources/${upload.resourceId}`);
  assert.equal(resource.status, 200);
  return { label: "v1", uploadId: upload.id, resourceRevision: resource.body.revision, ...changes };
}
export async function createVersion(f, upload, body, options = {}) {
  return f.request(
    "POST",
    `/v1/resources/${upload.resourceId}/versions`,
    body ?? (await creationBody(f, upload)),
    options,
  );
}
export async function readyVersion(f) {
  const upload = await checkedUpload(f);
  const body = await creationBody(f, upload);
  const created = await createVersion(f, upload, body);
  assert.equal(created.status, 201);
  return { upload, body, version: created.body };
}
export async function readVersion(f, version, options = {}) {
  return f.request("GET", `/v1/versions/${version.id}`, undefined, options);
}
export async function review(f, version, body = {}, options = {}) {
  return f.request(
    "POST",
    `/v1/versions/${version.id}/review`,
    {
      revision: version.revision,
      decision: "approved",
      reason: "人工检查的测试决定",
      ...body,
    },
    { principal: "user:reviewer", ...options },
  );
}
export async function withdraw(f, version) {
  return f.request("POST", `/v1/versions/${version.id}/withdraw`, { revision: version.revision });
}
export async function events(f, version) {
  const result = await f.db
    .prepare(
      "SELECT actor, action, revision, reason FROM version_events WHERE version_id = ? ORDER BY revision",
    )
    .bind(version.id)
    .all();
  return result.results;
}

// 只在 Node 宿主装配相同生产 bundle 和真实本地 binding；不增加生产测试入口。
export async function callWithEnv(
  f,
  method,
  pathname,
  body,
  overrides = {},
  principal = "user:reviewer",
) {
  const worker = await hostWorker();
  const response = await worker.fetch(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${await f.token(principal)}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...f.env, ...overrides },
  );
  return { status: response.status, body: await response.json() };
}
export function heldBatch(f) {
  let observed;
  let release;
  const captured = new Promise((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const db = new Proxy(f.db, {
    get(target, name) {
      if (name === "batch")
        return async (statements) => {
          observed();
          await barrier;
          return target.batch(statements);
        };
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, captured, release: () => release() };
}
