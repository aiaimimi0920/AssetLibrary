# Download, Search, and Edge Operations

This document defines the P5 control/data-plane boundary. PostgreSQL remains
authoritative. OpenSearch, Valkey, Cloudflare KV, CDN cache entries, and download
analytics are projections and may be discarded and rebuilt.

## Request paths

| Use case | Control path | Byte path | Shared cache |
| --- | --- | --- | --- |
| Public Art | API resolves a published artifact to an immutable URL | Browser/Loom -> Edge -> R2 | Allowed by digest path |
| Public Capability | API issues an authenticated restricted ticket | Client -> Edge -> R2 | Forbidden |
| Unlisted package | API issues an authenticated restricted ticket | Client -> Edge -> R2 | Forbidden |
| Private package | API verifies active publisher membership, then issues a ticket | Client -> Edge -> R2 | Forbidden |

The API and PostgreSQL never proxy artifact bytes. A library row records a
principal's favorite or installed projection; it is never accepted as download
authorization.

## Public downloads

`GET /v1/public/artifacts/{artifact_id}/download` returns an immutable URL only
for an explicitly publication-bound, verified, published, visible, non-blocked
Art artifact. Another verified artifact under the same Release is not eligible.
The path is:

```text
/public/sha256/<lowercase-sha256>/<safe-filename>
```

Before reading cache or R2, the Edge Worker loads `public:<digest>` from the
policy KV namespace and validates its exact publisher, package, release,
artifact, signing-key, digest, canonical object key, and filename shape. It then
checks all applicable `revoked:*` keys. Missing, malformed, or unavailable policy
data fails closed.

Only full public `GET` responses enter the Worker Cache API. The cache key is
exactly origin plus pathname; query parameters, cookies, authorization headers,
and principal data are excluded. Range and conditional requests bypass this
explicit cache and are evaluated against object metadata so a cached `200`
cannot be mistaken for a `206` or `304`.

## Restricted tickets

`POST /v1/me/artifacts/{artifact_id}/download-sessions` requires the external
identity adapter and an `Idempotency-Key`. The response returns the URL and token
in separate fields with `Cache-Control: no-store`; clients send the token as
`Authorization: Bearer`, never in the URL.

The compact HMAC-SHA256 ticket binds:

- issuer, audience, purpose, issue/not-before/expiry times;
- session and nonce;
- publisher, package, release, artifact, and signing key;
- client type, SHA-256 digest, canonical R2 object key, and exact edge path.

The API stores only the SHA-256 hash of the bearer token. Idempotent replay
reconstructs the same claims from the database and verifies the reconstructed
hash. Raw tokens, account principals, cookies, and OIDC credentials are not
written to download events or audit details.

The Edge Worker checks publisher, package, release, artifact, signing-key,
digest, session, and nonce revocations before accessing R2. Restricted responses
are always `private, no-store` and never use shared cache.

Cloudflare KV is eventually consistent. Removing the public allowlist before
publishing new policy and adding revocations before other changes minimizes
unsafe windows, but it does not prove instantaneous global revocation. A
production emergency-revocation runbook must combine KV projection, CDN purge,
and, where required, a WAF/HMAC deny rule. That cloud propagation gate remains a
staging acceptance item.

## Range and response contract

The worker accepts `GET`, `HEAD`, and `OPTIONS`. It supports a single bounded
byte range, including suffix ranges. Valid partial reads return `206`,
`Content-Range`, the selected `Content-Length`, and `Accept-Ranges: bytes`.
Malformed, multiple, or unsatisfiable ranges return `416` and
`Content-Range: bytes */<size>`.

All byte responses set a safe attachment filename, `ETag`, explicit content
type, CORS headers, and `X-Content-Type-Options: nosniff`. `HEAD` has the same
status and headers as the corresponding read without a body.

## Download analytics boundary

After a successful public or restricted `GET`, the worker submits
`assetlibrary.edge.download_served.v1` to the `DOWNLOAD_EVENTS` Cloudflare Queue
through `waitUntil`. The event contains artifact identifiers, digest,
public/restricted class, optional restricted session/client, range start, and
bytes served. New producers also attach the response request UUID, an optional
incoming W3C trace ID, and whether the response came from Cache API. Public cache
hits emit the same download fact; `HEAD` and `304` do not count as completed
downloads. The event intentionally excludes the bearer token, principal, IP
address, cookie, and user agent.

