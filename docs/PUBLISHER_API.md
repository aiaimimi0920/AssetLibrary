# Publisher API boundary

This document records the authenticated P6 Publisher control-plane and browser
console slice. It does not claim that the remaining Publisher workflow UI or P6
as a whole is complete. The separate Operator Review slice is documented in
`OPERATOR_CONSOLE.md`.

## Identity and routes

AssetLibrary accepts a bearer credential from the external Account Service and
reduces it to the existing opaque `(issuer, subject)` `PrincipalRef`. It does
not store accounts, sessions, passwords, MFA data, or recovery credentials.
The development-only `Bearer dev-<subject>` adapter is not a production login
implementation.

| Route | Authorization | Result |
| --- | --- | --- |
| `GET /v1/me/publishers` | authenticated principal | active memberships only |
| `GET /v1/me/publishers/{publisher_id}/packages` | any active member | bounded owned package summaries, including drafts |
| `POST /v1/me/publishers/{publisher_id}/packages` | owner or maintainer | one package in `draft` state |
| `GET /v1/me/publishers/{publisher_id}/signing-keys` | any active member | bounded Ed25519 public-key and lifecycle projection |
| `POST /v1/me/publishers/{publisher_id}/signing-keys` | owner or maintainer | register immutable canonical public-key material |
| `POST /v1/me/publishers/{publisher_id}/signing-keys/{key_id}/revoke` | owner or maintainer | irreversibly revoke one signing key |
| `GET /v1/me/packages/{package_id}` | any active member of the owning publisher | complete owned package metadata, including description |
| `PATCH /v1/me/packages/{package_id}` | owner or maintainer | idempotent mutable-metadata edit while the package is `draft` |
| `GET /v1/me/packages/{package_id}/releases` | any active member of the owning publisher | bounded owned release history |
| `POST /v1/me/packages/{package_id}/releases` | owner, maintainer, or release manager | one immutable semantic-version release in `draft` state |
| `GET /v1/me/releases/{release_id}` | any active member of the owning publisher | complete owned release metadata |
| `PATCH /v1/me/releases/{release_id}` | owner, maintainer, or release manager | idempotent compatibility/permission edit while the release is `draft` |
| `GET /v1/me/releases/{release_id}/workspace` | any active member of the owning publisher | bounded Artifact, current Submission, and de-identified review feedback |
| `POST /v1/me/releases/{release_id}/upload-sessions` | owner, maintainer, or release manager | idempotent multipart reservation in the private quarantine bucket |
| `GET /v1/me/upload-sessions/{session_id}` | principal that owns the live session | safe session metadata and object-store-authoritative uploaded parts |
| `POST /v1/me/upload-sessions/{session_id}/parts/{part_number}` | principal that owns the live session | one 15-minute checksum-bound direct PUT request |
| `POST /v1/me/upload-sessions/{session_id}/complete` | principal that owns the live session | validate the ordered part receipt list and enqueue verification |
| `POST /v1/me/releases/{release_id}/submissions` | active member of the owning publisher | idempotently submit or resubmit one verified Artifact |
| `GET /v1/me/moderation-cases` | authenticated principal | applied cases across active publisher memberships |
| `GET /v1/me/moderation-cases/{case_id}` | active member of the affected publisher | bounded enforcement and appeal facts |
| `POST /v1/me/moderation-cases/{case_id}/appeal` | active member of the affected publisher | one formal appeal for an actioned case |

Owned package pages deliberately omit the potentially 100,000-character
description. Creation returns the complete package resource. This keeps a
maximum 100-item control-plane page bounded while retaining the full submitted
draft in the idempotent response and package-detail route.

All successful read responses from these routes include `Cache-Control: private,
no-store`. Cursor input is opaque, URL-safe base64, schema-strict, and limited to
256 characters. Publisher resource pages default to 20 items and moderation
pages default to 50; neither can exceed 100.

Publisher moderation reads deliberately exclude `open` investigations. List and
detail projections expose the affected Package, optional Release, applied action,
bounded enforcement reason, submitted appeal, and final resolution. They do not
return the originating report reason or evidence links, reporter/moderator
principals, object keys, credentials, or raw scanner output.

