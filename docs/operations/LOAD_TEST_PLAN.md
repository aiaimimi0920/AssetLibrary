# P8 load and soak plan

The load suite is an acceptance harness, not a benchmark claim. A passing local
smoke run proves script behavior only. P8 closes only with representative cloud
topology, provider/CDN metrics, 24-hour evidence, and reviewed capacity headroom.

## Safety boundary

- Run only against an isolated staging environment with its own database,
  JetStream consumers, search index, object prefixes, and cost budget.
- Remote targets require `-AllowRemoteTarget`; production additionally requires
  a change record, incident commander, stop authority, and provider quota review.
- Put bearer credentials only in process environment variables. Never use URL
  query tickets or command-line `-e` arguments for secrets because they enter
  process listings. CI may use `-e` only for non-secret syntax-test fixtures.
- Remote targets must use HTTPS. Plain HTTP is accepted only for loopback smoke
  tests, even when `-AllowRemoteTarget` is present.
- The upload-session scenario creates database and object-store multipart state.
  Use a dedicated Publisher/Package/Release fixture and run the normal bounded
  cleanup after evidence collection.
- The download scenario can generate material request and observability cost.
  Confirm the budget before 10,000-VU or 24-hour runs.

## Profiles

| Profile | Control-plane multiplier | Duration | Purpose |
| --- | ---: | ---: | --- |
| `smoke` | 0.01x | 1 minute | harness and trace validation only |
| `baseline` | 1x | 10 minutes | 1,000 browse RPS, 200 search RPS, optional 100 upload sessions/s |
| `double` | 2x | 30 minutes | pre-soak capacity and 40% headroom check |
| `soak` | 2x | 24 hours | required memory, pool, lag, retention, and cost gate |
| `burst` | 5x | 10 minutes | required cascade/failure protection gate |
| `download` | 10,000 VUs by default | 10 minutes | CDN/R2 cache, Range, slow-client, and origin protection |

`performance/k6/control-plane.js` enforces the public latency and 0.1% error
thresholds. `performance/k6/download.js` keeps bodies out of generator memory,
mixes full and Range GETs, and checks the download security/cache contract.

## Generator topology

Do not infer service capacity from a saturated generator. Baseline smoke may run
on one host; 2x, 5x, and 10,000-VU tests require distributed generators in at
least two failure-independent locations. Before accepting a result, prove:

- generator CPU below 70%, no dropped iterations, no exhausted ephemeral ports,
  and clock synchronization;
- aggregate target rate equals the sum of generator rates without double-counting;
- DNS, TLS, CDN, and object-cache behavior match real clients;
- public browse/search traffic is separate from upload control calls and object
  bytes never transit through Axum or Next.js.

## Configuration

Control-plane variables:

```powershell
$env:ASSETLIBRARY_API_BASE_URL = 'https://assetlibrary-staging.example'
$env:UPLOAD_ENABLED = '0'
# For a dedicated write fixture only:
$env:UPLOAD_ENABLED = '1'
$env:UPLOAD_RELEASE_ID = '<uuid>'
$env:ASSETLIBRARY_AUTH_TOKEN = '<ephemeral bearer>'
./scripts/Run-P8LoadTest.ps1 -Profile smoke -AllowRemoteTarget
```

Download variables:

```powershell
$env:DOWNLOAD_URL = 'https://downloads-staging.example/public/sha256/<digest>/<file>.zip'
$env:DOWNLOAD_VUS = '10000'
$env:DOWNLOAD_RANGE_BYTES = '1048576' # target object must be at least this large
./scripts/Run-P8LoadTest.ps1 -Profile download -AllowRemoteTarget
```

For restricted downloads, set `DOWNLOAD_AUTHORIZATION` to the complete short-lived
`Bearer ...` header value. The token must not appear in the URL or evidence
manifest. A 10-minute test needs a ticket TTL that covers the run without making
production tickets generally long lived; mint dedicated test tickets.

Use `-ValidateOnly` to check target safety and required configuration without
executing k6. Each actual run writes a redacted manifest, k6 summary, and transcript
under ignored `test-results/p8-load/<UTC>-<profile>`. A custom `-EvidenceRoot`
must still resolve inside the AssetLibrary repository.
The standalone manifest is explicitly `k6_summary_only` for capacity,
`not_collected` for cost, and never P8-eligible without the external evidence below.

## Workload matrix

Run each control profile with representative catalog cardinality, cache cold/warm
phases, and both normal and worst-case bounded query shapes. Run downloads for:

- small/typical/maximum accepted package sizes;
- cache warm and cache cold paths;
- full GET, single Range resume, conditional ETag, and a bounded slow-client mix;
- public and restricted authorization;
- origin unavailable while a public immutable object remains cached.

Upload finalization is measured separately from byte transfer. Pre-stage valid
multipart uploads, then replay unique finalization control requests at the
required peak. Do not fake completion with missing object parts or reuse one
idempotency key: those measure rejection paths, not finalization capacity.

## Stop conditions

Abort immediately on any of the following:

- control-plane 5xx above 1% for two minutes or rapidly burning error budget;
- database connection/lock exhaustion, JetStream loss, or growing unbounded lag;
- scanner sandbox escape, quarantine bypass, authorization failure-open, or
  bytes flowing through API/Web;
- generator saturation or missing provider metrics;
- cost forecast crossing the approved run budget.

## Acceptance evidence

For every required run retain the run manifest and summary plus Prometheus,
OpenTelemetry, Cloudflare, PostgreSQL, NATS, OpenSearch, and cost exports. Record
p50/p95/p99, errors, dropped iterations, cache hits, origin requests, database
pool/replication lag, event/index freshness, autoscaling time, maximum utilization,
and remaining headroom. A required gate fails if any signal is absent.

`schemas/p8-capacity-evidence.schema.json` is the handoff contract for the cloud
evidence set. It requires the baseline, 24-hour soak, 5x burst, and 10,000-VU
download profiles, two failure-independent generator locations per run, complete
signal windows, measured cost allocation, and independent 50/80/100% alert
delivery. Every referenced export is redacted, size bounded, repository contained,
and addressed by SHA-256.

Validate a collected evidence set without changing its source files:

```powershell
./scripts/Test-P8CapacityEvidence.ps1 `
  -EvidenceManifest test-results/p8-cloud/<run>/p8-capacity-evidence.json `
  -ReportPath test-results/p8-cloud/<run>/verification-report.json
```

The verifier rejects local/loopback evidence, incomplete signals, path or reparse
escapes, duplicate evidence files, failed k6 thresholds, mismatched hashes or run
windows, saturated generators, and standalone k6 manifests claiming eligibility.
Its report deliberately keeps `production_authenticity_verified` and
`p8_gate_eligible` false: repository checks cannot authenticate a provider account,
the declared topology, or reviewer identity. Authorized operators must attest those
facts separately, and P8 also remains open until the cloud failure/recovery gates in
the backup and failure-drill runbooks have passed.
