import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createPublishedBucket } from "./s3-bucket.mjs";
import { createPolicyPort } from "./policy-port.mjs";

// Only authenticated Cloudflare-compatible writes populate this initially empty
// policy port. The harness uses the production indexer reconcile, not allowlists.
export function createEdgeServer(settings, worker) {
  if (!/^[a-f0-9]{48}$/.test(settings.policyToken)) throw new Error("Invalid test policy token");
  const port = createPolicyPort(settings.policyToken);
  let active = 0;
  const env = {
    PUBLISHED_BUCKET: settings.bucket, POLICY: { get: async (key) => port.policy.get(key) ?? null },
    TICKET_SECRET: settings.ticketSecret, TICKET_ISSUER: "isolated-art", TICKET_AUDIENCE: "isolated-edge",
  };
  const server = createServer(async (incoming, outgoing) => {
    if (++active > 8) { active--; outgoing.writeHead(503).end(); return; }
    try {
      const url = new URL(incoming.url, "http://127.0.0.1");
      if (incoming.url.length > 2048 || url.search || url.hash) {
        outgoing.writeHead(400).end(); return;
      }
      if (url.pathname === "/healthz" && incoming.method === "GET") {
        outgoing.writeHead(200).end("ready"); return;
      }
      if (await port.handle(url, incoming, outgoing)) return;
      if (!["GET", "HEAD", "OPTIONS"].includes(incoming.method)) {
        outgoing.writeHead(405).end(); return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const origin = `http://127.0.0.1:${server.address().port}`;
      const response = await worker.fetch(new Request(origin + url.pathname, { method: incoming.method, headers }), env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch {
      // Do not serialize URLs, tokens, signed storage headers or raw causes.
      if (!outgoing.headersSent) outgoing.writeHead(502).end("test adapter failure");
      else outgoing.destroy();
    } finally { active--; }
  });
  server.requestTimeout = 5000; server.headersTimeout = 4000; server.keepAliveTimeout = 1000;
  server.setTimeout(10000, (socket) => socket.destroy());
  server.maxConnections = 16;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const worker = createRequire(import.meta.url)(process.env.ART_EDGE_MODULE).default;
    const server = createEdgeServer({
      policyToken: process.env.ART_POLICY_TOKEN, ticketSecret: process.env.ART_TICKET_SECRET,
      bucket: createPublishedBucket({ origin: process.env.ASSETLIBRARY_S3_ENDPOINT,
        bucket: "assetlibrary-published", accessKey: process.env.AWS_ACCESS_KEY_ID,
        secretKey: process.env.AWS_SECRET_ACCESS_KEY }),
    }, worker);
    server.listen(0, "127.0.0.1", async () => {
      try {
        await writeFile(process.env.ART_EDGE_ENDPOINT_FILE, `http://127.0.0.1:${server.address().port}`, { flag: "wx" });
      } catch { server.closeAllConnections(); server.close(); process.exitCode = 1; }
    });
  } catch { console.error("Local Edge test adapter startup failed"); process.exitCode = 1; }
}
