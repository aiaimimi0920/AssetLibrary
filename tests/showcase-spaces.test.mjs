import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { png } from "./inspection-fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { softwareBytes } from "./software-package-fixture.mjs";
import { complete, put, sha256 } from "./upload-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

async function uploadToResource(f, resourceId, bytes) {
  const reserved = await f.request("POST", `/v1/resources/${resourceId}/uploads`, {
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(reserved.status, 201, JSON.stringify(reserved.body));
  assert.equal((await put(f, reserved.body, bytes)).status, 200);
  assert.equal((await complete(f, reserved.body)).status, 200);
  return reserved.body;
}

async function rawCover(f, resourceId, revision, bytes) {
  return f.mf.dispatchFetch(
    `http://localhost/v1/resources/${resourceId}/cover?revision=${revision}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await f.token()}`,
        "content-type": "image/png",
        "idempotency-key": randomUUID(),
      },
      body: bytes,
    },
  );
}

function loomMcpBytes() {
  return artZip(
    [
      {
        path: "mcp.server.json",
        bytes: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            id: "loom-echo",
            version: "1.0.0",
            publisher: { id: "neuro" },
            transport: "stdio",
            entry: { command: "runtime/main.py" },
          }),
        ),
      },
      { path: "runtime/main.py", bytes: Buffer.from("fixture") },
    ],
    8,
  );
}

