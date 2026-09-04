# Architecture Baseline

## Planes

The control plane owns metadata, workflow state, authorization decisions,
search documents, and audit facts. It is a stateless Rust Axum service behind a
load balancer and can scale horizontally.

The data plane owns artifact bytes. Uploads use multipart direct-to-object
storage sessions. Public downloads use immutable digest-addressed CDN URLs;
restricted downloads use a short-lived edge ticket. Neither path streams
artifact bytes through the API.

## Source-of-truth boundaries

PostgreSQL is authoritative for package, release, artifact, review,
moderation, library, download session, install receipt, and rating facts.
Object storage is authoritative for bytes and immutable object metadata.
OpenSearch is a rebuildable search projection. Valkey is disposable cache,
rate-limit, and idempotency support. NATS JetStream is the durable event
transport after the transactional outbox commit. Analytics are asynchronous
and never gate a download.

## Request flow

1. A publisher creates package metadata and an upload session.
2. The client uploads parts directly to the storage provider.
3. The API finalizes the multipart upload and records an immutable artifact
   candidate with a computed digest.
4. A transactional outbox event starts sandbox scanning and manifest checks.
5. Only a verified artifact can enter review and publication.
6. Publication updates Postgres and search projections; the edge serves bytes
   from immutable objects.

Every mutating endpoint accepts an `Idempotency-Key`. State transitions are
monotonic, auditable, and safe to retry.