The release workspace returns at most 100 newest Artifacts and 100 newest
decided reviews, with explicit truncation flags. Artifact projections contain a
safe basename, bounded media metadata, expected and verified SHA-256 values, and
scanner/rule version labels. They never contain an object key, storage upload ID,
signature payload, raw scanner evidence, policy evidence, or Account/Reviewer
principal. Review feedback contains only revision, decision, reason, findings,
and decision time. `uploaded` and `scanning` remain untrusted states in both the
contract and UI; only `verified` is eligible for the submission mutation, whose
transaction rechecks canonical bytes, publication object, signature key,
blocklist, publisher state, and current membership.

The signing-key workspace accepts only a lowercase bounded key ID and canonical
standard-Base64 encoding of exactly 32 Ed25519 public-key bytes. The service
computes the `sha256:` fingerprint and never accepts, generates, returns, or
stores private key material. Public-key reuse within one Publisher is rejected;
key revocation is terminal and has no delete or reactivation endpoint. Existing
public catalog and download queries immediately exclude releases signed by a
revoked key while retaining audit history.

## Mutation invariants

All creation, edit, key-management, and appeal mutations require
`Idempotency-Key`. The existing request-digest and PostgreSQL advisory-lock
implementation scopes a key to the external principal, operation, and target.
Replaying the same request returns the original resource; changing the body
returns `409`. Results expire after 24 hours.
Current publisher status, membership, and role are locked and re-authorized before
an idempotent response can be replayed, so revoking a member immediately denies
replay of earlier Package/Release mutations. The submission transaction likewise
re-authorizes current membership before returning an earlier submission replay.
Upload-session creation now follows the same rule: current publisher/member/role
authorization is checked before a stored reservation can be replayed. Lifecycle
checks run after replay, preserving a legitimate same-request response when the
Release advanced meanwhile; a new upload is accepted only in `draft`, `uploading`,
or correction-capable `rejected` state.

Package slugs remain globally unique. Release versions are unique within a
package and must parse as SemVer. Concurrent requests with different
idempotency keys still converge through PostgreSQL uniqueness constraints: one
can succeed and the other receives `409` without duplicate audit or event rows.
New App Update packages and releases remain behind
`ASSETLIBRARY_APP_UPDATES_ENABLED` and return `501` while the gate is disabled.

Package slug and kind remain immutable. A package edit accepts only visibility,
name, summary, description, and tags, only while the locked package is `draft`,
and requires the exact previously read `expected_updated_at` RFC 3339 timestamp.
Only an active Owner or Maintainer may edit; a Release Manager remains read-only
for package metadata. A stale editor receives `409`, and an idempotent replay
returns the first result without another audit or event row.

The Package editor retains its five editable fields in component memory after
a rejected save and focuses the returned error. Validation failures, expired
account sessions and revision conflicts do not clear the user's unsaved text.
The failed editor keeps its original revision and idempotency key: retaining
text does not authorize overwriting a concurrent edit or replaying with a new
identity. No private draft is written to browser storage or a new server table.
A successful save redirects to fresh authoritative data with a new editor key;
leaving the editor discards unsaved component state. This improvement is scoped
to Package editing, not a claim that every Publisher form has recovery coverage.

The new Package and new Release forms also retain their current input after
validation, expired-session or API-conflict errors and focus the returned error.
The original target and idempotency key remain unchanged on rejection. The
draft lives only in the mounted form, with no browser-storage or server-draft
persistence. Success still redirects to the created resource's workspace;
leaving, reloading or refreshing into a new server-rendered form discards
unsubmitted input and provides a fresh key. A newly requested account gate
does not restore that input after sign-in. This does not provide live-session
revocation, cancel a creation already sent to the server, or change backend
authorization, uniqueness or idempotency rules.

Release version and creator identity remain immutable. A release edit accepts only
compatibility and permission declarations, only while the locked release is
`draft`, and requires the exact previously read `expected_updated_at` RFC 3339
timestamp. A stale editor receives `409` rather than overwriting another member's
change. Replaying the same key and body returns the first updated resource without
adding another audit or event row.

