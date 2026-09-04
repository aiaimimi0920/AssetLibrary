import http from "k6/http";
import { check, sleep } from "k6";

const downloadUrl = requiredDownloadUrl();
const authorization = __ENV.DOWNLOAD_AUTHORIZATION || "";
const vus = positiveInteger("DOWNLOAD_VUS", 10_000);
const duration = __ENV.LOAD_DURATION || "10m";
const rangeBytes = positiveInteger("DOWNLOAD_RANGE_BYTES", 1_048_576);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    downloads: { executor: "constant-vus", vus, duration, gracefulStop: "30s" },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    checks: ["rate>0.999"],
  },
};

export default function download() {
  const ranged = Math.random() < 0.35;
  const headers = {
    "X-Request-ID": randomUuid(),
    ...(ranged ? { Range: `bytes=0-${rangeBytes - 1}` } : {}),
    ...(authorization ? { Authorization: authorization } : {}),
  };
  const response = http.get(downloadUrl, { headers, tags: { operation: ranged ? "range" : "full" } });
  check(response, {
    "download status is successful": (value) => value.status === (ranged ? 206 : 200),
    "download is immutable or private": (value) => {
      const cacheControl = value.headers["Cache-Control"] || "";
      return cacheControl.includes("immutable") || cacheControl.includes("no-store");
    },
    "request ID is returned": (value) => Boolean(value.headers["X-Request-Id"]),
  });
  sleep(0.1);
}

function requiredDownloadUrl() {
  const raw = __ENV.DOWNLOAD_URL;
  if (!raw) throw new Error("DOWNLOAD_URL is required");
  if (!/^https:\/\/[^/?#@]+\/[^?#]+$/.test(raw)) {
    throw new Error("DOWNLOAD_URL must be an HTTPS URL without credentials, query, or fragment");
  }
  return raw;
}

function positiveInteger(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function randomUuid() {
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  const value = `${hex()}${hex()}${hex()}${hex()}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`;
}
