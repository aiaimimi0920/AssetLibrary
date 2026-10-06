# ADR-008: Native application-update TUF repositories

Status: Accepted

Date: 2026-09-04

## Context

An App Update replaces executable host code. Publisher Ed25519 signatures used
for Art and Capability packages, the AssetLibrary database publication state,
and Sigstore identity for server containers do not establish a safe desktop
update chain. The updater must remain safe when the catalog API, CDN, object
store, or an online metadata key is stale or compromised.

Hook and Loom also need a native, separately replaceable updater process. Adding
a Python runtime to either application would increase packaging and patching
surface. Implementing TUF signature and canonical-JSON rules ourselves would
create a higher security risk.

## Decision

AssetLibrary owns a reusable Rust client in `crates/app-update-client`. It uses
the pinned `tough` 0.24.0 client with expiration enforcement, persistent rollback
state, bounded metadata, consistent snapshots, target hash/length verification,
and atomic target writes. Hook and Loom integration remains a separate later
task; neither repository is modified by this ADR.

The selected library documents TUF 1.0.0 support but does not support delegated
roles. We will not emulate delegation in application code. Instead, production
uses six isolated repositories:

```text
loom-stable    loom-beta    loom-nightly
hook-stable    hook-beta    hook-nightly
```

Each repository has an independent bootstrap Root and independent role keys.
Changing a channel is an explicit host choice that selects another embedded
bootstrap Root; a remote response cannot switch product or channel. This costs
more key ceremonies, but removes cross-product and cross-channel delegation
blast radius and stays within the verified library feature set.

## Repository and key policy

Every Root must use consistent snapshots and these non-overlapping key sets:

| Role | Threshold | Keys | Algorithm | Custody |
| --- | ---: | ---: | --- | --- |
| Root | 2 | 3 | Ed25519 | independently held offline devices |
| Targets | 2 | 3 | Ed25519 | independently held offline devices |
| Snapshot | 1 | 1 | ECDSA P-256 | online HSM-backed service identity |
| Timestamp | 1 | 1 | ECDSA P-256 | separate online HSM-backed service identity |

Root rotation is sequential. A new Root is accepted only when it is signed by
the old Root threshold and its own new threshold. An emergency rotation must not
skip a version. Bootstrap Root bytes are public but ship read-only with each host
binary; a writable metadata cache is never a bootstrap trust anchor.

Maximum validity is one year for Root, 90 days for Targets, seven days for
Snapshot, and 24 hours for Timestamp. Operational publication should renew well
before those ceilings. An expired Timestamp is a failed update check, not
permission to disable expiration enforcement. The currently active application
continues to run unless a separately designed product safety policy says
otherwise.

## Target and control contracts

Release targets use one canonical path:

```text
release.<platform>.<release-sequence>.<safe-filename>
```

`release-sequence` is a positive, monotonically increasing integer. It is the
rollback boundary; SemVer remains display and compatibility information. TUF
target custom metadata repeats product, channel, platform, sequence, SemVer, and
updater protocol. The client requires exact repository identity and rejects
unknown custom fields, non-canonical paths, remote downgrades, and prereleases in
the stable repository.

Every repository also publishes a fixed signed target per platform:

```text
control.<platform>.json
```

The control target contains a monotonic policy epoch, an installation kill
switch, a minimum allowed release sequence, and a bounded set of revoked
artifact SHA-256 digests. The catalog API may suggest a release target but is not
a trust authority: the client independently fetches and verifies the control
target and exact candidate through TUF.

Verified control metadata and candidate descriptors are opaque client result
types. Host integrations can inspect them through read-only accessors but cannot
construct or alter one and then pass it into the download or rollback boundary.

The kill switch stops new activation. A local rollback after a failed launch is
allowed only when the retained prior digest is not revoked and its sequence is
not below the signed floor. Otherwise the updater reports recovery-required; it
must not activate a known-revoked binary or invent an unsigned downgrade.

## Client state and activation boundary

The TUF datastore and updater activation journal live in an updater-owned,
access-controlled directory. Deleting or replacing trusted local state is not a
normal recovery mechanism. Only one updater instance may own a product/channel
state directory at a time.

Download completes into a private staging directory and is digest-verified
before host installation. The host adapter must implement prepare, atomic
activation, health check, finalize, and idempotent rollback while retaining the
last known-good version. Database or catalog state never authorizes executable
activation.

## Admission and remaining evidence

`ASSETLIBRARY_APP_UPDATES_ENABLED` remains false. Enabling requires all of:

1. six production Roots and external root-ceremony evidence;
2. sequential old/new threshold rotation and compromised-key rehearsal;
3. expiry/freeze, rollback, mix-and-match, wrong product/channel, path, length,
   digest, kill-switch, revocation, and state-deletion adversarial tests;
4. HSM identities and separation for Snapshot and Timestamp;
5. reproducible updater binaries with SBOM, provenance, signature, and digest;
6. Hook and Loom host activation, failed-launch rollback, single-instance lock,
   and recovery-mode end-to-end evidence;
7. staged rollout and promotion evidence from P8/P9.

Repository schemas and unit tests are implementation foundations only. They do
not assert that a production Root exists or that App Update is safe to enable.

## Consequences

- Native Rust integration avoids a bundled language runtime and reuses the
  existing host installation boundary.
- Six Roots increase ceremony and monitoring work but provide explicit isolation
  without relying on an unsupported delegation feature.
- Snapshot/Timestamp compromise cannot sign a new executable target; offline
  Root/Targets compromise still requires threshold response and rotation.
- Offline clients may keep running their current version, but cannot claim a
  fresh update decision after metadata expires.
- `python-tuf` may be used later as an independent conformance oracle; it is not
  a product runtime dependency or signing authority.

## References

- TUF specification: <https://theupdateframework.github.io/specification/latest/>
- `tough` 0.24.0 client documentation: <https://docs.rs/tough/0.24.0/tough/>
- TUF metadata roles: <https://theupdateframework.io/docs/metadata/>
