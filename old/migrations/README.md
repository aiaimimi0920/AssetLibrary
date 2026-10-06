# Database migrations

Migrations are forward-only production changes. Apply them in numeric order and
record each completed step in `migration_checkpoints`. Never rewrite a migration
that has reached a shared environment.

## Expand and contract

1. Expand with nullable columns, new tables, or concurrently buildable indexes.
2. Deploy code that can read both old and new representations.
3. Backfill in bounded, restartable batches and verify counts and invariants.
4. Switch authoritative writes, then remove obsolete fields in a later migration.

Local migrations are intentionally small, but production index operations must
use an online procedure appropriate to the managed PostgreSQL provider.

## Rollback policy

- `0001`: restore the pre-migration database snapshot; this creates the base model.
- `0002`: roll back application traffic first, then drop only the added upload and
  scan fields after proving no new rows need them.
- `0003`: stop scanner consumers before removing trust/evidence tables or fields;
  preserve evidence in an audit export.
- `0004`: application rollback is safe because the replacement index changes only
  lookup performance. Do not restore the unique index while duplicate references
  exist; doing so would break valid content-addressed deduplication.
- `0005`: stop cleanup jobs before dropping cleanup lease/evidence columns. Preserve
  rows with `cleanup_error` for an operator review before any destructive rollback.
- `0006`: deploy the rejecting API and scanner before tightening database checks.
  The migration tombstones active oversized uploads, normalizes their inactive
  multipart sizing, and adds the artifact constraint `NOT VALID` so already-terminal
  historical artifacts do not block rollout. New and changed rows are still checked.
  Inventory any legacy oversized terminal rows before later validating the constraint.
  Rollback may restore the previous 10 GiB checks, but larger objects still require a
  malware engine that can inspect them rather than silently skipping content.
- `0007`: deploy the review API after the additive migration. Roll back application
  traffic before removing revision-bound evidence, local store roles, moderation
  approvals, or blocklist facts; preserve all review and policy records in an audit
  export. Package suspension is backward compatible with public catalog filtering.
- `0008`: deploy download authorization and library readers after this additive
  expansion. Older rows remain readable with nullable ticket metadata. Before rollback,
  stop ticket issuance and projection consumers; retain session hashes and audit facts.
- `0009`: deploy the search and edge-policy indexer after its state tables exist.
  Stop the indexer before rollback and export its reconciliation ledger; OpenSearch,
  Valkey, and edge KV remain disposable projections rebuilt from PostgreSQL facts.

Every production rollback requires a backup checkpoint, row-count comparison,
and a recorded operator decision. Destructive rollback is never automatic.
