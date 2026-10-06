# Operator Console boundary

This document records the authenticated P6 Operator slices. They cover the
manual review queue, sanitized Submission detail, current-revision review
history and decisions, plus unresolved moderation cases, two-person
downlisting, and appeal resolution. They do not claim that P6 as a whole or
production-environment acceptance is complete.

## Identity and authorization

The Next server exchanges only the configured session cookie with the separate
Account Service and sends the returned bearer to the Rust API. AssetLibrary does
not create or persist an account, password, MFA factor, login session, or account
profile. The API reduces the credential to an opaque `(issuer, subject)` and
authorizes it from `store_roles` in PostgreSQL.

| Route | Authorization | Result |
| --- | --- | --- |
| `GET /v1/internal/review-queue` | active `reviewer` or `operator` | stable bounded queue snapshot |
| `GET /v1/internal/submissions/{submission_id}` | active `reviewer` or `operator` | sanitized declarations, evidence, and current-revision decisions |
| `POST /v1/internal/submissions/{submission_id}/reviews` | active eligible `reviewer` or `operator` | idempotent revision-bound decision |
| `GET /v1/internal/moderation-cases` | active `moderator` or `operator` | stable snapshot of unresolved cases |
| `GET /v1/internal/moderation-cases/{case_id}` | active `moderator` or `operator` | sanitized report, action, and appeal facts |
| `POST /v1/internal/moderation-cases/{case_id}/actions` | active `moderator` or `operator` | create the case's only bounded action proposal |
| `POST /v1/internal/moderation-actions/{action_id}/approve` | different active `moderator` or `operator` | apply action and Blocklist transactionally |
| `POST /v1/internal/moderation-cases/{case_id}/resolve` | active `moderator` or `operator` | uphold appeal or lift this case's Blocklist facts |

Role reads take a shared row lock for the transaction. Revocation cannot race a
successful private read or decision into using an authorization fact after it
has been withdrawn. A Publisher member may inspect the queue only if it also has
a Store Role, but cannot review its own Publisher's Submission.

## Stable queue and bounded detail

The queue orders by `(submitted_at, submission_id)`, limits each page to 100,
and places the first request's snapshot timestamp in an opaque base64url cursor.
New submissions after that snapshot do not appear halfway through pagination.
The cursor is positioning state, not an authority token: every page performs
fresh authentication and Store Role authorization. Invalid, reversed, future,
oversized, or malformed cursors are rejected.

Queue rows include only the Submission state, Package/Publisher display facts,
release version, approval progress, and policy tool versions. Detail adds:

- declared Loom/Hook compatibility and permissions;
- canonical `sha256:<lowercase hex>` digest, size, and media type;
- policy, scanner, and rule versions;
- bounded decisions and findings for the current Submission revision;
- advisory `can_review` state.

Neither response contains Account Service tokens, PrincipalRef values, object
keys, presigned URLs, signature keys, raw manifests, or arbitrary scanner
evidence. Both responses and both Next routes use `private, no-store`; the pages
also use `noindex` and the repository security headers.

`can_review` is deliberately not an authorization grant. The decision mutation
again verifies the active role, current state and revision, submitter isolation,
owning Publisher membership, and absence of a prior decision from that principal.
Every decision requires `Idempotency-Key`; lost-response replay cannot create a
second approval. Mutating Web actions also reject missing or cross-origin
`Origin` headers against `ASSETLIBRARY_PUBLIC_URL` before exchanging the external
Account Service session. Only HTTPS origins and loopback HTTP are accepted.

## Moderation and appeal workspace

The moderation queue orders unresolved cases by immutable `(created_at,
case_id)` and carries a fixed snapshot timestamp in the opaque cursor. Queue
rows contain display-safe Package/Publisher facts, an optional Release version,
a 240-character report preview, state, and action state. Case detail adds the
bounded report reason, HTTPS evidence links, at most one action record, the
Publisher appeal, and advisory `can_propose`, `can_approve`, and `can_resolve`
facts. Reporter, proposer, approver, and resolver principals are never returned.

An open case can have only one action proposal. The UI offers scoped suspend,
yank, and block targets from the case's known Publisher, Package, and optional
Release; the API still validates action/target compatibility and ownership.
Approval requires an explicit confirmation and a different active principal.
The approval transaction mutates the bounded target where required, inserts the
active Blocklist fact, marks the action and case, writes audit data, and emits
policy/catalog invalidations. The proposer sees `can_approve: false`; this is a
presentation hint, not an authorization grant.

An appealed case exposes the Publisher's bounded reason to an eligible resolver.
Resolution can uphold the action or lift only the Blocklist facts originating
from this case. It never silently restores a suspended Publisher/Package, a
yanked Release, or a revoked signing key.

## Storage migration

Migration `0013_operator_review_queue`:

- normalizes legacy `{}` compatibility to `{"products":[]}` and changes the
  default to the canonical contract shape;
- validates that an `in_review` Submission has its artifact, submitter, policy,
  scanner, rule, and submitted timestamp facts;
- adds the partial `(submitted_at, id)` queue index.

The migration is replay-safe. Rolling the API back can leave these changes in
place. A deliberate schema rollback may drop the index and check after older
writers are active, but restoring the non-canonical compatibility default is not
recommended because public and private release contracts share this shape.

Migration `0014_operator_moderation_queue` adds the unresolved-case queue index,
a unique action-per-case index, and validated constraints requiring distinct
proposal/approval principals and state-consistent appeal/resolution metadata.
It fails rather than guessing if legacy data already violates the one-action or
four-eyes invariants. Both migrations are replay-safe and may remain during an
API rollback; older writers must not be re-enabled if they can violate the new
constraints.

## Verification

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Migrations.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-WorkflowRuntime.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-OperatorWebRuntime.ps1
pnpm --dir apps/web test:browser
pnpm --dir packages/api-client generate:check
pnpm --dir packages/api-client typecheck
```

The first gate proves clean install and replay through migration 0014. The
workflow gate proves both stable cursor implementations, private cache headers,
projection shape, review/moderation role denial, one-action enforcement,
independent approval eligibility, current-revision history, appeal resolution,
and absence of raw internal fields against real PostgreSQL and Axum. The Web
gate builds and starts the real Next production server plus a separate Account
Service fixture and proves authorized Review/Moderation SSR, bounded action
forms, security headers, identity/evidence non-disclosure, role revocation, and
explicit API/Account Service outage states.

## Deliberately open

- Publisher-side case discovery and appeal submission are implemented separately
  in the private Publisher Console; they never expose Operator-only actions;
- full Operator browser journeys and focus restoration for future dialogs; the
  shared Playwright gate currently covers public and Publisher signing-key
  desktop/mobile accessibility and visual baselines;
- generated domain clients now provide compile-time request/response shapes;
  adoption by each caller remains incremental and does not replace strict
  hand-written parsers at untrusted HTTP boundaries;
- staging OIDC, query-plan/load evidence, and production Account Service.
