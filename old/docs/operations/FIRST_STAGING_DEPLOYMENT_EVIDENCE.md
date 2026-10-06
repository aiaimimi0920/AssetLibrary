# First free-tier staging deployment evidence

Date: 2026-09-04

## Classification

This is the first real provider deployment of the AssetLibrary trial environment.
It proves that the existing provider-neutral implementation can use real managed
dependencies and that the public byte path works through Cloudflare. It is not a
production deployment, an HA test, a capacity result, or a P8/P9 acceptance.

The API runtime used the explicit development identity adapter because the
independent Account Service is not connected. App Update remained disabled for
every API process and was not admitted to the store.

## Deployed resources

The following dedicated resources were created or updated. Provider account IDs,
project names, endpoints, connection strings, and credentials are intentionally
excluded.

| Provider | Resource | Trial state |
| --- | --- | --- |
| Cloudflare | R2 `assetlibrary-staging-quarantine` | Created; private |
| Cloudflare | R2 `assetlibrary-staging-published` | Created; Worker-bound |
| Cloudflare | KV `assetlibrary-staging-policy` | Created; Worker-bound |
| Cloudflare | Queue `assetlibrary-staging-download-events` | Created; producer-bound |
| Cloudflare | Worker `neuro-assetlibrary-edge-staging` | Deployed on `workers.dev` |
| Neon | Existing trial PostgreSQL project | Migrations `0001` through `0016` applied |
| Aiven | `assetlibrary-trial-valkey` | Free single node, running |
| Aiven | `assetlibrary-trial-opensearch` | Free single node, running |

Worker URL:
`https://neuro-assetlibrary-edge-staging.vmjcv666.workers.dev`

No domain, WAF policy, rate-limit policy, bucket lifecycle, object lock, or
OpenTofu remote state was created in this trial. Those changes need a reviewed,
stateful rollout rather than ad hoc provider mutations.

## Verification results

### Edge build and deployment

- `pnpm --dir services/edge install --lockfile=false`: passed; the repository
  lockfile was neither read nor changed.
- `pnpm --dir services/edge typecheck`: passed.
- `pnpm --dir services/edge test`: 1 file and 9 tests passed.
- Cloudflare control-plane lookup found the deployed Worker.
- Secret metadata lookup found one `TICKET_SECRET` binding of type `secret_text`;
  the secret value was never queried.
- `GET /deployment-smoke` returned the Worker-owned `404 not found` contract with
  CORS, `Cache-Control: no-store`, and `X-Request-ID` headers.

### Real R2 -> KV -> Worker byte path

A stable, non-sensitive smoke object was uploaded to the staging Published bucket
and an exact public policy projection was written to the staging KV namespace.

- SHA-256:
  `a06b4fba38a88ebc777cf014d8cfd7b911e25f7d0c63c14eac1b1f17f5ec490d`
- File name: `assetlibrary-smoke.txt`
- Object key:
  `sha256/a0/a06b4fba38a88ebc777cf014d8cfd7b911e25f7d0c63c14eac1b1f17f5ec490d`
- Public smoke URL:
  `https://neuro-assetlibrary-edge-staging.vmjcv666.workers.dev/public/sha256/a06b4fba38a88ebc777cf014d8cfd7b911e25f7d0c63c14eac1b1f17f5ec490d/assetlibrary-smoke.txt`

Observed results:

| Probe | Result |
| --- | --- |
| Full GET | HTTP 200; all 41 bytes matched |
| Range `bytes=0-4` | HTTP 206; body matched |
| `Content-Range` | `bytes 0-4/41` |
| HEAD | HTTP 200 |
| Cache policy | `public, max-age=31536000, immutable` |
| Correlation | `X-Request-ID` present |

This confirms that a public download does not pass through the Axum API or Neon.
It does not yet prove purge propagation, global revocation, CDN hit ratio, queue
consumption, 10,000 concurrent downloads, or regional behavior.

### Neon PostgreSQL

All SQL files `0001` through `0016` were applied to the trial project. A fresh,
read-only PostgreSQL probe after the hybrid API run returned:

| Check | Result |
| --- | ---: |
| Required core tables | 5 of 5 |
| Migration checkpoints | 15 |
| Latest checkpoint | `0016_install_receipt_proof` |
| Public-schema constraints | 360 |
| API `/readyz` using this database | HTTP 200 |

