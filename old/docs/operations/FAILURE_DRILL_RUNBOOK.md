# Component failure drill runbook

P8 requires explicit degradation behavior for API dependencies. Repository-local
drills prove only the application contract against single-node Docker Compose;
they do not prove Kubernetes rescheduling, availability-zone failover, regional
recovery, provider control-plane behavior, or production RTO.

## Safety boundary

- Run only against the local Compose project in `deploy/local/compose.yaml`.
- Pass `-ConfirmLocalFaultInjection`; validation alone never stops a service.
- The drill uses `docker compose stop`, never `down`, `down -v`, volume deletion,
  or data-directory mutation.
- PostgreSQL, Valkey, and OpenSearch must all be running before the drill begins.
  A pre-existing outage is rejected rather than silently repaired or reclassified.
- Every stopped service remains registered for recovery until `compose up -d
  --wait` succeeds. The `finally` path retries recovery after any assertion failure.
- A cleanup or restart failure makes the evidence fail. Check Compose state and
  restore the local dependency before running another workflow.

## Executed contracts

| Fault | Expected behavior |
| --- | --- |
| Valkey stopped | `/readyz` remains 200 and an uncached search remains 200 through OpenSearch within the 1-second local bound |
| OpenSearch stopped | `/readyz` remains 200 while an uncached search returns 503 |
| PostgreSQL stopped | `/healthz` remains 200 and `/readyz` returns 503 |
| PostgreSQL restored | the same API process eventually returns 200 from `/readyz` |

The script creates an empty, uniquely named OpenSearch fixture index and points
the API at it. This avoids depending on prior seeding or a cached response. The
index is deleted after the dependencies have been restored.

## Commands

Validate wiring without changing runtime state:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\Test-LocalDependencyFailure.ps1 -ValidateOnly
```

Execute the local fault drill:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\Test-LocalDependencyFailure.ps1 -ConfirmLocalFaultInjection
```

The actual run builds the API, starts it on loopback, performs baseline checks,
injects one dependency outage at a time, restores that dependency, and writes an
ignored evidence directory below `test-results/p8-failure/`.

## Evidence and acceptance

`run-manifest.json` records timestamps, nullable Git commit, each HTTP path,
expected and observed status, recovery duration, dependency list, cleanup failure
count, and limitations. It contains no local credentials or response bodies.

A local run passes only when all HTTP contracts pass and all stopped services and
the temporary index are removed or restored. Production P8 acceptance additionally
requires:

1. workload and node failure under representative Kubernetes topology;
2. database, queue, search, cache, object-store, and CDN provider fault exercises;
3. alert delivery and trace correlation during the fault window;
4. measured error budget impact, recovery time, data reconciliation, and operator
   timeline;
5. availability-zone and regional drills meeting the RTO/RPO gates in
   `DEVELOPMENT_PLAN.md`.
