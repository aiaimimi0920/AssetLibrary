import assert from "node:assert/strict";
import test from "node:test";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { put, sha256 } from "./upload-fixture.mjs";
import { review, reviewerConfig } from "./version-fixture.mjs";

async function publishForOwner(f, principal, title) {
  const bytes = packageBytes();
  const res = await f.request("POST", "/v1/resources", { kind: "art", title }, { principal });
  assert.equal(res.status, 201);
  const reserved = await f.request(
    "POST",
    `/v1/resources/${res.body.id}/uploads`,
    { size: bytes.length, sha256: sha256(bytes) },
    { principal },
  );
  assert.equal(reserved.status, 201);
  assert.equal((await put(f, reserved.body, bytes, { principal })).status, 200);
  assert.equal(
    (await f.request("POST", `/v1/uploads/${reserved.body.id}/complete`, {}, { principal })).status,
    200,
  );
  assert.equal(
    (await startPackage(f, reserved.body, "art-zip-manifest-v1", { principal })).status,
    201,
  );
  await runScanner(f, {
    fetch() {
      throw new Error("SCANNER_MUST_NOT_RUN");
    },
  });
  const version = await f.request(
    "POST",
    `/v1/resources/${res.body.id}/versions`,
    { label: "1.0.0", uploadId: reserved.body.id, resourceRevision: 1 },
    { principal },
  );
  assert.equal(version.status, 201);
  const approved = await review(f, version.body);
  const pub = await f.request(
    "POST",
    `/v1/versions/${version.body.id}/publish`,
    { revision: approved.body.revision },
    { principal },
  );
  assert.equal(pub.status, 201);
  return pub.body;
}

const validRequest = {
  title: "  像素经营游戏的背包与制作界面  ",
  category: "images",
  style: "pixel",
  space: "general",
  formats: ["aseprite", "PNG"],
  license: "commercial",
  periodDays: 10,
  budgetNote: "  开源共创 / 面议  ",
  description: "背包、道具槽位和制作面板\r\n需要支持九宫格缩放。",
  delivery: "分层源文件、透明 PNG 与配色说明",
};

