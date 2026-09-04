# Cost and budget runbook

P8 cost acceptance uses measured provider bills and usage exports, not list-price
estimates alone. Tag or account-separate staging and production so every charge is
attributable without embedding user/package identifiers in billing labels.

## Cost taxonomy

Track monthly actual, forecast, unit usage, and unit cost for:

| Category | Primary drivers | Unit economics |
| --- | --- | --- |
| R2 storage | published, quarantine, multipart, backup bytes-month | cost / retained GiB-month |
| R2/Edge requests | Class A/B operations, Worker requests/CPU, KV, Queue | cost / 1M downloads |
| Network | non-R2 egress, cross-region replication, OTLP export | cost / TiB served |
| PostgreSQL | instance, IOPS, storage, WAL, PITR, snapshots | cost / 1M control requests |
| Kubernetes | API/Web/worker CPU-memory, sandbox overhead, load balancers | cost / active hour |
| Search/Valkey | nodes, storage, snapshots, requests | cost / 1M searches |
| Analytics | ClickHouse compute/storage/backup | cost / 1M download events |
| Observability | metric series, trace/log ingest, retention, queries | cost / 1M requests |

Do not use `publisher_id`, `package_id`, digest, principal, request ID, or trace ID
as cloud cost tags. Required allocation labels are environment, service,
component, region, owner, and cost-center from a bounded allowlist.

## Budget alerts

Create provider budgets and one aggregate FinOps budget per environment:

- 50% actual or forecast: informational; verify growth against traffic/storage.
- 80% actual or forecast: warning; owner supplies an end-of-period forecast and
  mitigation within one business day.
- 100% actual or forecast: critical; page the service owner and FinOps. Stop
  nonessential load tests, rebuilds, and extended trace sampling.

Budget alerts must route through an independently tested billing channel; they
must not depend on the AssetLibrary API being healthy. At least monthly, trigger a
test notification for each threshold route without incurring artificial spend.

## Guardrails

- Keep Cloudflare Workers log and trace head sampling explicit. Raise sampling
  temporarily only under a time-bounded incident change, then restore it.
- Apply metric-label cardinality limits at the Collector and monitoring backend.
- Keep public immutable downloads CDN-served; an origin/API dependency on cache
  hits is both a reliability and cost regression.
- Abort abandoned multipart uploads and expire quarantine according to policy;
  never apply deletion lifecycle shorter than the published bucket lock.
- Rate-limit expensive search and authenticated mutations at the edge/API while
  preserving accessibility and documented clients.
- Use snapshot incrementality and retention tiers, but never remove the last
  independently restored recovery point to save cost.

## Monthly capacity and cost review

For each category compare actual versus forecast, month-over-month change,
traffic-normalized unit cost, cache-hit ratio, retention growth, and the P8 10-TiB
annual published-object assumption. Explain changes above 10%. Review:

1. package-size distribution and published/quarantine/backup bytes;
2. CDN hit ratio, Range behavior, origin requests, and bytes per download;
3. API/search/upload rates and autoscaling headroom;
4. database IOPS/WAL/snapshot growth and search/analytics storage;
5. telemetry series cardinality, ingest, retention, and sampling;
6. reserved/committed capacity only after representative soak evidence exists.

Attach a redacted provider export, query/formula version, currency, tax treatment,
time window, and reviewer. A cost gate is incomplete if any required category is
unallocated or if 50/80/100% delivery has not been exercised.

## Repository contract

`deploy/policies/cost-budget-policy.json` and
`schemas/cost-budget-policy.schema.json` freeze the eight cost categories, alert
thresholds, low-cardinality allocation labels, and required evidence fields.
`scripts/Test-CostBudgetPolicy.ps1` validates those semantics in CI.

The policy deliberately contains no invented cloud price or budget amount. Actual
amounts stay in the provider/FinOps system, and acceptance evidence references a
redacted export by SHA-256. A k6 run manifest is always marked
`cost_evidence_state: not_collected`, `capacity_evidence_state: k6_summary_only`,
and `p8_gate_eligible: false`; attaching measured provider, telemetry, and review
evidence is a separate production gate.

The provider export, all eight categories, and independently delivered alerts are
also bound into `p8-capacity-evidence.json`. The repository verifier checks file
containment, byte length, SHA-256, complete load-window coverage, exact threshold
semantics, and the immutable standalone-k6 state. It never upgrades those checks
into a provider-authenticity claim; the generated report remains P8-ineligible.