Queue submission errors are logged with bounded dependency/request identifiers
after scheduling and cannot change the download response. This is the P5
asynchronous collection boundary. Durable raw
archive retention, ClickHouse ingestion, aggregation, deduplication, and
install-success attribution remain P8 work; authorization events must not be
counted as completed downloads.

## Search provider selection

OpenSearch remains the default. An explicit optional PostgreSQL provider is
available for the same public search API; see [POSTGRES_SEARCH](POSTGRES_SEARCH.md)
for its literal Unicode matching, ordering/cursor differences, eligibility,
deadlines and rollback contract. It performs no search cache/index read and does
not remove the indexer or any Edge authorization/revocation work below.

## Default OpenSearch projection

An optional [Edge-policy-only indexer mode](operations/INDEXER_EDGE_POLICY_MODE.md)
retains automatic authorization/revocation while PostgreSQL serves search, without
initializing OpenSearch or Valkey. The existing default and rebuild remain below.
Follow that document's consumer-first upgrade and mode rollback sequence; old
binaries do not understand the new signing-key invalidation reason.

The indexer consumes `assetlibrary.catalog.invalidated.v1` from one durable
JetStream consumer. Event payloads are signals only: every projection is loaded
again from PostgreSQL and validated against the exact publication binding,
visibility, publisher, artifact, signing-key, canonical-digest, and blocklist
invariants.

For an incremental event the order is:

1. upsert or delete the OpenSearch document with `refresh=wait_for`;
2. reconcile edge allowlist/revocation KV state, when configured;
3. delete the package cache entry and increment the Valkey catalog generation;
4. record the event ID in `projection_events`;
5. acknowledge JetStream.

This ordering prevents an API request from caching a stale OpenSearch result
under a new Valkey generation. A failed dependency leaves the event unrecorded
and is retried. Invalid event envelopes are terminally acknowledged rather than
poisoning the durable consumer.

The public search API uses a bounded query, exact kind/tag filters, strict
projection decoding, deterministic `_score`, update-time, and package-ID order,
and an opaque `search_after` cursor. Valkey uses cache-aside with 60-90 second
deterministic TTL jitter. Cache failure is fail-open to OpenSearch; invalid or
unavailable search data returns `503`, never a false empty result.

## Rebuild runbook

Use the same database, OpenSearch credentials, index alias, and optional edge
policy configuration as the long-running indexer:

```powershell
cargo run -p assetlibrary-indexer-worker --locked -- rebuild
```

The command takes the same PostgreSQL advisory lock as incremental projections,
creates a new `<prefix>-<timestamp>-<random>` index, scans bounded PostgreSQL
pages, refreshes the completed index, then atomically moves the stable alias.
Queued events are applied only after the swap, so an event already recorded
against the old alias cannot be lost behind the rebuilt snapshot. Before alias
swap, a failed build deletes only the exact unaliased index it created. After the
swap it records the active index and increments the Valkey generation.

Search rebuild deliberately does not rewrite Edge KV. Edge policy is a separate
authorization projection updated by catalog events; a future cloud recovery
operation must replay those events or use a dedicated resumable reconciliation
job. This avoids presenting a non-atomic search rebuild as an Edge rollback. The
indexer never treats OpenSearch or Valkey as authorization sources.

Do not wildcard-delete a shared OpenSearch cluster. List the stable alias and
delete only exact, reviewed AssetLibrary versioned index names after the rollback
window. `scripts/Test-SearchRuntime.ps1` uses a unique prefix and removes only
the exact indices it created; it proves search pagination, NATS invalidation,
cache-generation movement, and rebuild recovery after deleting the active test
index.

## Deployment and secrets

The Kubernetes API secret group contains OIDC, object-store, ticket-signing,
OpenSearch, and Valkey configuration. The indexer has a separate least-privilege
secret containing PostgreSQL read/projection access, JetStream consume access,
Valkey invalidation, OpenSearch write access, and Cloudflare KV write access.
The indexer must never receive the edge ticket-signing key.

Outside development, OpenSearch, Valkey, NATS, download origins, and Cloudflare
API transport must use TLS. Invalid OpenSearch certificates are accepted only
for loopback development.

## Provider references

- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare cache and R2](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)
- [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Cloudflare KV write](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/methods/update/)
- [OpenSearch aliases](https://docs.opensearch.org/latest/im-plugin/index-alias/)
- [OpenSearch reindexing](https://docs.opensearch.org/latest/api-reference/document-apis/reindex/)
