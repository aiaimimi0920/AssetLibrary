import http from "node:http";

const port = Number.parseInt(process.env.ACCOUNT_FIXTURE_PORT ?? "", 10);
const cookieName = process.env.ACCOUNT_FIXTURE_COOKIE_NAME ?? "neuro_session";
const cookieValue = process.env.ACCOUNT_FIXTURE_COOKIE_VALUE ?? "";
const issuer = process.env.ACCOUNT_FIXTURE_ISSUER ?? "";
const subject = process.env.ACCOUNT_FIXTURE_SUBJECT ?? "";
const accessToken = process.env.ACCOUNT_FIXTURE_ACCESS_TOKEN ?? "";

if (!Number.isInteger(port) || port < 1 || port > 65_535
  || !/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)
  || !cookieValue || !issuer || !subject || accessToken.length < 32) {
  throw new Error("Invalid Account Service fixture configuration");
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (request.method !== "GET" || request.url !== "/v1/session") {
    send(response, 404, { error: "not_found" });
    return;
  }
  const cookies = (request.headers.cookie ?? "").split(";").map((value) => value.trim());
  if (!cookies.includes(`${cookieName}=${cookieValue}`)) {
    send(response, 401, { error: "unauthenticated" });
    return;
  }
  send(response, 200, {
    principal: { issuer, subject },
    access_token: accessToken,
    expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
