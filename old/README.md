# AssetLibrary

AssetLibrary is Neuro's independent distribution service for installable Art
packages, Capability packages, and future application updates. It provides a
web catalog and machine-facing APIs while keeping the account system in a
separate service.

## Current development direction

The accepted target is a small control-plane service backed by **managed
PostgreSQL**, for roughly 100 users and one or two active users. Browser,
Hook/Loom EXE and CLI clients use bounded API queries after applicable identity,
authorization and optional quota checks; no client gets database credentials or
arbitrary SQL access. Quota/billing policy is not defined. File bytes stay in
object storage/CDN and scanning stays isolated and asynchronous.

See the current [development goals](DEVELOPMENT_PLAN.md),
[ADR-009](docs/ADR/ADR-009-managed-postgres-small-scale.md), and
[development standard](docs/DEVELOPMENT_STANDARD.md).
The database supplier and Web/API hosting locations are undecided. PlanetScale
PostgreSQL through Cloudflare is a candidate only; D1 is not selected.
No paid service, real credential, data migration or deployment is part of this
architecture change.

This is a target, not a completed migration: the current runtime still uses
OpenSearch/Valkey search and NATS workers. An [optional PostgreSQL public-search provider](docs/POSTGRES_SEARCH.md) is
available while retaining the old provider/default and Edge revocation path. A local
[PG + Edge-only component resource baseline](docs/operations/SMALL_CANDIDATE_RESOURCE_BASELINE.md)
now covers idle, one small scan and two query clients. Small deployment profiles,
whole-stack peaks and production capacity/budgets remain pending. App Update
production admission remains closed.

## Current implementation status

The P0-P9 labels below refer to the
[historical plan](docs/history/DEVELOPMENT_PLAN_2026-09-04.md).
They describe existing foundations and recorded acceptance boundaries, not
proof that the new target is deployed or production-ready.

