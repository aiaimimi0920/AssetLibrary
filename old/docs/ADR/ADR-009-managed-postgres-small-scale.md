# ADR-009: Managed PostgreSQL and a small-scale control plane

Status: Accepted target; implementation and deployment incomplete

Date: 2026-10-02

Supersedes the mandatory large-scale deployment topology in ADR-006 and the
historical P0-P9 plan. The security, identity, immutable-artifact, audit,
idempotency, and revocation invariants of earlier ADRs remain in force.

## Context

The initial operating scenario is approximately 100 users, usually one or two
active at a time. The core need is uploading applications/Capability/Art
packages, storing text and tag metadata, querying a catalog, and authorizing
safe downloads. Hook/Loom desktop executables still generate login, identity
refresh, catalog/version/revocation checks, and package traffic. Website
concurrency alone is not the whole workload.

The repository currently has a substantially broader topology: PostgreSQL,
OpenSearch/Valkey search, NATS workers, Edge policy projection, analytics and
multi-replica deployment templates. Their presence is not evidence that this
workload requires every service or the resources reserved by those templates.

## Decision

1. Production defaults to **managed PostgreSQL**, not an operator-maintained
   database cluster. SQLx/PostgreSQL remains the application data boundary.
   No D1 rewrite or provider-specific database API is selected.
2. The managed provider and frontend/backend hosting locations are undecided.
   PlanetScale PostgreSQL billed through Cloudflare is only a candidate.
   No account, subscription, paid resource, credential, migration, or deployment
   is created by accepting this ADR. Future location selection should consider
   measured latency, data requirements and cost, without promising a region.
3. Start with a small single-instance Web/API topology and bounded, isolated
   scanning work. No initial HA or zero-downtime claim follows from this choice.
   Managed database backup/restore and application recovery still need proof.
4. Prefer PostgreSQL for simple directory queries. OpenSearch, a separate
   message broker, multi-replica Kubernetes and ClickHouse are not mandatory
   target components just because earlier templates included them. Replacing
   a working dependency requires its own tested, reversible transition.
5. The control plane handles bounded metadata. Uploaded bytes remain in private
   quarantine until verified; downloads remain direct-to-object-store/CDN.
   Heavy package processing runs asynchronously in an isolated worker, not
   in every query request or by loading all packages into an API process.

## Identity, authorization, quota, and query boundary

For protected operations the flow is:

```text
Web / Hook EXE / Loom EXE / Publisher CLI
  -> backend API
  -> authenticate externally issued identity
  -> authorize the action and resource in AssetLibrary
  -> optional quota policy, if separately defined
  -> bounded parameterized query against managed PostgreSQL
  -> permitted fields and bounded page returned by the API
```

Authentication establishes identity; authorization checks publisher membership,
roles, visibility, release and artifact state, and revocation. They are separate
checks. Public catalog reads may be anonymous, but still apply the complete
public-visibility policy. Private data never becomes public through a search
provider switch.

Quota is only a policy boundary at this stage: there is no new billing model,
price, entitlement scheme, or per-query charge. If later implemented, quota
accounting needs concurrency consistency, idempotency and explicit failure/
retry semantics. Rate limiting and billable usage must not be conflated.

The client never receives a database URL, password, database key, or arbitrary
SQL interface. Credentials are service-only secrets. Clients submit supported
filters and cursors; the API uses parameter binding, query/time/result bounds
and a bounded connection pool. It does not return all rows or hydrate all package
archives to answer a catalog query. Logs, bundles and client-visible errors must
not expose database credentials or connection strings.

The Account Service remains independent. AssetLibrary uses opaque PrincipalRef
and does not acquire password, registration, MFA or account-session tables.

## Preserved safety and compatibility

- Maintain quarantine, bounded parsing, necessary malware scanning, signature/
  digest verification, explicit publication binding, review and immutable objects.
- Preserve current role/tenant/resource checks, download tickets, fail-closed
  revocation, auditable state transitions and idempotent writes/outbox events.
- Keep App Update disabled in production until ADR-008 TUF/host-activation gates
  pass; application-distribution scope is not permission to bypass that gate.
- Do not remove NATS, the indexer or Valkey in the PostgreSQL search change.
  The indexer also maintains Edge authorization/revocation projections.
- Preserve the existing search provider as a reversible option. Document any
  differences in text matching, relevance and opaque cursor semantics.
- Keep API and client contracts versioned. Hook/Loom integration needs separate
  end-to-end tests; existing local client foundations are not integration proof.

## First implementation and acceptance

[The current development plan](../../DEVELOPMENT_PLAN.md) defines staged work.
The first code slice is an **optional** PostgreSQL provider for the existing
public search endpoint; the existing provider/default is retained initially.

The PG provider must share catalog eligibility rules and use bounded literal
Unicode substring matching plus exact kind/tag filters. This is not a Chinese
segmentation engine or a promise of OpenSearch-equivalent relevance. Stable
ordering and a provider/version-specific opaque cursor must be explicit.
Acceptance includes Chinese and literal wildcard inputs, pagination ties and
boundaries, invalid/cross-provider cursors, publication and signing-key checks,
all applicable revocations, and dependency failure/timeouts. A real disposable
PostgreSQL gate must run; a skipped test is not a pass.

Each later dependency replacement needs a separate design and tests. A queue
replacement must retain durable claims/leases, retries, dead letters, idempotency,
replay and revocation ordering. A smaller deployment profile needs measured
capacity, backup/restore and failure evidence before production use.

## Evidence and consequences

Single-instance deployment deliberately trades availability for simplicity.
Database hosting shifts operational responsibility; it does not establish any
measured API/scanner RSS reduction. No RAM minimum or savings estimate is
approved by this ADR. The old scanner `2Gi` request is scheduling configuration,
not RSS; a 64 KiB streaming buffer is not whole-process peak memory.

Measure harmless fixtures, idle load, bounded concurrent queries, scan workload,
queue recovery and download bytes separately. Record commit, toolchain, fixture,
concurrency, RSS, CPU, temporary disk and elapsed time. ZIP central directories,
JSON materialization and timed-out blocking tasks that remain alive require
specific checks. Report measured, failed and not-run stages distinctly.

Current implementation references: `services/api/src/catalog.rs`, `search.rs`,
`config.rs`, `main.rs`; `workers/indexer`; `workers/scanner`; and `deploy`.
These sources remain the evidence of what runs until subsequent PRs change them.
