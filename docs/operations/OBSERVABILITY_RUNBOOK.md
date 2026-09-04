# Observability runbook

This runbook defines the P8 telemetry boundary and first-response procedures.
It does not claim that the production SLO has been measured. Production evidence
must identify the environment, Git commit, deployment digest, time window, and
dashboard or query export.

## Signal architecture

- Rust API and workers emit JSON logs, W3C traces, and Prometheus metrics. The
  metrics listener defaults to `0.0.0.0:9090`; Helm sets it explicitly.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is optional locally and required in
  staging/production. It points to a cluster-managed OpenTelemetry Collector,
  not directly to a public vendor endpoint.
- Next.js registers `@vercel/otel` as `assetlibrary-web`. Server-side fetches
  propagate W3C context to the API.
- API spans accept `traceparent`/`tracestate`, include the bounded matched route
  and request ID, and propagate context to OpenSearch, OIDC JWKS, and NATS.
- NATS producers put W3C headers on messages. Scanner and indexer restore that
  parent before recording worker outcomes and event lag.
- Edge uses Cloudflare Workers logs and traces. Every response returns a UUID
  `X-Request-ID`; successful download events carry the same optional
  `correlation_id`, incoming `trace_id`, and `cache_hit` fact.

Never add bearer tokens, cookies, principals, raw query text, package filenames,
digests, object keys, IP addresses, or user agents to telemetry. Metrics labels
must come from bounded enums or matched route templates; never use raw paths,
IDs, error messages, or search strings as labels.

## Required deployment wiring

1. Deploy a private OTLP/HTTP Collector and set `observability.otlpEndpoint` to
   its in-cluster endpoint. Apply authentication and egress policy at the
   Collector's exporter boundary.
2. Enable `observability.serviceMonitor`, `prometheusRule`, and
   `grafanaDashboard` only after Prometheus Operator and Grafana sidecar CRDs are
   installed. The ServiceMonitor preserves the application's stable `service`
   label with `honorLabels: true`.
3. If Alertmanager Operator routing is used, create the webhook Secret outside
   Helm and set `observability.alertmanager.webhookSecretName`. Do not put the
   URL in values or Git.
4. Configure Cloudflare's OpenTelemetry export destination in the Cloudflare
   dashboard. `services/edge/wrangler.toml` enables sampled Workers Logs and
   traces; sampling changes require a cost and incident-detection review.
5. Keep metrics port `9090` cluster-internal. The NetworkPolicy admits it only
   from the configured Prometheus namespace and Pod selector.

## Local Grafana Cloud smoke

A public compute node is not required for this smoke. The local Collector makes
outbound HTTPS requests to Grafana Cloud; ports `4317`, `4318`, and `13133` are
bound to loopback and must not be exposed through a router or tunnel.

Collect these three values from the stack's **OpenTelemetry** card. A generic
Grafana API/service-account token is not a substitute for the write-scoped OTLP
credentials:

- `GRAFANA_CLOUD_OTLP_ENDPOINT`: stack-specific OTLP gateway URL;
- `GRAFANA_CLOUD_OTLP_INSTANCE_ID`: OTLP basic-auth username;
- `GRAFANA_CLOUD_OTLP_TOKEN`: Cloud Access Policy token with `metrics:write` and
  `traces:write` scopes.

Keep those values in the process environment or a secret manager, never in a
Compose env file committed to Git. Start the pinned, vendor-neutral Collector:

```powershell
docker compose -f deploy/local/observability.compose.yaml up -d
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
$env:ASSETLIBRARY_METRICS_BIND = '127.0.0.1:9090'
```

The Collector receives local OTLP traces and scrapes the API metrics listener at
`host.docker.internal:9090`. Check `http://127.0.0.1:13133/` and Collector logs,
then confirm an `assetlibrary-*` service and
`assetlibrary_http_requests_total` in Grafana Cloud. A running Collector proves
only local configuration; provider-side receipt must be confirmed in Grafana.

The cleanup CronJob is short lived, so a Prometheus scrape is best effort. Its
JSON log, trace, audit rows, and object/database outcome remain the durable
signals. Do not build an availability SLO from cleanup scrape series alone.

## Metric inventory

| Signal | Primary series | Required dimensions |
| --- | --- | --- |
| HTTP traffic/errors | `assetlibrary_http_requests_total` | service, method, route, status |
| HTTP latency | `assetlibrary_http_request_duration_seconds` | service, method, route |
| In-flight work | `assetlibrary_http_in_flight` | service, area |
| Worker outcomes | `assetlibrary_worker_operations_total` | service, operation, outcome |
| Worker latency | `assetlibrary_worker_operation_duration_seconds` | service, operation |
| Dependencies | `assetlibrary_dependency_requests_total` | service, dependency, operation, outcome |
| Dependency latency | `assetlibrary_dependency_request_duration_seconds` | service, dependency, operation |
| Cache outcomes | `assetlibrary_cache_operations_total` | service, cache, outcome |
| Database pools | `assetlibrary_db_pool_connections` | service, pool, state |
| Event delay | `assetlibrary_event_lag_seconds` | service, subject |
| JetStream backlog | `assetlibrary_jetstream_consumer_pending` | service, subject |
| Processing volume | `assetlibrary_processed_bytes_total` | service, operation |