The checkpoint count begins at `0002`, where `migration_checkpoints` is created;
therefore 15 checkpoints represent `0002` through `0016`. This free project does
not prove HA, PITR, RPO, RTO, PgBouncer capacity, or production restore behavior.

### Aiven Valkey and OpenSearch

- `assetlibrary-trial-valkey`: provider state `RUNNING`; TLS-authenticated
  `valkey-cli PING` returned `PONG`.
- `assetlibrary-trial-opensearch`: provider state `RUNNING`; authenticated cluster
  health returned `green`, `timed_out=false`, and one node.

Aiven now redacts service passwords from normal GET responses. The probe used the
documented `include_secrets=true` request only in process memory. No service URI,
host, user, or password was printed or stored. These free single-node services do
not prove availability, snapshots, scale, private networking, or SLA.

### Hybrid API runtime

`cargo build -p assetlibrary-api` passed. The compiled API was then started as a
local process with real Neon, R2, Aiven Valkey, Aiven OpenSearch, and Cloudflare
Worker settings injected through process environment variables.

| Probe | Result |
| --- | --- |
| `GET /healthz` | HTTP 200, `status=ok` |
| `GET /readyz` | HTTP 200 against Neon |
| `GET /v1/public/packages?limit=1` | HTTP 200; `PackagePage` contract verified |
| Object-store configuration | Loaded |
| Search/cache configuration | Loaded |
| Worker/API ticket secret | Matched by an in-memory rotation |
| App Update | `false` |

The process was stopped after the smoke test. It was not exposed as a public
service and it did not claim a staging identity: the Account Service is still an
external dependency.

## Credential handling

- The operator-provided key file was read directly and was not copied into the
  repository.
- Its current JSON has a trailing comma. Trial commands removed that comma only
  in memory; the source key file was not modified. The operator should repair the
  JSON before it becomes automation input.
- Long-lived provider tokens and connection strings were held only in process
  environment or memory and were cleared when each command ended.
- Temporary config, SQL, logs, and helper scripts were removed.
- No secret value, account ID, Neon host, Aiven host, or Aiven project name is
  present in this evidence.

The Worker ticket secret was generated only for the smoke test and is not retained
by AssetLibrary. Consequently, restricted downloads now fail closed unless a
future API deployment and Worker are given a newly rotated shared secret from a
real secret manager. Public downloads are unaffected.

## Deliberately incomplete items

- The GitHub token is valid, but API enumeration found no accessible repository
  named `AssetLibrary` and the local repository has no remote. No repository,
  protected environment, Actions secret, package, or release was created.
- A Grafana API token exists, but no Grafana stack/instance URL or OTLP/Prometheus
  endpoint was supplied. No telemetry was sent.
- No remote compute target was supplied. Next.js, Axum, NATS, scanner, indexer,
  outbox, cleanup, statistics, and ClickHouse remain local/not deployed.
- The OpenSearch cluster is healthy, but the versioned catalog index rebuild and
  alias switch were not executed against it in this trial.
- The Queue has a producer binding but no deployed consumer. Smoke events may
  expire under the free-tier retention policy.
- No restricted-ticket E2E, purge/revocation propagation, provider metrics,
  alert delivery, load, soak, fault, restore, canary, or rollback drill ran.

## Rollback boundary

All remote names carry `staging` or `trial`, and no production route references
them. No destructive rollback was executed because the user requested a first
deployment and the resources are the desired result.

For this first Worker deployment there is no known-good prior production version.
The safe rollback is to disable/delete the staging Worker route, then remove the
dedicated KV policy and smoke object. Database rollback follows the per-migration
instructions in `migrations/README.md`; do not reverse SQL ad hoc. Aiven services
can be deleted because Valkey and OpenSearch are rebuildable, but only after the
PostgreSQL source and outbox replay path are verified.

## Acceptance statement

The first deployment attempt is successful for the managed dependency and public
edge slice. It advances the P5 Cloudflare evidence from “local only” to “real
free-tier public-path smoke”. It does not close P1, P5, P8, P9, the production
gate, or the App Update admission gate.
