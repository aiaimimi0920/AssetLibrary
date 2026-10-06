# Review and moderation workflow

## Trust boundary

The account service authenticates a person and supplies only an opaque issuer
and subject. AssetLibrary authorizes that principal from PostgreSQL facts:

- `publisher_members` grants package-scoped publisher access;
- `store_roles` grants `reviewer`, `moderator`, or `operator` access;
- search documents, JWT claims other than the principal identity, cache entries,
  and request bodies never grant a store role.

Store roles are operational policy, not account records. They are provisioned
by deployment administration and are not exposed through a public account or
self-service role API.

## Submission and review

Submission is allowed only when the selected artifact:

1. belongs to the release;
2. is `verified` and has an immutable published object key and canonical digest;
3. records non-empty scanner and rule versions;
4. uses a currently active publisher signing key;
5. is not covered by an active publisher, package, release, artifact, or signing
   key blocklist fact.

Passing these checks is the automatic `p4-v1` policy decision. The submission
then enters the manual queue. The policy snapshot stores the artifact digest,
scanner version, rule version, and submission revision, but public and queue
responses do not return raw antivirus output or internal object-store data.

`GET /v1/internal/review-queue` returns at most 100 bounded queue projections to
an active reviewer or operator. Its opaque cursor keeps one `submitted_at`
snapshot and advances by `(submitted_at, submission_id)`, so new submissions do
not reorder an in-progress traversal. `GET /v1/internal/submissions/{id}` adds
only declared compatibility, permissions, canonical digest, size, media type,
policy/scanner/rule versions, and current-revision human decisions. Both reads
send `Cache-Control: private, no-store`. They never return submitter/reviewer
principals, object keys, raw scan evidence, signature material, or credentials.

The detail response's `can_review` field is advisory presentation state. The
decision transaction remains authoritative and rechecks the active Store Role,
submission state/revision, submitter identity, owning Publisher membership, and
prior current-revision decision under database locks.

Art requires one approval. Capability and App Update require two approvals from
distinct active reviewers. An active member of the owning publisher cannot
review that publisher's submission even if the principal also has a store role.
App Update submission and publication remain disabled unless the deployment
explicitly enables `ASSETLIBRARY_APP_UPDATES_ENABLED`; P9 security acceptance is
still required before enabling it in production.

`needs_changes`, rejection, and withdrawal preserve the existing submission and
review records. Resubmission increments `revision`; only approvals bound to the
current revision count. Publication rechecks the verified artifact, current
review roles, distinct non-publisher approvals, publisher/package status,
signing-key status, and blocklist immediately before the transaction commits.

Publication atomically records the reviewed Submission/Release/Artifact tuple in
`published_release_artifacts`, updates the release and package, and writes both
`release.published.v1` and `catalog.invalidated.v1` to the transactional Outbox.
The artifact digest, signature, and published object key are not rewritten.
Catalog, release detail, download, Library installation, and search projection
queries all join this approval fact; `release_id + verified` alone is never a
publication decision.

## Reports and moderation

Any authenticated principal can report an existing package or one of its
releases. A moderator or operator may propose one bounded action:

- suspend a publisher or package;
- yank a release;
- revoke an artifact or signing key;
- block any supported target.

`GET /v1/internal/moderation-cases` returns a fixed, cursor-paginated snapshot
of unresolved cases to an active moderator or operator. `GET
/v1/internal/moderation-cases/{id}` returns only bounded report text, HTTPS
evidence links, Package/Publisher display facts, an optional Release version,
the single action record, and appeal/resolution facts. Both reads are `private,
no-store`; neither returns reporter, proposer, approver, or resolver principals,
object keys, credentials, or raw scanner output.

`GET /v1/me/moderation-cases` and `GET
/v1/me/moderation-cases/{id}` expose only cases whose action has already been
applied and whose Package belongs to one of the principal's active Publisher
memberships. The stable page and detail include the affected resource, applied
action, bounded enforcement reason, appeal, and resolution. They intentionally
exclude open investigations, original report text and evidence, all actor
principals, object keys, credentials, and raw scanner output. Membership rows are
held with a shared lock for the read transaction so revocation cannot race a
private response.

A proposal has no enforcement effect. A different active moderator or operator
must approve it. Self-approval is rejected in PostgreSQL-backed authorization,
then the same transaction applies the status change, appends an active
`blocklist_entries` fact, records audit evidence, and emits policy and catalog
invalidation events. The public catalog requires an active publisher, a
published release, an explicit publication binding, a verified artifact, an
active signing key, and no matching blocklist fact, so it cannot expose an
internal or partially applied success.

The database permits at most one action proposal for each case and validates
that every applied action records a principal distinct from its proposer. UI
eligibility fields remain advisory: proposal, approval, and resolution
transactions reacquire role and state locks and revalidate target ownership.

An affected publisher member may appeal an actioned case. Resolution either
upholds it or lifts the case's active blocklist facts. Lifting a block does not
silently restore suspended, yanked, or revoked status: reinstatement is a
separate future policy action, while the original action and audit history stay
append-only. This avoids turning an appeal response into an implicit byte or
release mutation.
The Publisher Server Action also enforces exact same-origin submission before
exchanging its configured cookie with the external Account Service. The backend
then reacquires the membership and case locks; only the original idempotency key
can replay an accepted appeal, so a different key cannot append a second reason
or misleading audit event.

## Retry and failure behavior

Every mutation requires an `Idempotency-Key`. A key is scoped by principal and
operation, locked transactionally, and retained for 24 hours. Reusing it with a
different request digest returns a conflict. Domain state transitions are also
monotonic, so retrying after a lost response cannot duplicate approvals,
publication events, blocklist entries, or moderation effects.

Database or identity dependency failures fail closed. API responses contain
only bounded review summaries and identifiers; credentials, access tokens,
object-store secrets, arbitrary scanner evidence, and internal error details
remain server-side.
