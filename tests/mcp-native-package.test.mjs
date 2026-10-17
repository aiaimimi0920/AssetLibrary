import assert from "node:assert/strict";
import { test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { tick } from "./upload-fixture.mjs";

test("原生 MCP 类型标记、入口和混装拒绝；不调用扫描器", async () => {
  const f = await fixture();
  try {
    const manifest = {
      schemaVersion: 1,
      id: "echo",
      version: "1.0.0",
      publisher: { id: "example" },
      transport: "stdio",
      entry: { command: "runtime/main.py" },
    };
    for (const changes of [
      { schemaVersion: 2 },
      { transport: "unknown" },
      { entry: { command: "../outside.py" } },
      { publisher: {} },
      { version: "" },
    ]) {
      const bytes = artZip([
        { path: "runtime/main.py", bytes: Buffer.from("print('fixture')") },
        {
          path: "mcp.server.json",
          bytes: Buffer.from(JSON.stringify({ ...manifest, ...changes })),
        },
      ]);
      const upload = await prepared(f, bytes, "mcp");
      assert.equal((await startPackage(f, upload, "loom-mcp-zip-format-v1")).status, 201);
      await tick(f);
      const result = (await read(f, upload)).body;
      assert.equal(result.state, "rejected", JSON.stringify(result));
    }
    const bytes = artZip([
      { path: "mcp.server.json", bytes: Buffer.from(JSON.stringify(manifest)) },
      { path: "runtime/main.py", bytes: Buffer.from("print('fixture')") },
      { path: "capability.manifest.json", bytes: Buffer.from('{"kind":"capability"}') },
    ]);
    const upload = await prepared(f, bytes, "mcp");
    assert.equal((await startPackage(f, upload, "loom-mcp-zip-format-v1")).status, 201);
    await tick(f);
    assert.equal((await read(f, upload)).body.state, "rejected");
  } finally {
    await f.dispose();
  }
});
