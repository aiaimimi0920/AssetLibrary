# OpenTelemetry 0.33 compatibility boundary

The API, SDK, OTLP exporter, and tracing bridge form one Rust type boundary.
Upgrade `opentelemetry`, `opentelemetry_sdk`, and `opentelemetry-otlp` to 0.33
with `tracing-opentelemetry` 0.34, not as independent changes. The separate
Dependabot PRs #81, #86, and #89 failed compilation because they mixed 0.32 and
0.33 types. Dependabot now groups this family without excluding major updates
or weakening any CI/security gate.

## Preserved behavior

- Public AssetLibrary APIs, database schemas, queue payloads, and metrics names
  do not change. No data migration or deployment is part of this update.
- W3C `traceparent` and `tracestate` continue across HTTP and worker carriers.
  Unrelated headers, including authorization, are not propagated by this layer.
- The exporter remains OTLP/HTTP protobuf with the blocking reqwest client and
  the SDK batch processor; dropping `Telemetry` shuts down and flushes the provider.
- HTTP retry was already enabled by `experimental-http-retry` in 0.32. In 0.33
  it is enabled by default, so the removed experimental feature is omitted.
  Upstream bounds the default policy to three retries (four attempts total).
- No credentials, endpoint values, or provider resources are introduced.

## Deliberate upstream tightening

OpenTelemetry 0.33 rejects invalid configured endpoints instead of silently
falling back to localhost. Its W3C parser enforces the 32-member tracestate
limit. OTLP/HTTP adds bounded request and response bodies. These are documented
fail-closed/bounded behaviors, not a promise of byte-identical diagnostics for
invalid inputs. AssetLibrary still permits no OTLP endpoint for local use.

References:

- [OpenTelemetry 0.33 release and migration notes](https://github.com/open-telemetry/opentelemetry-rust/blob/opentelemetry-0.33.0/docs/release_0.33.md)
- [Observability configuration and privacy rules](OBSERVABILITY_RUNBOOK.md)

## Verification and rollback

`crates/telemetry/tests/trace_contract.rs` uses frozen W3C identifiers to verify
exported API/worker parentage and invalid-context rejection. It passes against
both the previous 0.32 family and the 0.33 family. The separate OTLP contract
starts a bounded loopback collector and an environment-isolated subprocess;
it verifies protobuf export, retry of a 503 with an unchanged batch, shutdown
flush, and rejection of an invalid configured endpoint. The ignored
`export_probe` is a subprocess helper executed by these tests, not a missing
provider acceptance test.

Run:

```powershell
cargo test --locked -p assetlibrary-telemetry
cargo test --workspace --locked
cargo fmt --all -- --check
node --test scripts/test-dependabot-coverage.mjs
powershell -NoProfile -File scripts/Test-SourceSize.ps1
git diff --check
```

Rollback the four manifest versions and their Cargo-generated lockfile changes
together. Never roll back just one crate. Existing immutable binaries may be
redeployed under the normal release process; no database rollback is required.
Local tests and CI do not prove Grafana/provider receipt or production rollout.