P0-P4 and the P5 control/data-plane implementation are covered by local gates:
contracts, direct
multipart upload, sandboxed verification, immutable artifact promotion,
revision-bound review, publication, two-person moderation, principal-scoped
library state, rebuildable search, and public/restricted edge downloads. P5
cloud acceptance is partially exercised by the first real free-tier
R2/Worker/KV/Queue public-path smoke; purge propagation and CDN metrics,
ClickHouse materialization, the remaining P8-P9 total gates, and
production-environment acceptance remain open. P6 now has a real public read
slice: server-rendered
catalog/search/package/publisher pages consume versioned package, release,
compatibility, permission, and explicitly approval-bound artifact projections
while distinguishing empty results from dependency failures; see
[`docs/PUBLIC_WEB.md`](docs/PUBLIC_WEB.md). P6 also includes authenticated,
role-scoped Publisher membership and owned draft APIs with cursor pagination,
SemVer enforcement, idempotency, immutable creator facts, and transactional
audit/outbox events. A dynamic Publisher Console now exchanges one configured
session cookie with the independent Account Service, renders authorized owned
packages, and creates Package/Release drafts without exposing the external
principal or bearer to browser code; see
[`docs/PUBLISHER_API.md`](docs/PUBLISHER_API.md). The first Operator Review slice
now provides a stable queue, sanitized evidence detail, current-revision review
history, and a decision form through the same external Account Service boundary;
see [`docs/OPERATOR_CONSOLE.md`](docs/OPERATOR_CONSOLE.md). The Operator Console
also exposes unresolved moderation cases, sanitized report/action/appeal facts,
two-person downlisting approval, and appeal resolution. The Publisher Console
now lists only applied cases in the current account's active memberships,
exposes bounded enforcement and resolution facts, and submits one idempotent
appeal without exposing internal reports or principals. Publisher Release
history/detail and draft compatibility/permission editing now use optimistic
concurrency, idempotent audit/outbox mutations, and server-only account exchange
without serializing creator identity to React Flight. Its supply-chain workspace
also exposes bounded Artifact state, current Submission, and de-identified review
feedback, and can submit a verified Artifact without exposing object keys, raw
scanner evidence, or reviewer principals. The browser now incrementally hashes a
ZIP, obtains metadata-only control-plane signatures, uploads three bounded parts
in parallel directly to the quarantine object store, and completes into the
untrusted scan queue without proxying bytes through Next or Axum. Publishers can
also list, register, and irreversibly revoke Ed25519 public keys in a private
workspace; private key material never enters AssetLibrary, and key mutations are
role-scoped, idempotent, audited, and emitted through the transactional Outbox.
Draft Package metadata editing now preserves slug/kind identity, locks lifecycle
and role state, rejects stale timestamps, and records idempotent audit/Outbox facts
through the same server-only Account boundary. Multipart upload recovery now
persists only a bounded, non-secret tab-local descriptor; after refresh it requires
the same ZIP, recomputes its full digest, re-authorizes current membership, lists
object-store-authoritative parts, and uploads only missing or mismatched parts.
Domain-split OpenAPI clients are generated and byte-checked in CI, while strict
runtime parsers remain at untrusted HTTP boundaries. Playwright now exercises the
public catalog, signing-key workspace, Package-edit journey, and reload-resumable
upload at desktop/mobile widths with keyboard/focus, Axe, overflow, privacy, Linux
CI baselines, and separately verified Windows baselines.
Public package discovery now includes escaped package-level JSON-LD and runtime
sitemap index/leaves backed by bounded, fixed UUID catalog partitions. Private
robots rules preserve public Publisher crawling; errors and overfull partitions
fail explicitly. See [`docs/PUBLIC_DISCOVERY.md`](docs/PUBLIC_DISCOVERY.md) for
canonical-origin configuration, capacity and acceptance boundaries.
P7 now includes a strict Rust Loom adapter with resumable direct downloads,
raw/canonical digest and Ed25519 verification, host capability negotiation,
transactional activation/rollback, bounded offline receipt synchronization, and
an Account-Service-independent trust boundary. The Publisher CLI implements
atomic Manifest initialization, deterministic signed packaging, validation,
digest inspection, package/release creation, resumable direct multipart upload,
submission, and status queries without emitting credentials or object-store
internals. The exact integration and Hook not-applicable boundary is documented
in [`docs/LOOM_CLIENT_AND_PUBLISHER_CLI.md`](docs/LOOM_CLIENT_AND_PUBLISHER_CLI.md).
P8 now has a shared Rust Prometheus/OpenTelemetry layer, W3C propagation across
HTTP and JetStream, bounded dependency/cache metrics, Next.js server tracing,
Cloudflare Edge request correlation, Helm monitoring resources, dashboard and
alerts, executable k6 profiles, five local data-system restore rehearsals, and a
guarded local PostgreSQL/Valkey/OpenSearch degradation drill. A versioned cost
policy requires measured provider exports and independent 50/80/100% alert routes.
A strict cloud evidence schema and adversarial verifier now bind required load
profiles, telemetry, generator health, provider cost exports, alert delivery, and
file hashes without allowing local k6 output to claim P8 eligibility. These are
implementation foundations and local evidence, not production proof: 2x/24-hour
soak, 5x burst, managed/cloud restores, regional drills, actual cost exports and
alert delivery, provider authenticity, and full cloud evidence remain open.
P9 now has a same-commit reusable security/quality release path, digest-pinned
builder/runtime/scanner images, bounded OSV/pnpm/secret/CodeQL/Trivy gates, source
and image SPDX output, keyless image signing, SLSA/SBOM attestations, and a strict
candidate evidence assembler. The candidate bundles all image digests, scans,
attestations, migrations, CI evidence, and digest-bound default plus progressive
Helm renders. The progressive render statically verifies the pinned Argo
Rollouts/NGINX 5/25/100 and fail-closed Prometheus-analysis contract; it does not
claim that a controller ran or traffic moved. The schema permanently marks
production eligibility and App Update false. Protected release-environment
settings, provider authenticity, P8 cloud acceptance, real canary observations
and automatic rollback remain open. The independent App Update path now has an
accepted six-repository TUF architecture, a pinned native Rust client, strict
signed Target/Control contracts, and dynamically signed adversarial tests, but
no production Roots or host activation evidence; see
[`docs/operations/RELEASE_SECURITY_RUNBOOK.md`](docs/operations/RELEASE_SECURITY_RUNBOOK.md).
The promotion evidence schema/verifier already binds candidate, P8, provider
deployment, ordered canary windows, rollback evaluation, database checkpoint,
and smoke evidence, but intentionally cannot turn repository fixtures into a
production approval.
The App Update client enforces HTTPS origins, an embedded bootstrap Root,
persistent rollback metadata, safe expiry, bounded metadata, consistent
snapshots, independent 2-of-3 Root/Targets roles, exact product/channel/platform
identity, monotonic release and policy counters, revocation, kill switch, and
atomic verified staging. These are local foundations only; the API, Helm, and
release candidate continue to disable App Update.
Development fixtures are explicitly marked and are never a production identity
or storage implementation.

