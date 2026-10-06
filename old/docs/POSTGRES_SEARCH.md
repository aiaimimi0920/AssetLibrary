# Optional PostgreSQL public search

This is the first reversible implementation of
[ADR-009](ADR/ADR-009-managed-postgres-small-scale.md), not a managed-database
migration or a new deployment. The API was already Rust/SQLx before this change.
No memory reduction is inferred from adding this provider.

## Selection and rollback

`ASSETLIBRARY_SEARCH_PROVIDER=postgres` selects PostgreSQL for
`GET /v1/public/search`. `DATABASE_URL` must be supplied to the backend, including
in development. The provider reuses the API's existing pool (maximum 20
connections), without exposing credentials to Web/EXE/CLI clients. It does not
create database resources or select a hosting vendor.

Omitting the variable, or setting `opensearch`, retains the existing OpenSearch
provider and configuration requirements. Unknown provider names fail startup.
PostgreSQL mode ignores unused OpenSearch/Valkey search settings, including stale
ones; all nondevelopment identity, object-store, download and closed App Update
requirements still apply. Set the selector back to `opensearch` and restart with
the existing complete legacy settings to roll back. No schema migration is
introduced by this slice.

Do **not** stop the indexer, NATS or Valkey because PostgreSQL search works. The
indexer still updates Edge authorization/revocation, and existing event/scanning
paths remain in use. Reducing actual service topology needs another change.

## Search and response contract

- Same `/v1/public/search` route and versioned `PackagePage` response; no extra
  metadata or database fields are returned
- `q`: trimmed literal substring across package name, summary, description and
  publisher display name, using PostgreSQL `lower`/`strpos`. `%`, `_`, quotes and
  backslashes are literal characters, never SQL or wildcard syntax
- Case conversion follows the PostgreSQL database collation. Chinese literals
  work without a tokenizer; there is no stemming, segmentation, fuzzy matching,
  relevance score or promise of OpenSearch-equivalent ranking
- `kind` and `tag`: exact filters combined with the text query; tag matching is
  case-sensitive. Query text does not implicitly search tags
- Existing input bounds remain: query at most 200 UTF-8 bytes after trimming,
  tag at most 100 bytes, no control characters, limit 1–100, default 24
- Order: package `updated_at DESC`, then UUID `id ASC`. Every row has a unique
  tie-breaker; pages fetch at most `limit + 1` bounded metadata records
- Public eligibility is the shared catalog SQL: published/public package,
  active publisher, published release, explicitly bound verified artifact,
  canonical object identity, active signing key, and applicable blocklists
- No search-result cache or eventual index is used by this provider. Each SQL
  statement reads current database visibility at its statement snapshot;
  download authorization still independently rechecks access. This does not
  claim instantaneous global Edge/CDN revocation
- This is keyset pagination, not a snapshot spanning all pages. A concurrent
  metadata update can move a row; clients restart search when refreshing a list

The opaque base64url cursor contains the provider/version (`postgres-v1`),
precise timestamp, UUID and a SHA-256 fingerprint of normalized query/kind/tag.
It is a query position, not an authorization token or secret. The server validates
shape and query binding; clients must not parse or reuse it with different
filters. Page size can change. Legacy OpenSearch and PostgreSQL cursors are
mutually rejected with `400`, so switching providers requires restarting pages.

All SQL inputs are bound parameters. This initial small-catalog literal scan
uses existing schema/indexes and a deadline rather than claiming arbitrary-size
full-text scalability. A future text index needs measured query plans and a
separate compatibility decision.

## Failure and resource bounds

Each search uses a read-only transaction with `SET LOCAL statement_timeout =
'1500ms'` and `lock_timeout = '1000ms'`, plus a two-second application deadline
including pool acquisition. A connection guard is installed before `BEGIN` and
recycles the connection only after `COMMIT` completes; any interrupted/error path
closes that connection, including cancellation during the BEGIN response.
Transaction-local settings cannot change another
pool borrower's defaults. The server statement timeout bounds an executing query
even if the request future is cancelled; a timeout is not proof that every
network operation has already stopped.

Malformed input/cursor returns `400`; database failure, timeout or invalid
projection returns `503`, never an empty success. A genuine empty match returns
an empty `items` array. Dependency telemetry uses bounded labels without query
text, principals, URLs or secrets. No package bytes, scanning or quota charges
are executed by the search request.

## Verification

Ordinary Rust tests cover configuration selection, old-provider requirements,
HTTP validation/error/response shape, cursor version/filter binding and pool wait
bounds. The explicitly ignored SQL gate must be run separately; ignoring it is
not success:

```sh
ASSETLIBRARY_SEARCH_TEST_DATABASE_URL=postgresql://TEST_USER@127.0.0.1:TEST_PORT/assetlibrary_sitemap_test \
  cargo test -p assetlibrary-api --locked search_postgres_gate -- --ignored --nocapture
```

Only a disposable loopback server and the existing CI test database name are
accepted. The gate uses temporary tables/harmless metadata mirroring the relevant
production columns and publication bindings, with one connection. It never reads
`DATABASE_URL`, migrates a real database or stores package bytes/private keys.
This focused query gate does not replace production-schema migration tests.

The gate exercises real PostgreSQL SQL and the actual HTTP handler: Chinese and
literal punctuation, exact filters, tied timestamps, page sizes/termination,
publication/visibility/signing-key prerequisites, all applicable revocations,
revocation between pages, server timeout and pooled-session recovery. A local
wire proxy delays a real BEGIN response to verify that request cancellation
discards that backend and that the next borrower starts in autocommit. CI runs it
against the same pinned disposable PostgreSQL service as the sitemap gate.

Resource measurements and managed-provider compatibility are separate acceptance
work. Unit/integration passes do not establish a production RSS number, capacity,
HA, live migration, provider compatibility or full Hook/Loom integration.

## Optional Edge-only worker

The [Edge-policy-only indexer mode](operations/INDEXER_EDGE_POLICY_MODE.md) retains
automatic policy/revocation consumption without OpenSearch/Valkey configuration.
It is explicit, does not change deployment defaults, and has separate processed
markers/durables. Use its consumer-first upgrade and full-mode rebuild/rollback
sequence; changing the API search provider alone does not switch the worker.