Publisher state and membership role are checked while the relevant rows are
locked in the mutation transaction. Suspended or closed publishers cannot
create drafts. Revoked members and cross-publisher principals fail closed.
Private list/detail reads take a shared lock on the active membership for the
duration of their resource query, closing the check/read revocation race while
allowing concurrent authorized readers.
Signing-key registration serializes on the Publisher row before checking public-
key reuse. Revocation locks the Publisher/member and key rows. Publication holds
a shared lock on the active signing-key row, so it cannot race a concurrent
revocation into publishing content after the key becomes revoked.
The appeal transaction uses the same shared membership lock, accepts only the
`actioned` state, and moves it monotonically to `appealed`. A replay with the same
key returns the stored result; another key cannot add or audit a second reason.
Release creator issuer and subject are written from the authenticated
`PrincipalRef`; migration `0012_publisher_console_indexes` protects both fields
with a database trigger so later workflow updates cannot reassign authorship.

## Audit and events

Successful first execution writes, in the same transaction:

- `package.created`, `package.updated`, `release.created`, `release.updated`, `signing_key.registered`,
  or `signing_key.revoked` in `audit_events`, including the
  request correlation ID and external principal;
- `assetlibrary.package.v1`, `assetlibrary.release.v1`, or
  `assetlibrary.publisher.signing_key.v1` in the transactional
  outbox, using the principal event actor and a `created` or `updated` action;
- the idempotency response record.

Idempotent replay returns before these writes, so audit and outbox facts remain
exactly once for the logical creation. AsyncAPI defines both new subjects and
their bounded payloads.

## Storage and rollout

Migration `0012_publisher_console_indexes` adds only three concurrent-read
supporting indexes plus the release-creator protection function and trigger; it
does not add an account table or rewrite package data. Rollback of the API can
leave these objects in place safely. A deliberate schema rollback may drop the
trigger, function, and indexes after older API processes are active, but doing
so removes database-level creator immutability and should not be the default.
Migration `0015_publisher_moderation_cases` adds a partial
`(package_id, created_at DESC, id)` index for applied-case discovery and one
replay-safe checkpoint. It adds no account, report, or credential storage and is
safe to leave in place during API rollback.

