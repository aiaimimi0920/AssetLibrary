const prefix = `/accounts/${"a".repeat(32)}/storage/kv/namespaces/${"b".repeat(32)}/values/`;
const keyPattern = /^(public:[a-f0-9]{64}|revoked:(publisher|package|release|artifact|signing_key|digest):[A-Za-z0-9:-]{1,250})$/;

async function body(incoming, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A loopback test port, not a production KV implementation. Control requests
// use the same run-owned token and never populate policy or synthesize events.
export function createPolicyPort(token) {
  const policy = new Map();
  let unavailable = false;
  let failures = 0;
  let writes = 0;
  const handle = async (url, incoming, outgoing) => {
    const control = url.pathname === "/test/policy-failure";
    const state = url.pathname === "/test/policy-state";
    if (!control && !state && !url.pathname.startsWith(prefix)) return false;
    if (incoming.headers.authorization !== `Bearer ${token}`) {
      outgoing.writeHead(401).end(); return true;
    }
    const reply = (status, value) => outgoing.writeHead(status, {
      "content-type": "application/json", "cache-control": "no-store",
    }).end(JSON.stringify(value));
    if (state && incoming.method === "GET") {
      reply(200, { failures, writes, unavailable, keys: [...policy.keys()] }); return true;
    }
    if (control && incoming.method === "POST") {
      const text = await body(incoming, 64);
      if (!["true", "false"].includes(text)) { reply(400, {}); return true; }
      unavailable = text === "true";
      reply(200, { unavailable }); return true;
    }
    if (control || state) { reply(405, {}); return true; }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!keyPattern.test(key) || !["PUT", "DELETE"].includes(incoming.method)) {
      reply(400, {}); return true;
    }
    if (unavailable) { failures++; reply(503, { success: false }); return true; }
    if (incoming.method === "DELETE") policy.delete(key);
    else {
      const text = await body(incoming, 8192);
      if (text === null) { reply(413, {}); return true; }
      if (!policy.has(key) && policy.size >= 32) { reply(507, {}); return true; }
      policy.set(key, text);
    }
    writes++;
    reply(200, { success: true }); return true;
  };
  return { policy, handle };
}