test("求购广场：创建幂等、公开匿名脱敏、筛选分页、方案权限隔离与关闭终态", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    assert.equal(
      (await f.request("POST", "/v1/asset-requests", validRequest, { token: null })).status,
      401,
    );
    for (const bad of [
      { ...validRequest, title: "" },
      { ...validRequest, category: "general" },
      { ...validRequest, formats: [] },
      { ...validRequest, license: "unspecified" },
      { ...validRequest, periodDays: 0 },
      { ...validRequest, periodDays: 181 },
      { ...validRequest, budgetNote: "x".repeat(81) },
      { ...validRequest, description: "" },
      { ...validRequest, delivery: "" },
      { ...validRequest, extraField: true },
    ]) {
      assert.equal((await f.request("POST", "/v1/asset-requests", bad)).status, 400);
    }

    const createKey = "req-create-key-001";
    const created = await f.request("POST", "/v1/asset-requests", validRequest, { key: createKey });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.requester, "user:alice");
    assert.equal(created.body.title, "像素经营游戏的背包与制作界面");
    assert.deepEqual(created.body.formats, ["ASEPRITE", "PNG"]);
    assert.equal(created.body.budgetNote, "开源共创 / 面议");
    assert.equal(created.body.state, "open");
    assert.equal(created.body.revision, 1);

    const replayCreate = await f.request("POST", "/v1/asset-requests", validRequest, {
      key: createKey,
    });
    assert.deepEqual(replayCreate.body, created.body);
    assert.equal(
      (
        await f.request(
          "POST",
          "/v1/asset-requests",
          { ...validRequest, periodDays: 14 },
          { key: createKey },
        )
      ).status,
      409,
    );

    // 公开查询不暴露原始 PrincipalRef（requester）或内部 revision。
    const publicList = await f.request(
      "GET",
      "/v1/asset-requests?category=images&format=ASEPRITE&q=%E4%B9%9D%E5%AE%AB%E6%A0%BC",
      undefined,
      { token: null },
    );
    assert.equal(publicList.status, 200);
    assert.equal(publicList.body.items.length, 1);
    assert.equal("requester" in publicList.body.items[0], false);
    assert.equal("revision" in publicList.body.items[0], false);

    const publicDetail = await f.request(
      "GET",
      `/v1/asset-requests/${created.body.id}`,
      undefined,
      { token: null },
    );
    assert.equal(publicDetail.status, 200);
    assert.equal("requester" in publicDetail.body, false);

    // 自响应拒绝；关联他人作品拒绝；关联本人已发布作品成功且幂等。
    const requestId = created.body.id;
    const selfResp = await f.request("POST", `/v1/asset-requests/${requestId}/responses`, {
      message: "自己响应自己",
      publicationId: null,
    });
    assert.equal(selfResp.status, 409);
    assert.equal(selfResp.body.error, "SELF_RESPONSE_FORBIDDEN");

    const alicePub = await publishForOwner(f, "user:alice", "Alice 自有素材");
    const foreignPubResp = await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/responses`,
      { message: "冒用他人发布作品", publicationId: alicePub.id },
      { principal: "user:bob" },
    );
    assert.equal(foreignPubResp.status, 409);
    assert.equal(foreignPubResp.body.error, "INVALID_RESPONSE_PUBLICATION");

    const bobPub = await publishForOwner(f, "user:bob", "Bob 像素 UI 套件");
    const respKey = "bob-response-key-1";
    const bobResp = await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/responses`,
      { message: "  可提供全套九宫格像素面板与源文件  ", publicationId: bobPub.id },
      { principal: "user:bob", key: respKey },
    );
    assert.equal(bobResp.status, 201, JSON.stringify(bobResp.body));
    assert.equal(bobResp.body.publicationId, bobPub.id);
    assert.equal(bobResp.body.publicationTitle, "Bob 像素 UI 套件");

    const replayResp = await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/responses`,
      { message: "可提供全套九宫格像素面板与源文件", publicationId: bobPub.id },
      { principal: "user:bob", key: respKey },
    );
    assert.deepEqual(replayResp.body, bobResp.body);

    // 同一响应者用新幂等键重复提交被拒绝
    const duplicateResp = await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/responses`,
      { message: "重复刷屏方案", publicationId: null },
      { principal: "user:bob" },
    );
    assert.equal(duplicateResp.status, 409);
    assert.equal(duplicateResp.body.error, "RESPONSE_ALREADY_SUBMITTED");

    await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/responses`,
      { message: "Carol 的替代手绘方案", publicationId: null },
      { principal: "user:carol" },
    );

    // 权限隔离：responder 只看到自己的方案，eve 看到 0 条，requester 看到全部 2 条。
    const bobView = await f.request("GET", `/v1/asset-requests/${requestId}/responses`, undefined, {
      principal: "user:bob",
    });
    assert.equal(bobView.body.viewerRole, "responder");
    assert.equal(bobView.body.items.length, 1);
    assert.equal(bobView.body.items[0].responder, "user:bob");

    const eveView = await f.request("GET", `/v1/asset-requests/${requestId}/responses`, undefined, {
      principal: "user:eve",
    });
    assert.equal(eveView.body.viewerRole, "responder");
    assert.deepEqual(eveView.body.items, []);

    const aliceView = await f.request("GET", `/v1/asset-requests/${requestId}/responses`);
    assert.equal(aliceView.body.viewerRole, "requester");
    assert.equal(aliceView.body.request.responseCount, 2);
    assert.equal(aliceView.body.items.length, 2);

    // 非 owner 不能关闭；owner 关闭后从公开列表移除、保留在 /v1/me/asset-requests，且拒绝新方案。
    assert.equal(
      (
        await f.request(
          "POST",
          `/v1/asset-requests/${requestId}/close`,
          { revision: 1 },
          { principal: "user:bob" },
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request("POST", `/v1/asset-requests/${requestId}/close`, { revision: 9 })).status,
      409,
    );
    const closeKey = "req-close-key-1";
    const closed = await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/close`,
      { revision: 1 },
      { key: closeKey },
    );
    assert.equal(closed.status, 200);
    assert.equal(closed.body.state, "closed");
    assert.equal(closed.body.revision, 2);
    assert.deepEqual(
      (
        await f.request(
          "POST",
          `/v1/asset-requests/${requestId}/close`,
          { revision: 1 },
          { key: closeKey },
        )
      ).body,
      closed.body,
    );

    assert.equal(
      (await f.request("GET", `/v1/asset-requests/${requestId}`, undefined, { token: null }))
        .status,
      404,
    );
    assert.equal(
      (await f.request("GET", "/v1/asset-requests", undefined, { token: null })).body.items.length,
      0,
    );
    const myRequests = await f.request("GET", "/v1/me/asset-requests");
    assert.equal(myRequests.body.items.length, 1);
    assert.equal(myRequests.body.items[0].state, "closed");

    const lateResp = await f.request(
      "POST",
      `/v1/asset-requests/${requestId}/responses`,
      { message: "关闭后迟到方案", publicationId: null },
      { principal: "user:dave" },
    );
    assert.equal(lateResp.status, 409);
    assert.equal(lateResp.body.error, "REQUEST_CLOSED");
  } finally {
    await f.dispose();
  }
});