The repository runtime gate is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-PublisherRuntime.ps1
```

It exercises real Axum routes and PostgreSQL state, including membership
scoping, role denial, suspension, App Update gating, pagination, idempotent
replay/conflict, concurrent slug/version races, immutable creator projection,
optimistic package/release editing, immutable package identity and lifecycle
locking, revoked-member replay denial, and exactly-once
audit/outbox facts. It also proves canonical Ed25519 public-key registration,
read-only Release Manager access, cross-Publisher denial, terminal idempotent
revocation, fingerprint derivation, and the absence of private material.
`scripts/Test-Migrations.ps1` separately
proves clean install, replay through 0015, indexes, and the creator trigger.
`scripts/Test-WorkflowRuntime.ps1` additionally proves the sanitized Release
workspace before and after decided feedback, verified-only submission and
resubmission, revoked-member replay denial, applied-only stable case pagination,
bounded appeal state, and the absence of report/principal/storage fields in
Publisher projections.
`scripts/Test-ApiRuntime.ps1` proves the real multipart reservation, per-part
checksum presign, browser CORS preflight and ETag exposure, direct MinIO PUT,
ordered completion, final object size, verification event, rejected-Release
correction upload, revoked-member session replay denial, and denial of further
part presigns or completion after membership revocation.

## Browser session boundary

`/publisher`, `/publisher/signing-keys`, its Package/Release draft pages, Package
release-history workspace, Release metadata and supply-chain workspace,
`/publisher/moderation`, and `/publisher/moderation/{case_id}` are dynamic Server
Components with `private, no-store` and `noindex` response headers. They read only the
configured `ASSETLIBRARY_ACCOUNT_SESSION_COOKIE` and send it server-to-server to
`ASSETLIBRARY_ACCOUNT_SESSION_URL`. Remote endpoints must use HTTPS; loopback
HTTP is allowed only for local development. Redirects are rejected, responses
are uncached, and the exchange has a five-second timeout.

The Account Service response is an exact boundary:

```json
{
  "principal": { "issuer": "https://accounts.example", "subject": "opaque-id" },
  "access_token": "opaque-account-service-bearer-value",
  "expires_at": "2099-01-01T00:00:00Z"
}
```

Unknown keys, expired sessions, unsafe control characters, and malformed fields
fail closed. The access token is passed only from the Next server to the Rust
API. Neither it nor the principal issuer/subject is rendered into HTML, React
Flight/client component props, query strings, or public environment variables.
AssetLibrary still owns no account or login persistence. Mutating Server Actions reject a
missing or cross-origin `Origin` header against `ASSETLIBRARY_PUBLIC_URL` before
the session exchange; remote public origins must use HTTPS.

The upload panel hashes the selected ZIP incrementally in bounded 8 MiB chunks,
then creates a one-hour multipart session. Up to three 8 MiB parts are PUT in
parallel directly from the browser to the presigned object-store URL; failed parts
receive a fresh presign and retry at most three times with bounded exponential
backoff. A terminal part failure cancels and settles the remaining browser workers.
Only metadata, checksums,
ETags, and the completion list cross the Next/Rust control plane. File bytes never
cross either application server. The internal object key is removed from the
Server Action result; it is visible only as an unavoidable component of a short-
lived presigned PUT URL. Cancelled/incomplete uploads stay in the private
quarantine namespace and are handled by the existing bounded cleanup worker.

Before direct PUT begins, the browser stores one schema-strict descriptor in
`sessionStorage`, scoped to the Release and current tab. It contains only session,
artifact, file-plan, expiry, and expected-digest metadata; it never stores a bearer,
principal, object key, presigned URL/header, or ETag. After reload the user must
reselect the same safe filename, media type, size, and bytes. The browser recomputes
the entire SHA-256 digest before asking the server to recover the session. Recovery
re-authorizes the current Account principal and active Publisher role, rejects an
expired session, and obtains uploaded part ETags, sizes, and SHA-256 checksums from
the object store rather than trusting browser storage. Only parts whose recomputed
checksum and size match are retained; all others receive fresh presigns and are
uploaded again. Completion or an already-completed session clears the descriptor.
Cancellation preserves it for recovery, while an explicit abandon action removes
it and leaves the private multipart upload to bounded expiry cleanup.

Next accepts presigned URLs only from the comma-separated
`ASSETLIBRARY_UPLOAD_ORIGINS` allowlist (maximum eight HTTPS origins; local
development defaults to `http://127.0.0.1:9100`). The object-store CORS policy
must allow PUT and requested checksum headers and expose `ETag`. The Helm chart
passes this allowlist and all Account/API URLs only as server-side variables; no
bearer or upload configuration is emitted through `NEXT_PUBLIC_*`.

Local Community MinIO receives the independent `ASSETLIBRARY_BROWSER_ORIGINS`
allowlist because its CORS setting is cluster-wide. The local defaults are exact
loopback Next origins; production web origins must be exact HTTPS origins and a
wildcard is forbidden.

The browser/runtime gate is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-PublisherWebRuntime.ps1
```

It starts a separate Account Service fixture process, the real Axum API, and a
Next production server against PostgreSQL. It proves authenticated private SSR,
Package creation/editing and Release draft forms, Package release history, draft
Release editing, sanitized Artifact state and explicit untrusted-upload messaging,
scoped moderation list/detail and appeal form, the public-key-only signing
workspace, security/cache headers, absence of identity/report data in HTML and
React Flight payloads, revoked membership denial, and explicit
unauthenticated/Account-Service-outage gates.
Unit tests additionally execute the browser controller through local incremental
hashing, the metadata-only Server Actions, a mocked direct PUT, and ordered
completion. Playwright executes the Package-edit Server Action and a real
reload/reselect/resume upload journey at desktop and mobile widths with focus,
Axe, overflow, privacy, and platform-specific execution. The remaining complex
Publisher and Operator journeys stay open.

## Deliberately open

- Package editing, Ed25519 public-key registration/revocation, direct multipart
  upload with in-session progress/cancellation/bounded retry, reload-resumable
  recovery, sanitized Artifact state, current Submission,
  decided review feedback, and verified-Artifact submission are implemented.
- Operator Review and moderation proposal/approval/resolution remain implemented
  separately in the Operator Console; Publisher pages cannot access those actions.
- Cloud database query plans, production OIDC, and browser acceptance require a
  real staging environment.
