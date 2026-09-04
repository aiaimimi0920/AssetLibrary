# Cloud accounts and free trial environment

Last verified: 2026-09-04

## Purpose and boundary

This runbook records which external accounts AssetLibrary needs, which free
services are suitable during experimentation, and how each component can move to
the production architecture without rewriting product code. Free-tier limits
change frequently; the linked provider page, not this document or the
[`free-for-dev`](https://github.com/ripienaar/free-for-dev) catalog, is the
billing authority.

A free environment is for development, integration, demos, and low-volume
staging only. It cannot close P8/P9 production gates: it has no HA/SLA guarantee
and cannot prove the 24-hour soak, 10,000 concurrent downloads, regional
recovery, production identity, or real cost alerts.

The Account Service remains independent. Do not create an Auth0, Supabase Auth,
Clerk, or provider-specific user database for AssetLibrary. Development uses the
explicit fake principal adapter; production later trusts the owner's OIDC
issuer.

## Recommended account order

Create only the first five accounts now. The last three are conditional.

| Order | Account | Trial use | Card | Production migration |
| ---: | --- | --- | --- | --- |
| 1 | GitHub organization | Repository, Actions, security evidence | Not required until paid overage | Upgrade the same organization |
| 2 | Cloudflare | R2, CDN, Worker, KV, Queue, temporary `workers.dev` host | Check during R2 activation | Upgrade the same account, zone, Worker, and bucket |
| 3 | Neon | PostgreSQL and pooled connections | No | Upgrade in place or logically migrate standard PostgreSQL |
| 4 | Aiven | One free Valkey and one free OpenSearch service | No | Upgrade each service in place |
| 5 | Grafana Cloud | Prometheus/OTLP telemetry and alerts | No | Upgrade in place or move dashboards to self-hosted Grafana |
| 6 | Synadia Cloud | Optional managed NATS JetStream | Check at signup | Upgrade or move standard NATS streams to a production cluster |
| 7 | Oracle Cloud | Optional public ARM VM running k3s | Usually requires identity/payment verification | Redeploy Helm workloads to EKS or another Kubernetes service |
| 8 | ClickHouse Cloud | Use only for a planned 30-day evaluation | Check at trial start | Pay after the trial or restore into another ClickHouse cluster |

Do not open AWS merely to obtain a free experiment cluster. EKS control-plane
hours are billable. Open the AWS organization when a real staging environment is
ready to exercise managed PostgreSQL, Valkey, OpenSearch, Kubernetes, KMS,
backups, availability zones, and provider evidence.

## Production target accounts

The free stack does not change the intended production ownership:

| Account | Production services |
| --- | --- |
| GitHub organization | Repository, protected environments, Actions, OIDC, attestations, release evidence |
| Cloudflare organization | DNS, TLS, CDN, WAF, rate limiting, Workers, KV, Queues, R2 |
| AWS organization | EKS, RDS PostgreSQL Multi-AZ/read replicas, PgBouncer workloads, ElastiCache Valkey, OpenSearch, KMS, Secrets Manager, encrypted S3 backups |
| ClickHouse Cloud organization | Managed analytics after its bounded trial and acceptance gate |
| Grafana Cloud organization | Managed metrics/logs/traces/alerts, or an equivalent self-hosted stack |
| Independent Account Service | OIDC issuer and opaque user identity; owned outside AssetLibrary |

NATS JetStream may remain a managed Synadia service or run as a production
cluster on Kubernetes. Root and Targets application-update keys are offline
assets held by independent custodians, not ordinary cloud account secrets;
Snapshot and Timestamp use separate online KMS/HSM identities only after the App
Update admission gate is opened.

No separate secret-vendor account is required for the first trial. Local secrets
stay outside Git, CI secrets stay in protected GitHub environments, and runtime
secrets use the trial cluster's restricted injection mechanism. Production moves
them to AWS Secrets Manager/KMS without changing application configuration keys.

## Recommended zero-cost topology

```text
GitHub Free
  | Actions / container images / evidence
  v
local Docker Compose, or optional OCI A1 + k3s
  |-- Next.js web
  |-- Rust Axum API and workers
  |-- NATS OSS, unless Synadia Personal is used
  `-- ClickHouse OSS only when analytics is being tested

managed free dependencies
  |-- Neon PostgreSQL
  |-- Aiven Valkey
  |-- Aiven OpenSearch
  `-- Grafana Cloud

large bytes and edge
  Cloudflare Worker/CDN <-> R2 Quarantine and Published buckets
```

Prefer local Docker Compose until a public endpoint is necessary. A free remote
VM adds patching and exposure risk but does not add production-grade evidence.
If OCI A1 is used, containers must first pass a `linux/arm64` build/runtime gate;
do not assume every scanner or security tool image supports ARM.

## Service decisions

### Git and CI: GitHub Free

GitHub Free organizations include 2,000 Actions minutes per month for private
repositories, 500 MB of shared artifact/package storage, and 10 GB cache per
repository. Standard runners are free for public repositories. Without a valid
payment method, over-quota private usage is blocked rather than silently
continuing; configure a zero-cost budget and stop-usage control anyway.

Migration is in place: retain the repository, workflow, OIDC subjects, and
environment names when upgrading to Team or Enterprise. Do not move CI to a
different provider merely for a larger temporary allowance.

Official source: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

### Edge and object storage: Cloudflare Free and R2

Use Cloudflare for the same boundary intended for production:

- R2 Standard: 10 GB-month, 1 million Class A operations, and 10 million Class B
  operations per month; Internet egress is free. Infrequent Access does not
  receive the free tier.
- Workers Free: 100,000 requests per day and 10 ms CPU per invocation.
- Workers KV Free: 100,000 reads, 1,000 writes, 1,000 deletes, and 1,000 list
  operations per day, with 1 GB stored data.
- Queues Free: 10,000 operations per day and fixed 24-hour retention. A normal
  successful message commonly consumes write, read, and delete operations.
- DNS/CDN/TLS can start on the Free plan. A purchased domain is not required for
  an internal trial using `workers.dev`, but is required before stable public
  URLs are treated as production identities.

The upgrade path is in place: the R2 bucket, Worker, KV namespaces, queue names,
and DNS zone remain the same. Set Worker routes to fail closed when they enforce
authorization; exceeding a free Worker limit must not bypass download policy.

Official sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/), and
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

