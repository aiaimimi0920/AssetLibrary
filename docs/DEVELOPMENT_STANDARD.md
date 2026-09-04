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