A [local same-artifact Art API-to-Edge gate](docs/operations/ART_ISOLATED_FLOW_VALIDATION.md)
now exercises actual signed multipart upload, Scanner verification, independent
review/publication, PostgreSQL search, the real Edge handler's downloaded bytes,
and automatic Outbox/NATS/indexer policy projection after key revocation. It also
checks dependency-failure retry and old-provider mode rollback. See the optional
[Edge-policy-only mode](docs/operations/INDEXER_EDGE_POLICY_MODE.md). It uses isolated
local storage and development identities, not production/cloud acceptance.

## Repository layout

- `apps/web`: Next.js public catalog and publisher/operator consoles.
- `services/api`: Rust Axum control-plane API.
- `workers`: Rust worker binaries for scanning, indexing, and statistics.
- `crates`: shared domain, application ports, adapters, and contract types.
- `contracts`: OpenAPI and AsyncAPI specifications.
- `packages/api-client`: domain-split generated TypeScript API clients.
- `schemas`: JSON Schemas for externally exchanged documents.
- `deploy`: local and production deployment descriptors.
- `docs`: architecture decisions, threat model, runbooks, and ADRs.

The P4 authorization and state-transition rules are documented in
[`docs/REVIEW_AND_MODERATION.md`](docs/REVIEW_AND_MODERATION.md).
The P5 byte/search boundary and rebuild runbook are documented in
[`docs/DOWNLOAD_SEARCH_EDGE.md`](docs/DOWNLOAD_SEARCH_EDGE.md).
The P6 public SSR routes and their current boundary are documented in
[`docs/PUBLIC_WEB.md`](docs/PUBLIC_WEB.md).
Public Art browser download preparation and its direct Edge handoff are documented
in [`docs/PUBLIC_ART_DOWNLOAD.md`](docs/PUBLIC_ART_DOWNLOAD.md).
The P6 authenticated Publisher API boundary is documented in
[`docs/PUBLISHER_API.md`](docs/PUBLISHER_API.md).
The P6 Operator Review API and browser boundary is documented in
[`docs/OPERATOR_CONSOLE.md`](docs/OPERATOR_CONSOLE.md).
The P7 Loom adapter, Publisher CLI, offline/rollback behavior, and Hook inventory
are documented in
[`docs/LOOM_CLIENT_AND_PUBLISHER_CLI.md`](docs/LOOM_CLIENT_AND_PUBLISHER_CLI.md).
P8 observability, load, backup/restore, and cost operations are documented in
[`docs/operations/OBSERVABILITY_RUNBOOK.md`](docs/operations/OBSERVABILITY_RUNBOOK.md),
[`docs/operations/LOAD_TEST_PLAN.md`](docs/operations/LOAD_TEST_PLAN.md),
[`docs/operations/BACKUP_RESTORE_RUNBOOK.md`](docs/operations/BACKUP_RESTORE_RUNBOOK.md),
[`docs/operations/COST_BUDGET_RUNBOOK.md`](docs/operations/COST_BUDGET_RUNBOOK.md),
and the account/free-tier migration guide in
[`docs/operations/CLOUD_ACCOUNT_AND_FREE_TRIAL_RUNBOOK.md`](docs/operations/CLOUD_ACCOUNT_AND_FREE_TRIAL_RUNBOOK.md).
The exact scope and limitations of the first provider deployment are recorded in
[`docs/operations/FIRST_STAGING_DEPLOYMENT_EVIDENCE.md`](docs/operations/FIRST_STAGING_DEPLOYMENT_EVIDENCE.md).
P9 source, image, candidate-evidence, production-promotion, rollback, and disabled
App Update boundaries are documented in
[`docs/operations/RELEASE_SECURITY_RUNBOOK.md`](docs/operations/RELEASE_SECURITY_RUNBOOK.md).

## Local development

Prerequisites: Rust stable, Node.js 22.23+, pnpm 10+, and Docker for the local
dependency stack. Copy `.env.example` to `.env`; never commit local credentials.

```powershell
cargo run -p assetlibrary-api
pnpm --dir apps/web dev
```

The API listens on `http://127.0.0.1:8080` and exposes `GET /healthz`,
`GET /readyz`, and the public catalog endpoints. Server-rendered web routes use
`ASSETLIBRARY_API_URL` and fall back to the loopback API. Private Publisher and
Operator routes additionally require `ASSETLIBRARY_ACCOUNT_SESSION_URL`; the bearer
returned by that server-to-server exchange is never a public environment value.

## Product boundary

AssetLibrary does not implement account registration, password login, MFA,
billing, or a general file-hosting API. It accepts an externally issued
principal reference and issues short-lived download authorization at the edge;
the API is not in the public artifact-byte path.
