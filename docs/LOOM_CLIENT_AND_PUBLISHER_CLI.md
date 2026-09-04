# Loom client and Publisher CLI

This document defines the P7 client boundary. The implementation lives entirely
in AssetLibrary. It does not modify Loom or Hook, and it does not add account
storage to this repository.

## Components

- `crates/loom-client` is the reusable Loom-facing API, download, verification,
  installation transaction, and InstallReceipt adapter.
- `tools/publisher-cli` is the non-interactive publisher command-line client.
- `services/api` remains the only metadata authority. Neither client accesses
  PostgreSQL, Valkey, NATS, or object-store management credentials.
- Artifact bytes travel directly between the client and an allowlisted download
  or upload origin. The control-plane API never proxies the ZIP body.

Both clients use only versioned `/v1` endpoints. Contract responses use strict
deserialization; an unsupported shape or unknown field fails closed instead of
silently guessing a downgrade.

## Loom integration contract

### Online authorization and trust snapshot

An install starts with an opaque Account Service bearer held only in memory:

1. create a short-lived download session for an exact Artifact;
2. generate an ephemeral Ed25519 receipt proof key;
3. request an install challenge bound to the session, Artifact, Release, host
   profile digest, client instance, proof public key, nonce, and expiry;
4. download and verify the ZIP;
5. run the host-owned installation transaction;
6. sign and submit the InstallReceipt, or persist a non-secret queued receipt.

The challenge is the online trust snapshot. The client accepts it only while it
is unexpired. A new install cannot start while Account Service or AssetLibrary is
unavailable because the client cannot safely invent current authorization,
revocation, compatibility, or signing-key state.

### Verification before activation

`ResumableDownloader` performs all of the following before `InstallTarget` is
called:

- exact session/challenge/Artifact binding;
- exact download origin allowlist and redirect denial;
- `Range` response, `Content-Range`, content length, total size, and stall checks;
- raw archive SHA-256 and canonical ZIP SHA-256 checks;
- publisher public-key fingerprint and Ed25519 signature verification;
- strict Art or Capability Manifest validation;
- package identity, version, permission, platform, framework, API version,
  required feature, and Surface-node negotiation;
- current challenge expiry.

App Update packages are deliberately rejected by this client. App Update remains
behind the separate `crates/app-update-client` TUF and host rollback admission
gate defined by `docs/ADR/ADR-008-app-update-tuf.md`.

Partial content is stored under a private cache root. The client uses a bounded
response stream, a bounded retry count, final-component no-follow file opens,
digest-addressed paths, and a separate binding state file. A ZIP is promoted to
the verified cache with a no-clobber hard link and is verified again at its final
path before any installation transaction begins.

### Atomic host installation and rollback

Loom supplies an `InstallTarget`; AssetLibrary does not guess Loom's configured
Art, Capability, or framework directories. The target must implement this state
machine:

```text
prepare(package)
  -> commit(transaction)
       -> finalize(transaction)       # success
       -> rollback(transaction)       # commit/check/finalize failure
  -> rollback(transaction)            # cancellation after prepare
```

The method-level invariants are:

- `prepare` writes immutable staged content without changing the active version;
- `commit` atomically switches activation while retaining the previous version;
- `finalize` removes staging and the retained backup only after local checks and
  receipt signing have succeeded;
- `rollback` is idempotent and restores the previous active version;
- a rollback failure is surfaced as `RollbackFailed`, never as install success.

Network receipt synchronization happens after finalization. A temporary account
or API outage therefore does not undo a verified local install; it produces a
durable pending receipt instead.

### Offline and Account Service behavior

| State | Behavior |
| --- | --- |
| No download session/challenge | Installation is blocked; online authorization is required. |
| Unexpired challenge and a previously verified cache entry in the current client flow | Installation may proceed without another byte download. |
| Challenge expired | Verification fails closed, including for cached bytes. |
| Network drops during download | The `.part` file and binding state remain; the next attempt resumes with `Range`. |
| Account unavailable after local commit | Return `ReceiptSync::Pending` and enqueue the signed, non-secret receipt. |
| Receipt returns 401 | Keep it pending until Account Service authentication is restored. |
| Receipt returns a retryable transport/408/429/5xx failure | Keep it pending for bounded later retry. |
| Receipt is rejected | Keep explicit rejected status for operator/user handling; never report it as synced. |

This is preauthorized offline continuation, not indefinite offline trust. The
client does not persist an unsigned challenge as a long-lived authority. A
revoked Release or key cannot receive a new challenge; an already issued trust
snapshot is bounded by its short expiry.

The proof key is an ephemeral software key and the receipt is cryptographic
self-attestation, not hardware attestation. Queue documents contain no Account
bearer, download ticket, presigned URL, or proof private key.

## Publisher CLI

### Security model

- Supply the opaque Account Service bearer by environment-variable name. There
  is no command-line token argument.
- HTTPS is mandatory unless `--allow-http` is explicitly used for local
  development.
- Upload origins are an exact scheme/host/port allowlist. Redirects are disabled.
- The Account bearer is sent only to AssetLibrary API endpoints, never to a
  presigned object-storage URL.
- A private signing key must be a regular PKCS#8 PEM file outside the package
  source. Symlink keys are rejected; Unix group/other permissions must be zero.
- JSON/stdout and errors never contain bearer values, private keys, presigned
  URLs, or object keys.

### Build

```powershell
cargo build --locked -p assetlibrary-publisher
```

The executable is `target/debug/assetlibrary-publisher.exe` on Windows and
`target/debug/assetlibrary-publisher` on Unix. Formal packaging belongs to the P9
release process; a development build is not a signed product release.

