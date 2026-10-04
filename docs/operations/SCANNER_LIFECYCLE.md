# Scanner inspection lifetime

The worker admits one inspection workspace at a time per process. Admission is
acquired before creating temporary files or downloading another artifact. The
workspace owns both its temporary directory and the admission permit through
local ZIP inspection, signature verification, malware scanning and promotion.

Local ZIP/hash/JSON inspection runs in a child of the same scanner executable,
using the internal `--inspect-local` entry before Tokio, telemetry or service
configuration is initialized. It does not execute archive contents. The parent
still owns trusted-key lookup, signature verification, ClamAV and promotion.

A single `spawn_blocking` supervisor owns the workspace and child. Dropping the
awaiting future, including the existing pipeline timeout, signals cancellation.
The supervisor checks that signal every 10 ms, terminates the child and waits
for the OS to reap it before releasing the directory or admission permit. The
poll interval is not an OS termination SLA. Panic/error paths also kill and reap;
an unrecoverable OS reaping error terminates the worker rather than admitting
another job with an unowned child. Late results cannot resume promotion.

The message loop waits for that workspace to be released before polling and
claiming another artifact. The existing retry/evidence rules and timeout error
code are unchanged. JetStream's existing prefetch/delivery mechanism and
`max_ack_pending=1` remain; the wait does not promise that the broker has never
delivered another message, only that this worker does not claim/start it early.
Normal worker shutdown drains the outstanding supervisor before returning.

## Child protocol and trust boundary

The supervisor launches the current executable directly, without a shell, in
its private workspace. Environment variables are cleared except Windows
`SystemRoot`; standard input/output/error are disconnected. Database, storage,
account, proxy and telemetry credentials are not passed to the child.

Fixed workspace filenames carry a metadata-only request (64 KiB maximum) and
typed result (2 MiB maximum). Neither object keys nor service credentials enter
the request. Reads stop at limit + 1; writes use create-new semantics. Missing,
oversized, malformed, unknown-error or unsuccessful child results remain the
retryable `scanner_task_failed` error. Existing archive validation failures keep
their permanent error codes; timeout remains `scanner_timeout`. No fallback
retries archive parsing inside the parent process.

## Verification

`cargo test --locked -p assetlibrary-scanner-worker -p assetlibrary-supply-chain`
covers workspace ownership plus real child timeout/kill/reap/recovery, spawn
failure, crash, protocol bounds and invalid results. The ignored `child_fixture`
test is an internal helper explicitly launched by these tests, not an unexecuted
acceptance gate. `local_inspector_cli` exercises the actual executable with a
signed harmless ZIP and independently verifies its raw/canonical digest and
Ed25519 signature. It also proves that child mode does not initialize service
configuration. Fixtures stay under the configured temporary root.

Use `cargo test --locked --release -p assetlibrary-scanner-worker --test
local_inspector_cli` to exercise the release executable. These are local process
and protocol tests, not PostgreSQL/NATS/S3/ClamAV environment acceptance.

The separate [dependency validation](SCANNER_DEPENDENCY_VALIDATION.md) now covers
native Windows Scanner/Outbox with isolated PostgreSQL/NATS/MinIO and a real
local ClamAV service: fail closed while ClamAV is unavailable, retry after
recovery, immutable-address promotion, duplicate-event acknowledgement without
new scan evidence, invalid ZIP quarantine and the next successful scan.

## Remaining limits

This adds termination of the local parser process, not a complete OS sandbox,
per-process CPU/RSS/disk quotas or protection against abrupt parent termination.
The child still has the service OS user's filesystem/network privileges. Hard
parent crashes need an OS job/cgroup lifecycle policy. A stuck OS filesystem,
process creation or reaping operation may still delay the supervisor. ClamAV
may continue server-side work after a client disconnect; this does not measure it.

Temporary-directory deletion is RAII best effort and may fail on external file
locks. ZIP central-directory allocation, JSON peak RSS, Linux worker validation,
other dependency failures, managed/production recovery and whole-stack resource
measurements remain separate acceptance work. No
database migration, cloud deployment, signature policy or App Update admission
is changed here.
