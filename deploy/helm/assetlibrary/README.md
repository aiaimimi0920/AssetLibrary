# AssetLibrary Helm chart

This chart deploys the API, web application, outbox dispatcher, catalog indexer,
sandboxed scanner with a loopback-only ClamAV sidecar, and quarantine cleanup
CronJob.
Every image value must use an immutable digest.

The checked-in defaults are intentionally non-installable: images, sandbox
RuntimeClasses, secret names, public URL, and dependency ranges must be supplied
by an environment values file. This makes an incomplete production install fail
schema validation instead of rendering permissive placeholders.

## Cluster prerequisites

- Kubernetes supports the restricted Pod security fields used by this chart.
- KEDA and its `ScaledObject` CRD are installed when scanner autoscaling is
  enabled. The scaler reads the existing `ASSETLIBRARY_EVENTS` JetStream stream
  and the durable scanner consumer.
- `scanner.runtimeClassName` names a cluster-managed sandbox RuntimeClass. Its
  runtime and admission policy must enforce the declared
  `assetlibrary.neuro/required-pids-limit` annotation; Kubernetes has no portable
  per-Pod PID-limit field.
- Each `network.dependencies.<component>` list contains only that component's
  reviewed database, NATS, object-store, OIDC, or API ranges. The schema rejects
  default, loopback, and link-local routes. DNS is the only shared egress grant.
- `network.ingress` identifies both the ingress controller namespace and Pods;
  broad namespace-only ingress is not accepted by the chart.
- KEDA reaches a cluster-internal TLS NATS monitoring endpoint. The native
  JetStream scaler reads monitoring data rather than the NATS client protocol,
  so access to that endpoint must be restricted to the KEDA operator at the
  cluster-network layer.

The ClamAV sidecar uses the official image's `/init-unprivileged` entrypoint,
runs with the image-specific non-root UID/GID configured in values, and disables
FreshClam. Supply a digest-pinned image that already
contains current signature databases, then roll the scanner deployment whenever
that digest is refreshed. A non-root init container copies those immutable image
definitions into a bounded writable volume required by `/init-unprivileged`;
FreshClam remains disabled. This prevents the scanner Pod from needing general
internet access. ClamAV listens only on `127.0.0.1:3310` inside the Pod.

Both scanner and cleanup require a cluster-managed sandbox RuntimeClass whose
admission policy enforces the declared PID-limit annotation.
The cleanup job removes expired database-backed quarantine objects and also
lists old incomplete multipart uploads. It aborts only canonical keys that are
past the configured grace period and have no live database reference. The
configured batch limit is applied independently to database and provider-orphan
cleanup so a full database batch cannot starve the orphan sweep.

## Secrets

Create these Secrets outside Helm through the deployment secret manager:

- `databaseSecretName`: API database credentials only.
- `serviceSecretName`: API OIDC, object-store, and the base64url-encoded
  `ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64`. Keep the ticket key out of values
  and rotate it through the deployment secret manager.
- `scannerSecretName`: scanner DB/NATS credentials plus read-quarantine and
  write-published object-store credentials.
- `outboxSecretName`: outbox DB and NATS publish credentials.
- `indexerSecretName`: indexer DB/NATS credentials, TLS Valkey and OpenSearch
  credentials, plus the narrowly scoped Cloudflare KV account, namespace, and
  API token used to reconcile public allowlists and revocations. It must not
  contain the edge ticket-signing key.
- `cleanupSecretName`: cleanup DB credentials plus delete-quarantine and
  abort-multipart object-store credentials.

The web container receives no secret. Service accounts do not mount Kubernetes
API tokens. Scanner temporary storage, ClamAV streaming storage, CPU, memory,
scan duration, JetStream in-flight work, and replica count are all bounded.
The web workload receives only server-side `ASSETLIBRARY_API_URL`, public-site,
Account Service session endpoint/cookie-name, and the explicit HTTPS upload-origin
allowlist. No bearer or account credential is put in a `NEXT_PUBLIC_*` variable.
Each origin in `config.uploadOrigins` must match the origin used by object-store
presigned PUT URLs, contain no path/query/fragment, and must expose `ETag` through
its bucket CORS policy. The browser origins permitted by that CORS policy are a
separate provider-side allowlist and must also be exact HTTPS origins.

`config.appUpdatesEnabled` defaults to `false` and must remain false until the
P9 TUF, rollback, revocation, and independent-root-key gates are complete.
The public and restricted download origins are explicit HTTPS values. API
responses return restricted bearer tickets separately from URLs and mark them
`Cache-Control: no-store`; clients send the ticket in the edge `Authorization`
header so it does not enter URL, referrer, or shared-cache logs.

## Observability

Rust workloads expose Prometheus metrics on `observability.metricsPort` and emit
JSON logs. Set `observability.otlpEndpoint` to a private cluster OpenTelemetry
Collector to export traces; do not point application Pods directly at a public
vendor endpoint. Optional ServiceMonitor, PrometheusRule, AlertmanagerConfig, and
Grafana dashboard resources are disabled by default because their CRDs are
cluster prerequisites. When enabled, configure `prometheusIngress` to the exact
Prometheus namespace and Pod labels and supply the Alertmanager webhook through
an external Secret.

The checked-in dashboard and alerts use the stable application-emitted `service`
label. ServiceMonitor therefore preserves scraped labels with `honorLabels`;
metrics ingress remains private. Alert procedures and trace/privacy rules are in
[`docs/operations/OBSERVABILITY_RUNBOOK.md`](../../../docs/operations/OBSERVABILITY_RUNBOOK.md).

`config.searchAlias` is shared by the API and indexer. Rebuilds write a fresh
versioned index and atomically move this alias; the one-shot `rebuild` command
must be run as a separately controlled Job or release operation, not by changing
the long-running Deployment command. The indexer uses fixed replicas because it
shares one durable JetStream consumer; search and download request scaling stay
independent of projection throughput.
