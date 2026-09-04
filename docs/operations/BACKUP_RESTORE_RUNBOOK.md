# Backup, restore, and disaster-recovery runbook

This runbook is the required production contract. Provider snapshots, retention,
and restore drills remain unproven until their timestamped evidence is attached
to the release. Replication alone is not a backup.

## Recovery objectives and authority

- Canonical metadata and audit/outbox: RPO at most 5 minutes.
- Analytics data: RPO at most 15 minutes.
- Single availability-zone loss: RTO at most 15 minutes.
- Regional loss: RTO at most 60 minutes.

Only the incident commander may authorize a production restore. Restore first to
an isolated recovery environment. Never overwrite the source while determining
the recovery point. Break-glass credentials must be short lived, audited, and
separate from application credentials.

## Required protection matrix

| System | Protection | Restore authority | Verification |
| --- | --- | --- | --- |
| PostgreSQL | multi-AZ HA, encrypted continuous WAL/PITR, daily snapshot, cross-region copy | database operator | migration version, row counts, FK checks, audit/outbox sequence |
| R2 quarantine | short lifecycle for abandoned/untrusted data; no public route | storage operator | sampled digest and database ownership |
| R2 published | content-addressed immutable keys plus bucket lock/retention; protected config export | storage + security | all approved artifact digests and manifests |
| JetStream | replicated stream plus encrypted stream backup including consumers | messaging operator | stream config, first/last sequence, consumer offsets |
| OpenSearch | scheduled encrypted incremental snapshot | search operator | restored index count/docs, alias, sampled projection |
| ClickHouse | encrypted full + incremental backup to independent storage | analytics operator | table/partition counts, event IDs, dedupe/materialized views |
| Configuration | Git/IaC, encrypted secret-manager backup, key inventory | platform + security | immutable revision and dry-run render |

## PostgreSQL PITR

Production database provisioning must enable encryption at rest, multi-AZ,
continuous transaction-log archival, deletion protection, and cross-region
snapshot copies. The provider schedule must make the observed recovery-point gap
no greater than five minutes.

Restore procedure:

1. Freeze writes at the routing layer and record the last acknowledged request,
   audit event, outbox ID, and UTC incident time.
2. Choose a recovery point before corruption but after the last known-good
   checkpoint. Restore into a new isolated instance with no public ingress.
3. Apply the exact release migrations in order; never point old application code
   at a schema it cannot understand.
4. Verify table counts, constraints, duplicate idempotency keys, artifact/release
   relationships, audit chain coverage, and outbox ordering.
5. Reconcile PostgreSQL canonical state into OpenSearch, Edge policy, and
   ClickHouse rather than treating those projections as canonical.
6. Cut over through an approved immutable configuration revision. Retain the old
   instance read-only until the incident owner closes the rollback window.

## R2 retention and recovery

AssetLibrary does not depend on mutable-key object versioning. Published objects
use digest-addressed keys and application code never overwrites them. Apply an R2
bucket-lock rule to the published prefix for the legal/product retention window;
bucket locks prevent delete and overwrite and take precedence over shorter
lifecycle deletion. Keep lifecycle rules for incomplete multipart uploads and
quarantine separate from published retention.

The declared baseline aborts incomplete multipart uploads after one day. It
retains quarantine objects for seven days in staging and 30 days in production,
and locks `sha256/` published objects for seven days in staging and one year in
production without an automatic published-object delete rule. Before the first
apply to an existing bucket, export and approve the current lock/lifecycle rules;
do not let an unmanaged rule be silently replaced. Treat lock increases as
one-way for existing objects and test every change in staging first.

Export and review bucket lock, lifecycle, CORS, Worker binding, and access-token
scope with each release. Recovery verifies the database `sha256`, canonical
digest, Manifest, signature, SBOM/provenance digests, object size, and R2 object
metadata before the public policy projection is restored. A missing published
object fails closed; never substitute an object from quarantine.

