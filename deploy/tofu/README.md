# OpenTofu environments

Staging and production have separate directories and state object keys. The
state bucket, S3-compatible endpoint, and credentials are supplied through a
reviewed `backend.hcl`; they are never committed. State storage must be separate
from package storage and must provide versioning, retention, encryption, and
operator-only access.

CI runs only formatting, `init -backend=false`, provider lock validation, and
`validate`. Real `plan` and `apply` require a separate operator workflow,
environment approval, short-lived credentials, and a reviewed immutable ref.

Cloudflare API tokens must be scoped to the account/zone and resources in this
module. The download authorization Worker and WAF rules are deployed as their
own signed artifacts after their application code exists; placeholder Worker
scripts are intentionally not provisioned.

The edge module aborts incomplete quarantine multipart uploads after one day,
deletes quarantine objects after seven days in staging or 30 days in production,
and locks digest-addressed published objects for seven days in staging or one
year in production. Published objects have no automatic delete lifecycle.

Lifecycle deletion is irreversible and bucket locks can prevent later overwrite
or deletion. Before the first apply against any pre-existing bucket, export and
review its current lifecycle and lock configuration, confirm no unmanaged rule
will be replaced, and retain the approved export with the plan. Retention
increases are treated as one-way changes for already locked objects; production
changes require the storage and security owners named in the restore runbook.
