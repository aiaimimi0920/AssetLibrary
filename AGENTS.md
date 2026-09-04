# AssetLibrary Development Instructions

## Boundary

AssetLibrary is an independent Git repository under the Neuro workspace. Its
source, tests, contracts, deployment files, and documentation live here. Do
not modify Hook, Loom, or the Neuro root repository while working on
AssetLibrary unless a later integration task explicitly requires it.

The account system is an external service. AssetLibrary owns only publisher,
package, release, artifact, review, moderation, library, download-session, and
install-receipt data. It must refer to users through an opaque `PrincipalRef`.
It must not grow registration, password, MFA, session, or account tables.

## Architecture rules

- Rust/Axum is the stateless control-plane API and worker foundation.
- Next.js App Router is the public web surface. Public catalog pages are
  server-rendered or incrementally regenerated; private pages are uncached.
- PostgreSQL is the source of truth for catalog and workflow facts.
- Object bytes use an S3-compatible provider through a storage port. Production
  defaults to Cloudflare R2 behind CDN/WAF; API responses never proxy public
  artifact bytes.
- NATS JetStream receives transactional-outbox events. Workers are isolated,
  bounded, observable, and fail closed.
- OpenSearch owns catalog search; Valkey is cache/rate-limit/idempotency
  support; analytics are asynchronous.
- Release and artifact identities are immutable and digest-addressed.
- Only a verified artifact may enter review or publication. Quarantine objects
  remain private. Every state transition is auditable and idempotent.

## Engineering constraints

- Read `DEVELOPMENT_PLAN.md` and `docs/DEVELOPMENT_STANDARD.md` before making
  substantial changes.
- Prefer files below 250 effective lines. New files over 700 effective lines
  are not acceptable.
- Add focused tests for new behavior and security/concurrency invariants.
- Run formatter, focused tests, direct compile/type checks, `git diff --check`,
  and dependency/security checks before claiming completion.
- Keep secrets out of source, logs, fixtures, and command output.
- Use UTF-8 without BOM. Prefer ASCII for source and configuration.

## Local commands

```powershell
cargo fmt --all -- --check
cargo test --workspace
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/web lint
pnpm --dir apps/web build
```

The exact commands may be narrowed for a focused change, but the completion
report must state what ran and what remains.
