# Domain model and authorization boundary

## Entities and states

- Publisher: `pending -> active -> suspended -> closed`.
- Package: `draft -> submitted -> published -> deprecated -> archived`.
- Release: `draft -> uploading -> submitted -> in_review -> approved -> published`,
  with terminal or exceptional transitions to `rejected` and `yanked`.
- Artifact: `pending_upload -> uploaded -> scanning -> verified`; failed work is
  `quarantined`, and retained cleanup ends at `deleted`.
- Submission: `open -> validated -> in_review -> approved|rejected`; it can also
  move through `changes_requested` or finish as `withdrawn`.
- Review: `pending -> in_progress -> approved|rejected|needs_changes`.
- Moderation: `open -> actioned -> appealed -> resolved`.
- Library entry: `listed -> hidden -> removed`.
- Download session: `requested -> authorized -> issued -> started -> completed`,
  or `failed|expired|revoked`.
- Install receipt: `pending -> accepted -> verified -> revoked|superseded`.
- Rating: `pending -> published -> flagged -> removed`.

Published releases and verified artifacts are immutable. Corrections create a
new release. Yank, suspension, and revocation append policy facts rather than
rewriting historical bytes or audit events.

`published_release_artifacts` is the authoritative approval boundary between a
release and the artifact set that may be resolved, indexed, downloaded, or
recorded as installed. A verified sibling artifact is still only a candidate;
it does not become installable merely because another artifact on the same
release passed review. Each normal binding references the exact Submission,
Release, and Artifact tuple. The migration can retain a single unambiguous
pre-binding publication as `legacy_backfill`, but refuses an ambiguous release.

## Store roles

- Visitor reads published public metadata.
- Consumer manages only its own library, download sessions, install receipts,
  and eligible ratings.
- PublisherMember manages packages within one Publisher according to assigned
  owner, maintainer, or release-manager roles.
- Reviewer evaluates assigned submissions but cannot alter publisher ownership.
- Moderator suspends or yanks content with an auditable reason.
- Operator manages store policy and infrastructure; sensitive actions require
  separate approval.

Authorization is evaluated against PostgreSQL facts and the external
`PrincipalRef`. Search documents, cache entries, client claims, and analytics
events never grant access. Cross-publisher or cross-principal access is denied
by default.
