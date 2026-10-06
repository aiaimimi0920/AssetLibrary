# Capacity inputs and evidence requirements

The current baseline is [ADR-009](ADR/ADR-009-managed-postgres-small-scale.md):
approximately 100 users with usually one or two active users. This is a workload
input, not measured capacity, requests per second or an uptime guarantee.
Hook/Loom EXE login/refresh, metadata/revocation checks and simultaneous package
updates count as workload. Measure API and download bytes separately.

No minimum RAM/CPU, peak RSS, managed-hosting savings or achieved SLO is claimed.
First collect a harmless-fixture baseline for idle Web/API, one and two concurrent
bounded catalog requests, one isolated scan, queue/retry recovery and concurrent
control requests during scanning. Record commit/toolchain, fixture size/hash and
entry count, concurrency, elapsed time, RSS, CPU and temporary disk. Include
scanner/ClamAV separately and together; account for central-directory/JSON peaks
and blocking tasks still running after an async timeout. Do not execute uploaded
content or use real malicious samples for resource measurement.

The scanner template's `2Gi` request is a scheduling reservation, not measured
RSS. A 64 KiB streaming buffer is only one allocation. Hosting PostgreSQL elsewhere
does not prove any decrease in the API/scanner's own memory. Unavailable results
must say **not measured**, not an estimated footprint.

Latency, availability, RPO and RTO targets for the new single-instance profile
remain to be validated against provider, backup/restore and failure requirements.
Single-instance service implies maintenance downtime and a single point of
failure; it is not the old HA topology. Existing security/evidence gates remain
until separately and explicitly revised, and no production claim is made here.

## Historical large-scale assumptions (superseded as first-stage sizing)

These former design inputs are retained to interpret existing P8 profiles. They
are not the current small-scale requirement and were not measured production
claims. Existing P8/production evidence validators are unchanged by this document;
any profile/eligibility revision is a separate tested change.

- 1,000 catalog browse requests/second sustained.
- 200 search requests/second sustained.
- 100 upload-session operations/second sustained.
- 10,000 concurrent public downloads served by CDN/R2, not the control plane.
- 25 MiB average package object and 10 TiB annual object growth.
- At least 40% capacity headroom at the target load.
- Catalog browse p95 below 300 ms and search p95 below 500 ms.
- Metadata write p95 below 400 ms and upload finalization p95 below 1 second.
- Control-plane 5xx rate below 0.1%.
- Event lag below 30 seconds and search freshness below 60 seconds.
- Metadata RPO at most 5 minutes; analytics RPO at most 15 minutes.
- Zonal RTO at most 15 minutes; regional RTO at most 60 minutes.

Download throughput and latency are CDN/object-store SLOs. They are measured
separately from API latency so large or concurrent downloads cannot hide control
plane saturation.

Executable profiles, generator requirements, safety stops, and evidence rules
are defined in [`operations/LOAD_TEST_PLAN.md`](operations/LOAD_TEST_PLAN.md).
