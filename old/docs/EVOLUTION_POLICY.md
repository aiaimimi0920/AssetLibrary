# Compatibility, idempotency, event, and revocation policy

Public HTTP APIs use a major path (`/v1`). Additive optional fields are allowed
within a major version. Removing or changing field meaning requires a new major
contract and a documented migration window. JSON documents include
`schema_version`; readers reject unsupported major versions and ignore unknown
optional fields only where the schema permits them.

All mutating HTTP operations require `Idempotency-Key`. The server binds a key
to principal, operation, and normalized request digest. Reusing a key with a
different request is a conflict. Successful responses and deterministic client
errors may be replayed for the retention window; transient server failures are
retryable.

Events use versioned subjects or envelope schema versions. Producers commit the
business fact and outbox record in one PostgreSQL transaction. Consumers record
processed event IDs and tolerate redelivery. A breaking event change publishes
both versions until all durable consumers have migrated.

Suspension blocks new publication. Yank hides a release from resolution while
preserving explicit historical references according to policy. Revocation
blocks new download tickets and propagates to CDN, search, and client blocklists.
App Update revocation additionally follows TUF freshness and rollback rules.

Migration `0011_published_release_artifacts` is an additive security expansion.
It backfills a reviewed Submission tuple when available, accepts only one
unambiguous legacy artifact otherwise, and aborts on ambiguous published data.
The new readers and publication writer must be deployed together; rolling back
to a reader that treats every verified sibling as published is not an acceptable
production rollback. Rollback is service disablement plus database snapshot
restore, not dropping the binding table while published releases still exist.
