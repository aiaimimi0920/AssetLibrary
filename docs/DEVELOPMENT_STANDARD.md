# Development standard

Production code, tests, scripts, and configuration must have one clear owner
and bounded responsibility. Aim for roughly 150 effective lines per new source
file; 100-250 is preferred, 251-500 requires a single cohesive responsibility,
and a new file above 700 effective lines is rejected.

Each change must review input bounds, authorization, secrets, blocking paths,
resource and task cleanup, concurrency, retries, cancellation, and algorithmic
complexity. State transitions and external side effects require focused tests.

Completion requires the applicable formatter, focused tests, workspace compile
or type check, contract checks, security checks, and `git diff --check`.
Deployment work also requires rendered manifest validation, runtime probes, and
rollback evidence. Source-only success is not product readiness.

## Current product and architecture baseline

Follow [the development plan](../DEVELOPMENT_PLAN.md) and
[ADR-009](ADR/ADR-009-managed-postgres-small-scale.md). Managed PostgreSQL and a
small single-instance control plane are the target; the current dependency
stack remains until reversible replacements pass their gates. Do not expand
scope to paid provisioning, real credentials/data migration, or deployment.

- Keep authentication, resource authorization and optional quota separate.
  Quota is not a selected billing model; future counters require explicit
  concurrency and idempotency semantics.
- Only the backend queries PostgreSQL. No client database credentials, arbitrary
  SQL passthrough, unbounded result sets or whole-package loading for search.
- Keep upload processing asynchronous, isolated and bounded. Preserve signature,
  malware, review, revocation and idempotency gates while simplifying services.
- Test the selected provider and rollback path against the same API contract.
  PostgreSQL search needs real SQL tests, Unicode/literal-input fixtures,
  deterministic pagination, eligibility/revocation and timeout/failure cases.
- Keep existing checks. Report local, CI, ignored, failed and not-run checks
  separately and bind evidence to the actual commit being reviewed/merged.
- Distinguish target, implemented, tested and deployed. Report RSS only from
  measurements with workload, commit and environment; never infer it from
  requests/limits, streaming buffers or moving the database to a managed service.