### PostgreSQL: Neon Free

Neon Free currently offers, per project, 100 CU-hours each month, 0.5 GB storage,
up to 2 CU, 5 GB public network transfer, and scale-to-zero after five inactive
minutes. It has no time limit and requires no credit card. The cold resume and
small storage limit make it unsuitable for load or availability evidence.

AssetLibrary continues using standard PostgreSQL, SQLx migrations, and pooled
connection strings. Moving to Neon paid is an in-place plan change. Moving later
to RDS PostgreSQL uses logical backup/restore or replication; no domain model or
repository rewrite is allowed. Database migration and restore must still be
tested before production.

Official sources: [Neon pricing](https://neon.com/pricing) and
[free-to-production FAQ](https://neon.com/faqs/postgres-services-free-to-production).

### Cache: Aiven Free Valkey

Aiven Free Valkey currently provides one single-node service per organization,
1 CPU, 1 GB RAM with `maxmemory` at 50%, monitoring, and backups. It has no time
limit or card requirement, but has no VPC, static IP, integrations, HA, support,
or SLA and may be powered off after inactivity.

It speaks the intended Valkey protocol and upgrades on the same service. Even so,
Valkey remains rebuildable cache/rate-limit/idempotency support; migration must
never depend on copying it as an authoritative business database.

Official source: [Aiven Valkey free tier](https://aiven.io/docs/products/valkey/concepts/valkey-free-tier).

### Search: Aiven Free OpenSearch

Aiven Free OpenSearch currently provides a fixed managed cluster with 4 GB RAM
and 20 GB persistent storage, no credit card, and no trial expiry. It is a
single-node evaluation service, may pause after inactivity, has limited snapshot
retention and lacks production networking/RBAC/SLA features.

The API remains standard OpenSearch. Prefer an in-place Aiven upgrade if desired;
otherwise create a new production index and rebuild it from PostgreSQL. Search is
never a source of truth, so a provider move must not require copying opaque
business state.

Official sources: [Aiven Free OpenSearch](https://aiven.io/free-opensearch) and
[free-tier limits](https://aiven.io/docs/products/opensearch/concepts/opensearch-free-tier).

### Events: NATS OSS first, Synadia Personal optional

Running the open-source NATS server locally or in trial k3s is the closest free
match to the final JetStream contract. Synadia Cloud Personal is an optional
managed alternative: 10 connections, 10 GiB network data, 5 GiB standard
storage, 10 standard streams, and no HA streams. If network quota is exceeded,
connections are dropped until the next cycle or upgrade.

Keep the Postgres transactional outbox authoritative and consumers idempotent.
Then a move from local NATS to Synadia or a production NATS cluster is a stream
replay/republication operation, not a business-data migration.

Official sources: [Synadia Cloud pricing](https://docs.synadia.com/cloud/pricing)
and [NATS downloads](https://nats.io/download/).

### Analytics: ClickHouse OSS, not a perpetual cloud free tier

ClickHouse Cloud currently offers a 30-day trial with USD 300 credits, not an
always-free plan. Do not create the trial until a bounded analytics acceptance
window is scheduled. During ordinary development, use the existing ClickHouse
container or omit cloud materialization while retaining raw events.

ClickHouse SQL/HTTP contracts, schemas, and backups remain portable. A later
ClickHouse Cloud service can be loaded from the raw object archive or native
backup; analytics cannot block downloads or become a transaction source.

Official source: [ClickHouse Cloud](https://clickhouse.com/cloud).

### Observability: Grafana Cloud Free

Grafana Cloud Free currently has no card requirement, 14-day retention, and a
50 GB monthly ingest allowance across its free observability services. It is
appropriate for trial Prometheus/OTLP signals and alerts, not long-term audit
retention.

Keep dashboards, alert rules, recording rules, and OpenTelemetry configuration
in the repository. Standard Prometheus remote-write and OTLP keep migration to
Grafana paid or a self-hosted stack independent of application code.

Official source: [Grafana Cloud pricing](https://grafana.com/pricing/?tab=free).

### Optional public compute: OCI Always Free

OCI Always Free currently includes Ampere A1 allowances equivalent to 2 OCPUs
and 12 GB RAM running throughout a month, restricted to the account home region.
Capacity may be unavailable. It is one ARM failure domain, not Kubernetes HA.

If used, run only stateless containers and trial NATS/ClickHouse data that can be
recreated. Kubernetes manifests remain Helm-based; migration to EKS is a clean
redeployment with new managed dependencies, not a copy of the k3s node disk.

Official source: [OCI Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Considered but not selected as defaults

| Service | Decision |
| --- | --- |
| Supabase Free | PostgreSQL is portable, but free projects can pause and Storage is not the S3 contract. Neon plus R2 is closer to the target boundary. |
| Upstash Redis | Redis-compatible and useful for serverless experiments, but command quotas and serverless billing semantics are less representative than Valkey. Never use it as a JetStream replacement. |
| Render Free | Sleeping instances and ephemeral files are acceptable for demos, but do not exercise the Kubernetes deployment boundary. |
| Free subdomain providers | Suitable for disposable demos only. They do not replace ownership of a production domain or DNS zone. |
| GitLab/Bitbucket/Codeberg | Git migration is possible, but changing repository and CI providers creates work without improving AssetLibrary's current architecture. |
| AWS EKS free trial/credits | Credits expire and EKS control-plane time is billable. Use only for a scheduled staging acceptance run. |
| ClickHouse Cloud trial | Valuable for a bounded test, but it is not a permanent free dependency. |

Official comparison sources: [Supabase pricing](https://supabase.com/pricing),
[Upstash Redis pricing](https://upstash.com/pricing/redis), and
[Render free services](https://render.com/docs/free).

## Portability rules

The free-to-paid path is allowed only while these rules remain true:

1. Object storage uses the S3-compatible port; no R2 SDK types enter domain code.
2. PostgreSQL migrations remain standard and are restorable with documented
   logical/native tools.
3. Valkey contains no sole copy of business facts.
4. OpenSearch indices rebuild from PostgreSQL and events.
5. NATS consumers tolerate duplicate delivery and rebuild from the outbox.
6. ClickHouse rebuilds from raw archives/events and never gates downloads.
7. Telemetry uses OpenTelemetry, Prometheus, and dashboards-as-code.
8. Workloads remain OCI images deployed through Helm; no OCI/AWS host path is a
   product dependency.
9. Provider identities and URLs enter through environment/secret injection, not
   hard-coded source.
10. The external Account Service remains an OIDC boundary and is not replaced by
    any free database vendor's authentication product.

## Account and billing checklist

For every account, record outside the source repository:

- legal owner, technical owner, recovery owner, and billing owner;
- organization/account ID and region, but never tokens or recovery codes;
- MFA/passkey status and two independent recovery paths;
- plan name, free limits, reset time, overage behavior, and payment method state;
- 50%, 80%, and 100% usage notifications where supported;
- a hard zero-cost cap or stop-usage control where supported;
- staging and production project/account separation;
- least-privilege CI and runtime identities with expiry/rotation dates;
- export, backup, deletion, and account-close procedure;
- the date the provider pricing page was last rechecked.

Never paste credentials into an issue, chat, fixture, `.env.example`, shell log,
or evidence bundle. Prefer GitHub OIDC/workload identity over long-lived keys.
Free accounts are not shared root identities; invite named administrators and
keep break-glass recovery separate.

## Exit from the free environment

Move a component to paid staging before any of these conditions:

- external users depend on availability or support;
- a free service can sleep, pause, evict, or disconnect active traffic;
- storage, requests, connections, CI minutes, or telemetry exceed 50% regularly;
- private networking, fixed region/IP, HA, SLA, PITR, audit, or compliance is
  required;
- a performance, recovery, security, provider-authenticity, or production
  promotion gate is being measured;
- Hook/Loom App Update keys or release targets enter the environment.

An in-place plan upgrade is still a production change: take a backup, record
before/after provider identity and configuration, run smoke/restore checks, and
retain rollback evidence.