Cloudflare supplies Edge invocation status, duration, CPU, subrequest, R2, and
cache signals. Join an Edge error to the download event with `request_id` /
`correlation_id`; join it to a distributed trace when `trace_id` is present.

## API error budget burn

Alert: `AssetLibraryApiFastBurn`.

1. Confirm both five-minute and one-hour 5xx ratios; a single empty series is a
   monitoring fault, not recovery.
2. Break down by matched `route`, deployment digest, and zone. Compare with
   dependency error rate and database pool saturation.
3. If one new digest is responsible, stop the canary and roll back. If a
   dependency is responsible, apply the dependency-specific degraded behavior;
   do not retry without a bound.
4. Validate `/readyz`, one public browse, one authenticated write, and outbox
   lag before resolving the incident.

## Catalog or search latency

Alerts: `AssetLibraryCatalogLatency`, `AssetLibrarySearchLatency`.

1. Compare API latency with `opensearch/catalog_search`, Valkey generation-read,
   and search-cache hit/miss series.
2. High API latency with normal dependency latency indicates pool contention,
   serialization, CPU throttling, or a route regression. High OpenSearch latency
   requires index/shard and query inspection.
3. If Valkey is unavailable, search deliberately falls back to OpenSearch. Scale
   OpenSearch before disabling cache; never turn an error into unbounded retry.
4. Capture p50/p95/p99, error ratio, cache outcome, query plan, and deployment
   digest in the incident evidence.

## Database pool saturation

Alert: `AssetLibraryDatabasePoolSaturation`.

1. Compare open/idle/maximum connections per service and PostgreSQL active,
   waiting, lock, replication-lag, CPU, and I/O signals.
2. Find the slow or blocked transaction before raising pool limits. Increasing
   every client pool can exhaust the database and worsen the incident.
3. Pause nonessential rebuild/cleanup jobs first. Preserve outbox correctness;
   do not bypass transactions or idempotency.
4. Resolve only after waiting transactions clear and at least 40% headroom is
   restored at the current request rate.

## Event lag

Alert: `AssetLibraryEventLag`.

1. Check JetStream pending counts, redelivery, max-delivery advisories, worker
   outcomes, and the oldest event timestamp.
2. Determine whether the bottleneck is NATS delivery, database locks, scanning,
   OpenSearch, or the external policy projection.
3. Scale only consumers whose durable-consumer semantics permit it. The indexer
   uses one shared durable consumer and must not be scaled by blind replica count.
4. After recovery, verify monotonic event offsets and search freshness below 60
   seconds; retain dead-letter evidence.

## Worker retries

Alert: `AssetLibraryWorkerRetries`.

1. Group by service, operation, and bounded outcome. Inspect the correlated trace
   and sanitized error class, never raw uploaded content.
2. Scanner failures must remain fail-closed in quarantine. Indexer failure must
   leave the rebuildable PostgreSQL projection canonical.
3. Stop a poison-message loop before increasing concurrency. Preserve the event
   and dead-letter record for replay after remediation.

## Dependency errors

Alert: `AssetLibraryDependencyErrors`.

1. Group by dependency and operation. `unknown_key` and `invalid_cursor` are
   caller outcomes and intentionally excluded from the dependency alert.
2. For OIDC JWKS, keep cached keys until their bounded expiry and return 503 when
   refresh is unavailable; never accept an unverifiable token.
3. For R2/Edge, use the structured `dependency` and `operation` fields. Cache
   read/write failure may degrade to origin; policy, revocation, and R2 failure
   must fail closed with a generic response.
4. For OpenSearch, public browse remains PostgreSQL-backed while search returns a
   dependency failure. Do not silently return an authoritative empty result.

## Verification and evidence

For every staging or production verification, retain:

- UTC start/end, environment, region/zone, Git commit, image digests, and Helm
  release revision;
- exported dashboard data or PromQL, alert fire/resolve timestamps, and sampled
  trace IDs;
- load profile and generator topology;
- redacted incident notes and the checksum of each evidence file.

The repository-local acceptance command validates templates and contracts only;
it cannot prove provider telemetry, alert delivery, or an SLO window.

References: [Next.js instrumentation](https://nextjs.org/docs/app/guides/instrumentation),
[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Cloudflare Workers traces](https://developers.cloudflare.com/workers/observability/traces/), and
[Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/).
