# Initial capacity and SLO assumptions

These are design inputs, not measured production claims. Revisit them after
representative load and storage traces exist.

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
