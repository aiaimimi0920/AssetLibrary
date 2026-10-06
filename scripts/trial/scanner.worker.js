/** 仅本地体验的合成 AV；真实 ZIP/PNG/摘要校验仍由主 Worker 执行。不是 ClamAV。 */
export default {
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/scan")
      return new Response(null, { status: 404 });
    const length = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > 8 * 1024 * 1024)
      return new Response(null, { status: 413 });
    const reader = request.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > length) return new Response(null, { status: 413 });
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (size !== length) return new Response(null, { status: 400 });
    const now = Date.now();
    return new Response(
      JSON.stringify({
        protocol: "neuro-clamav-v1",
        verdict: "clean",
        sha256: request.headers.get("x-object-sha256"),
        size,
        engineVersion: "1.5.4",
        database: { sha256: "a".repeat(64), dailyVersion: 1, updatedAt: now },
        completedAt: now,
        expiresAt: now + 3600000,
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