### Create and pack a package

`manifest` initializes a new output directory atomically and refuses to overwrite
an existing directory. Add the declared runtime entrypoint after initialization.

```powershell
assetlibrary-publisher --json manifest `
  --kind art `
  --publisher publisher.example `
  --package sample-art `
  --version 1.2.3 `
  --key-id release-1 `
  --output-dir .\sample-art

# Add .\sample-art\runtime\main.exe before packing.
assetlibrary-publisher --json pack `
  --kind art `
  --publisher publisher.example `
  --package sample-art `
  --version 1.2.3 `
  --source .\sample-art `
  --output .\sample-art-1.2.3.zip `
  --private-key C:\private\publisher-key.pem `
  --key-id release-1 `
  --executable runtime/main.exe
```

The packer sorts paths, normalizes ZIP metadata and permissions, rejects unsafe,
duplicate, empty, symlink, and reserved signature entries, computes the canonical
digest, signs it, writes `signature.json`, then reopens and validates the final
archive before a no-clobber publish. Identical inputs and key produce identical
archive bytes. `--dry-run` executes the same validation without persisting the
archive.

Use `digest` to display raw and canonical SHA-256 values, and `validate` with the
registered public key to verify a package independently:

```powershell
assetlibrary-publisher --json digest --archive .\sample-art-1.2.3.zip
assetlibrary-publisher --json validate `
  --kind art --publisher publisher.example --package sample-art --version 1.2.3 `
  --archive .\sample-art-1.2.3.zip `
  --public-key .\publisher-public-key.txt `
  --key-id release-1
```

### Publish through the service layer

Register the matching public key in the Publisher Console before submission.
Then set only process-local configuration:

```powershell
$env:ASSETLIBRARY_API_URL = 'https://assets.neuro.example/'
$env:ASSETLIBRARY_TOKEN = '<opaque Account Service bearer>'
$env:ASSETLIBRARY_UPLOAD_ORIGINS = 'https://upload.assets.neuro.example'
```

The lifecycle commands are:

```powershell
assetlibrary-publisher --json package-create `
  --publisher-id <publisher-uuid> --kind art --visibility private `
  --slug sample-art --name 'Sample Art'

assetlibrary-publisher --json release-create `
  --package-id <package-uuid> --version 1.2.3 --loom '^1.0'

assetlibrary-publisher --json upload `
  --release-id <release-uuid> --archive .\sample-art-1.2.3.zip

assetlibrary-publisher --json submit `
  --release-id <release-uuid> --artifact-id <artifact-uuid>

assetlibrary-publisher --json status --release-id <release-uuid>
```

Mutation commands accept `--idempotency-key`; otherwise the CLI generates a safe
key and returns it in JSON for audit/retry correlation. Multipart upload uses at
most three concurrent bounded part buffers and dynamically lowers concurrency for
large parts. Its no-secret resume descriptor is stored beside the ZIP. Recovery
re-hashes the exact file, reloads server-authoritative uploaded parts, skips exact
matches, requests fresh presigned URLs, and never recreates the upload session.

## Hook not-applicable inventory

Hook remains unmodified in P7. The following table prevents AssetLibrary-side
contract work from being mistaken for a delivered Hook integration.

| Area | P7 status | Later Hook-owned work |
| --- | --- | --- |
| Public catalog browsing | Service contract applies | Optional Hook UI/client surface. |
| Capability Manifest `hookExtensionApi` | Schema and compatibility field apply | Build Hook host profile and feature negotiation adapter. |
| Art package installation | Not applicable to Hook | None unless Hook later becomes an Art host. |
| Capability download/cache | Contract available, not integrated | Add Hook API client and private cache ownership. |
| Atomic activation/rollback | Interface pattern available, not integrated | Implement Hook-specific staging, activation, backup, and rollback. |
| InstallReceipt | API contract available, not emitted by Hook | Decide whether Hook installations earn library/rating eligibility, then integrate. |
| Store UI | Not integrated | Apply Neuro UI rules in a separate Hook repository task. |
| App Update | Not applicable; feature disabled | Requires the independent P9 TUF/root-key/rollback gate. |

Any future Hook implementation must consume versioned service APIs, preserve the
independent Account Service boundary, avoid database or object-store management
access, and be developed and released from the Hook repository as a separate
change.

## Verification

Focused local gates:

```powershell
cargo test -p assetlibrary-loom-client
cargo test -p assetlibrary-publisher
cargo clippy -p assetlibrary-loom-client -p assetlibrary-publisher --all-targets -- -D warnings
.\scripts\Test-InstallReceiptRuntime.ps1
.\scripts\Test-ScannerVerifiedRuntime.ps1
.\scripts\Test-P7Runtime.ps1
```

The Rust tests cover strict compatibility negotiation, resumable and corrupted
downloads, final-path verification, offline continuation, receipt queue replay,
activation rollback, deterministic packaging, private-key containment, complete
publisher command mapping, direct multipart upload, retry, recovery, and bearer
separation. The two PowerShell gates exercise the real local API, PostgreSQL,
outbox/scanner, MinIO, signature, revocation, anti-replay, and library projection
boundaries.

`Test-P7Runtime.ps1` is the composite local gate. It runs the Loom and CLI tests,
strict Clippy, the real Publisher API runtime, signed scanner promotion, public
and restricted download/library behavior, and the InstallReceipt runtime in one
fail-fast command. Pass `-StartDependencies` when the local dependency stack has
not already been started.

These are local P7 gates. They do not prove production Cloudflare R2/CDN behavior,
a released Loom host adapter, 24-hour soak, disaster recovery, or P9 signed release
artifacts.