test("应用内容空间聚合、封面公开读取与审核后变更/下架即时失效", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const mismatchRes = (
      await f.request("POST", "/v1/resources", { kind: "mcp", title: "空间冲突测试" })
    ).body;
    await f.request("PUT", `/v1/resources/${mismatchRes.id}/profile`, {
      revision: 1,
      space: "otter",
      summary: "错误空间",
      detail: "",
    });
    const mismatchUpload = await uploadToResource(f, mismatchRes.id, loomMcpBytes());
    assert.equal((await startPackage(f, mismatchUpload, "loom-mcp-zip-format-v1")).status, 201);
    await runScanner(f, {
      fetch() {
        throw new Error("SCANNER_MUST_NOT_RUN");
      },
    });
    const mismatchVer = await f.request("POST", `/v1/resources/${mismatchRes.id}/versions`, {
      label: "1.0.0",
      uploadId: mismatchUpload.id,
      resourceRevision: 2,
    });
    assert.equal(mismatchVer.status, 409);
    assert.equal(mismatchVer.body.error, "SPACE_POLICY_MISMATCH");

    async function publishConfigured({
      kind,
      title,
      space,
      summary,
      detail,
      cover,
      policy,
      bytes,
    }) {
      const created = (await f.request("POST", "/v1/resources", { kind, title })).body;
      let rev = created.revision;
      if (space) {
        const prof = await f.request("PUT", `/v1/resources/${created.id}/profile`, {
          revision: rev,
          space,
          summary,
          detail,
        });
        assert.equal(prof.status, 200);
        rev = prof.body.revision;
      }
      if (cover) {
        const res = await rawCover(f, created.id, rev, cover);
        assert.equal(res.status, 200);
        rev = (await res.json()).revision;
      }
      const upload = await uploadToResource(f, created.id, bytes);
      assert.equal((await startPackage(f, upload, policy)).status, 201);
      await runScanner(f, {
        fetch() {
          throw new Error("SCANNER_MUST_NOT_RUN");
        },
      });
      const version = await createVersion(f, upload);
      assert.equal(version.status, 201, JSON.stringify(version.body));
      if (cover) {
        assert.equal(
          (await f.mf.dispatchFetch(`http://localhost/v1/versions/${version.body.id}/cover`))
            .status,
          401,
        );
        assert.equal(
          (
            await f.mf.dispatchFetch(`http://localhost/v1/versions/${version.body.id}/cover`, {
              headers: { authorization: `Bearer ${await f.token("user:reviewer")}` },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await f.mf.dispatchFetch(`http://localhost/v1/versions/${version.body.id}/cover`, {
              headers: { authorization: `Bearer ${await f.token("user:eve")}` },
            })
          ).status,
          404,
        );
      }
      const approved = await review(f, version.body);
      assert.equal(approved.status, 200);
      const published = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
        revision: approved.body.revision,
      });
      assert.equal(published.status, 201);
      return {
        resourceId: created.id,
        revision: rev,
        version: version.body,
        publication: published.body,
      };
    }

    const coverBytes = png(24, 14);
    const loomHost = await publishConfigured({
      kind: "application",
      title: "Loom 本体应用",
      space: "loom",
      summary: "把想法连接成作品的工作台",
      detail: "支持 Art 节点、MCP 与能力包。",
      cover: coverBytes,
      policy: "application-zip-format-v1",
      bytes: softwareBytes("application"),
    });
    const loomMcp = await publishConfigured({
      kind: "mcp",
      title: "Loom 原生 MCP",
      policy: "loom-mcp-zip-format-v1",
      bytes: loomMcpBytes(),
    });
    const loomSoftCap = await publishConfigured({
      kind: "capability",
      title: "Loom 辅助能力",
      space: "loom",
      summary: "显式归入 Loom 空间的能力包",
      detail: "",
      policy: "capability-zip-format-v1",
      bytes: softwareBytes("capability"),
    });
    const otterCap = await publishConfigured({
      kind: "capability",
      title: "Otter 快捷面板扩展",
      space: "otter",
      summary: "桌面快捷动作",
      detail: "",
      policy: "capability-zip-format-v1",
      bytes: softwareBytes("capability"),
    });
    const frameAsset = await publishConfigured({
      kind: "art",
      title: "FrameLab 胶片颗粒纹理",
      space: "framelab",
      summary: "静态纹理参考",
      detail: "",
      policy: "art-zip-manifest-v1",
      bytes: packageBytes(),
    });

    const catalog = (query) => f.request("GET", `/v1/catalog?${query}`, undefined, { token: null });
    const ids = (res) => res.body.items.map((item) => item.id).sort();

    assert.deepEqual(
      ids(await catalog("space=loom")),
      [loomHost.publication.id, loomMcp.publication.id, loomSoftCap.publication.id].sort(),
    );
    assert.deepEqual(ids(await catalog("space=loom&kind=application")), [loomHost.publication.id]);
    assert.deepEqual(
      ids(await catalog("section=loom")),
      [loomMcp.publication.id, loomSoftCap.publication.id].sort(),
    );
    assert.deepEqual(ids(await catalog("space=otter")), [otterCap.publication.id]);
    assert.deepEqual(ids(await catalog("space=framelab")), [frameAsset.publication.id]);
    assert.deepEqual(ids(await catalog("section=assets")), [frameAsset.publication.id]);

    for (const bad of ["space=", "space=games", "space=__proto__", "space=loom&space=otter"]) {
      const res = await catalog(bad);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error, "INVALID_CATALOG_FILTER");
    }

    const detail = await f.request("GET", `/v1/catalog/${loomHost.publication.id}`, undefined, {
      token: null,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.space, "loom");
    assert.equal(detail.body.summary, "把想法连接成作品的工作台");
    assert.equal(detail.body.detail, "支持 Art 节点、MCP 与能力包。");
    assert.equal(detail.body.cover.url, `/v1/catalog/${loomHost.publication.id}/cover`);

    const pubCover = await f.mf.dispatchFetch(
      `http://localhost/v1/catalog/${loomHost.publication.id}/cover`,
    );
    assert.equal(pubCover.status, 200);
    assert.equal(pubCover.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await pubCover.arrayBuffer()).equals(coverBytes), true);
    assert.equal(
      (
        await f.mf.dispatchFetch(`http://localhost/v1/catalog/${loomHost.publication.id}/cover`, {
          method: "HEAD",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.mf.dispatchFetch(`http://localhost/v1/catalog/${loomMcp.publication.id}/cover`))
        .status,
      404,
    );

    const mutated = await f.request("PUT", `/v1/resources/${loomHost.resourceId}/profile`, {
      revision: loomHost.revision,
      space: "loom",
      summary: "未经审核的新文案不得直接上线",
      detail: "修改后待重审",
    });
    assert.equal(mutated.status, 200);
    assert.equal(
      (
        await f.request("GET", `/v1/catalog/${loomHost.publication.id}`, undefined, {
          token: null,
        })
      ).status,
      404,
    );
    assert.equal(
      (await f.mf.dispatchFetch(`http://localhost/v1/catalog/${loomHost.publication.id}/cover`))
        .status,
      404,
    );

    const otterCover = png(8, 8);
    const withCoverOtter = await publishConfigured({
      kind: "application",
      title: "Otter 本体",
      space: "otter",
      summary: "Otter 桌面",
      detail: "",
      cover: otterCover,
      policy: "application-zip-format-v1",
      bytes: softwareBytes("application"),
    });
    assert.equal(
      (
        await f.mf.dispatchFetch(
          `http://localhost/v1/catalog/${withCoverOtter.publication.id}/cover`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("POST", `/v1/publications/${withCoverOtter.publication.id}/unlist`, {
          revision: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.mf.dispatchFetch(
          `http://localhost/v1/catalog/${withCoverOtter.publication.id}/cover`,
        )
      ).status,
      404,
    );
  } finally {
    await f.dispose();
  }
});
