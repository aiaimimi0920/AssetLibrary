# Redis client 1.7 timeout and retry contract

API and indexer upgrade together from redis 0.32.7 to 1.7.1, retaining Tokio and
Rustls support. No Redis/Valkey server, database schema, queue, Edge revocation
path or credentials are changed. There is no production deployment in this PR.

The new client defaults to a 500 ms response timeout and a 1 s connection
timeout. A loopback reproduction applied INCRBY before delaying the ACK 750 ms:
old default calls succeeded, new default calls timed out despite both writes
having executed. Indexer invalidation now sets a 2 s connection/setup timeout
and 2 s timeout per response explicitly, never infinite waiting. Its sequential
connect/DEL/INCR stages have a nominal 6 s I/O budget; rebuild connect/INCR has
4 s. Runtime scheduling and unrelated projection stages are not included in
these budgets. The consumer's 60 s ack_wait and existing retry limit are unchanged.

A timeout/disconnect means **unknown execution outcome**, not "no write". The
consumer still returns failure before mark_processed/commit and retries through
its existing NAK path. DEL is idempotent, and a repeated generation INCR may
advance the cache epoch an extra time. The generation is solely an invalidation
namespace, not accounting, billing, quota or an authoritative event count:
extra advancement discards additional cache entries without replaying a domain
mutation. No increment is automatically compensated and no error is treated as
an acknowledged projection.

Four loopback RESP tests run against the real Cache implementation and pass on
both old/new clients with the same explicit budgets: delayed ACK beyond the new
default, applied-then-timeout followed by a fresh retry, disconnect after apply,
and failed DEL that must not run INCR. Fixture tasks and sockets have deadlines
and are joined on success or aborted on failure. This simulates the cache side
of message retry; it is not a claim of newly exercised live NATS/Edge acceptance.

The API's optional search cache keeps its existing outer 75 ms budgets, fallback
and authoritative eligibility filtering. Those tighter bounds dominate the new
client defaults. The old provider/PG provider selection is unchanged.

Rollback the two dependency manifests and Cargo.lock together. Retain the
indexer's explicit bounds, adapting the old client's config setters back from
`Some(Duration)` to `Duration` (as exercised by the old-version tests), rather
than reverting to indefinite I/O. Cache key shapes and the monotonic namespace
remain readable across versions; no objects or data must be deleted. Errors
remain sanitized by the existing projector boundary; do not log Redis URLs or
authentication data.
