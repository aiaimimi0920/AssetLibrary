import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";

const baseUrl = requiredUrl("ASSETLIBRARY_API_BASE_URL");
const multiplier = positiveNumber("LOAD_MULTIPLIER", 1);
const duration = __ENV.LOAD_DURATION || "10m";
const uploadEnabled = __ENV.UPLOAD_ENABLED === "1";
const uploadReleaseId = __ENV.UPLOAD_RELEASE_ID || "";
const authToken = __ENV.ASSETLIBRARY_AUTH_TOKEN || "";

const scenarios = {
  browse: arrivalScenario(rate("BROWSE_RPS", 1000), duration, 400),
  search: { ...arrivalScenario(rate("SEARCH_RPS", 200), duration, 120), exec: "search" },
};

if (uploadEnabled) {
  if (!isUuid(uploadReleaseId) || authToken.length < 1) {
    throw new Error("UPLOAD_ENABLED requires UPLOAD_RELEASE_ID and ASSETLIBRARY_AUTH_TOKEN");
  }
  scenarios.upload_sessions = {
    ...arrivalScenario(rate("UPLOAD_SESSION_RPS", 100), duration, 100),
    exec: "createUploadSession",
  };
}

export const options = {
  discardResponseBodies: true,
  scenarios,
  thresholds: {
    "http_req_failed{scenario:browse}": ["rate<0.001"],
    "http_req_duration{scenario:browse}": ["p(95)<300"],
    "http_req_failed{scenario:search}": ["rate<0.001"],
    "http_req_duration{scenario:search}": ["p(95)<500"],
    ...(uploadEnabled ? {
      "http_req_failed{scenario:upload_sessions}": ["rate<0.001"],
      "http_req_duration{scenario:upload_sessions}": ["p(95)<400"],
    } : {}),
  },
};

export default function browse() {
  const response = http.get(`${baseUrl}/v1/public/packages?limit=50`, {
    tags: { operation: "catalog_browse" },
    headers: traceHeaders(),
  });
  check(response, { "browse status is 200": (value) => value.status === 200 });
}

export function search() {
  const terms = ["art", "capability", "editor", "texture", "workflow"];
  const term = terms[exec.scenario.iterationInTest % terms.length];
  const response = http.get(`${baseUrl}/v1/public/search?q=${encodeURIComponent(term)}&limit=25`, {
    tags: { operation: "catalog_search" },
    headers: traceHeaders(),
  });
  check(response, { "search status is 200": (value) => value.status === 200 });
}

export function createUploadSession() {
  const nonce = `${Date.now()}-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const response = http.post(
    `${baseUrl}/v1/me/releases/${uploadReleaseId}/upload-sessions`,
    JSON.stringify({
      file_name: `load-${nonce}.zip`,
      media_type: "application/zip",
      size_bytes: 5_242_880,
      part_size_bytes: 5_242_880,
      part_count: 1,
      expected_digest: { algorithm: "sha256", value: `sha256:${"0".repeat(64)}` },
    }),
    {
      tags: { operation: "upload_session_create" },
      headers: {
        ...traceHeaders(),
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `load-${nonce}`,
      },
    },
  );
  check(response, { "upload session status is 200": (value) => value.status === 200 });
  sleep(0.01);
}

function arrivalScenario(targetRate, testDuration, baseVus) {
  const preAllocatedVUs = Math.max(1, Math.ceil(baseVus * multiplier));
  return {
    executor: "constant-arrival-rate",
    rate: targetRate,
    timeUnit: "1s",
    duration: testDuration,
    preAllocatedVUs,
    maxVUs: preAllocatedVUs * 2,
  };
}

function rate(name, fallback) {
  return Math.max(1, Math.round(positiveNumber(name, fallback) * multiplier));
}

function positiveNumber(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function requiredUrl(name) {
  const raw = __ENV[name];
  if (!raw) throw new Error(`${name} is required`);
  const match = /^(https?):\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?\/?$/.exec(raw);
  if (!match) {
    throw new Error(`${name} must be an origin without credentials, query, or fragment`);
  }
  const [, scheme, host, port] = match;
  const labelsValid = host.startsWith("[") || host.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
  );
  const portNumber = port ? Number(port) : 0;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host.toLowerCase());
  if (!labelsValid || (port && (portNumber < 1 || portNumber > 65535)) || (!loopback && scheme !== "https")) {
    throw new Error(`${name} must be a remote HTTPS or loopback HTTP(S) origin without credentials, query, or fragment`);
  }
  return `${scheme}://${host}${port ? `:${port}` : ""}`;
}

function traceHeaders() {
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  return {
    "X-Request-ID": randomUuid(),
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function randomHex(length) {
  let value = "";
  while (value.length < length) value += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return value.slice(0, length);
}

function randomUuid() {
  const value = randomHex(32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
