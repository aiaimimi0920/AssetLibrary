# ADR-006: Data and event services

Status: Accepted

PostgreSQL is the transactional source of truth. PgBouncer protects connection
capacity and read replicas serve eligible public reads. Valkey supplies
disposable cache, rate-limit, and idempotency support. NATS JetStream carries
at-least-once events after a transactional outbox commit. OpenSearch is a
rebuildable catalog index. ClickHouse stores asynchronous product analytics.

No projection may become the authorization source of truth. Consumer handlers
must be idempotent and every projection must be rebuildable from durable facts.