References: [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
and [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## JetStream

Back up `ASSETLIBRARY_EVENTS` with the pinned `nats` CLI to encrypted independent
storage. The stream backup must include stream state, message metadata, and
durable-consumer configuration/state. Record stream config, message count, byte
count, first/last sequence, consumer delivered/ack floors, CLI version, and
backup SHA-256.

Restore only into a NATS account where the stream name does not exist. Verify the
restored stream and consumer offsets before enabling publishers or consumers.
Start idempotent consumers from their restored offsets, compare PostgreSQL outbox
IDs, and replay missing canonical outbox events when necessary.

Reference: [NATS JetStream API snapshot and restore](https://github.com/nats-io/nats.docs/blob/master/using-nats/jetstream/nats_api_reference.md).

## OpenSearch

Register one restricted, encrypted snapshot repository and schedule incremental
snapshots at least every 15 minutes. Snapshot only AssetLibrary indexes without
global state. Restore into a new cluster/index name, validate health and document
counts, then atomically move the configured alias. If any projection differs from
PostgreSQL, run the bounded full rebuild and prefer PostgreSQL.

Never delete incremental snapshot files directly in object storage; use the
OpenSearch API so shared data is retained. Keep snapshot/restore API credentials
outside application Secrets.

Reference: [OpenSearch snapshot and restore](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/).

## ClickHouse

Back up analytics tables and materialized-view definitions to independent,
encrypted S3-compatible storage. Use weekly full and at least 15-minute
incremental recovery points unless the measured ingest volume justifies a tighter
schedule. Store credentials in ClickHouse named collections so they do not enter
query logs.

Restore to new table/database names, compare event ID uniqueness, partitions,
row counts, min/max occurrence time, and materialized-view results, then switch
readers. Analytics may be rebuilt from retained download/control events; it never
overrides canonical PostgreSQL state.

Reference: [ClickHouse backup and restore](https://clickhouse.com/docs/concepts/features/backup-restore/overview).

## Drill schedule and evidence

- Monthly: random PostgreSQL PITR restore and one JetStream/OpenSearch/ClickHouse
  restore into isolation.
- Quarterly: full single-zone failover, including autoscaling and worker backlog.
- Semiannually: regional recovery with DNS/Edge routing and independent backups.
- After schema, provider, retention, encryption-key, or major-version changes:
  targeted restore rehearsal before promotion.

Each drill records start/finish, chosen recovery point, actual RPO/RTO, owners,
tool/provider versions, checksums, counts, offsets, failed steps, remediation, and
reviewer sign-off. Recovery is not accepted until row counts, artifact digests,
Manifests, audit coverage, and event offsets all reconcile.

## Local logical-restore rehearsal

After local dependencies and migrations are healthy, run:

```powershell
./scripts/Test-LocalBackupRestore.ps1
```

The script creates a custom-format PostgreSQL dump, restores it to a uniquely
named temporary database, compares every public-table row count plus constraints,
migration IDs, extensions, and hashed audit/outbox ordering, then removes the
temporary database and dump. Its redacted manifest is written below ignored
`test-results/p8-recovery/`. This is a repeatable logical-backup regression test;
it is not WAL/PITR, provider failover, production RPO/RTO, or evidence for NATS,
OpenSearch, ClickHouse, or R2 recovery.

Run the independent local JetStream rehearsal with:

```powershell
./scripts/Test-LocalJetStreamBackupRestore.ps1
```

It uses digest-pinned NATS server and CLI images, backs up the complete
`ASSETLIBRARY_EVENTS` stream with consumers, restores into an ephemeral NATS
container with no host ports or shared data volume, and reconciles stream config,
message/byte/sequence state, consumer config, delivered state, and ACK floors.
The message-bearing backup is deleted after the run; only hashes and bounded
state enter the manifest. This remains a single-node local rehearsal, not proof
of independent encrypted storage or production RPO/RTO.

After recreating the local OpenSearch service with the declared snapshot volume,
run:

```powershell
./scripts/Test-LocalOpenSearchBackupRestore.ps1
```

The rehearsal creates a uniquely named strict-mapping fixture index, snapshots it
without global state or aliases, restores it under a second exact name, compares
mapping and sorted document fingerprints, then performs an atomic one-target
alias cutover. It deletes only this run's exact indexes, snapshot, and repository
through OpenSearch APIs. The local filesystem repository and fixture data do not
prove the production encrypted repository, 15-minute schedule, canonical catalog
reconciliation, cross-cluster restore, or RPO/RTO.

Run the local S3-compatible object-copy rehearsal with:

```powershell
./scripts/Test-LocalObjectBackupRestore.ps1
```

It first proves the canonical local quarantine and published buckets are private,
then uses uniquely named source and recovery buckets for two deterministic fixture
objects. The run exports, restores, and compares object key, size, and SHA-256,
then removes only guarded run-scoped buckets and temporary bytes. This exercises
logical object transfer, not Cloudflare R2 lock/lifecycle export, cross-region
recovery, database ownership reconciliation, or production RPO/RTO.

After recreating the local ClickHouse service with its independent backup volume,
run:

```powershell
./scripts/Test-LocalClickHouseBackupRestore.ps1
```

The script creates a run-scoped analytics database with two monthly partitions,
stable event IDs, and a materialized daily aggregate. It performs native
`BACKUP DATABASE`/`RESTORE DATABASE ... AS ...`, compares table engines, rows,
event-ID digest, time range, partitions, and materialized-view output, then removes
the exact temporary databases and archive. This does not prove production full +
incremental scheduling, independent encrypted S3 storage, a new-server restore,
or production RPO/RTO.
