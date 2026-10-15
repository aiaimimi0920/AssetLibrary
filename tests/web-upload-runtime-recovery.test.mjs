import assert from "node:assert/strict";
import test from "node:test";
import { packageBytes, packagePolicy } from "./art-package-fixture.mjs";
import { createResource, fixture } from "./fixture.mjs";
import { keyOf } from "./upload-fixture.mjs";
import { browserModules } from "./web-client-fixture.mjs";

for (const stage of ["complete", "inspection"]) {
  test(`${stage} 已提交但响应丢失后，手动重试复用真实上传和检查`, async () => {
    const f = await fixture();
    const original = globalThis.fetch;
    const browser = await browserModules();
    try {
      const resource = await createResource(f);
      browser.api.setCredential(await f.token());
      const bytes = packageBytes();
      const file = new File([bytes], "recovery.zip");
      let lost = false;
      const reservations = [];
      globalThis.fetch = async (path, options) => {
        const headers = new Headers(options.headers);
        const body =
          options.body instanceof File
            ? new Uint8Array(await options.body.arrayBuffer())
            : options.body;
        if (options.body instanceof File) headers.set("Content-Length", String(body.length));
        const response = await f.mf.dispatchFetch(`http://localhost${path}`, {
          method: options.method,
          headers,
          ...(body === undefined ? {} : { body }),
        });
        if (path.endsWith(`/${stage}`) && !lost) {
          assert.ok(response.ok);
          await response.arrayBuffer();
          lost = true;
          throw new TypeError("INJECTED_RESPONSE_LOSS");
        }
        return response;
      };
      const attempt = () =>
        browser.upload.uploadPackage(
          resource,
          file,
          packagePolicy,
          new AbortController().signal,
          (upload) => reservations.push(upload),
        );
      await assert.rejects(attempt(), /INJECTED_RESPONSE_LOSS/);
      assert.equal(reservations.length, 1);
      const recovered = await attempt();
      assert.equal(recovered.id, reservations[0].id);
      assert.equal(reservations.length, 2);
      const uploads = await f.db
        .prepare("SELECT id, state FROM uploads WHERE resource_id = ?")
        .bind(resource.id)
        .all();
      assert.deepEqual(uploads.results, [{ id: recovered.id, state: "quarantined" }]);
      const inspections = await f.db
        .prepare("SELECT upload_id, state FROM inspections WHERE upload_id = ?")
        .bind(recovered.id)
        .all();
      assert.deepEqual(inspections.results, [{ upload_id: recovered.id, state: "queued" }]);
      const stored = await f.bucket.get(keyOf(recovered));
      assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), new Uint8Array(bytes));
    } finally {
      browser.api.stopRequests();
      globalThis.fetch = original;
      await f.dispose();
    }
  });
}
