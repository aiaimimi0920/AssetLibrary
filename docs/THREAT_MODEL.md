# Threat Model

## Assets

- Publisher identity references and authorization decisions.
- Package metadata, release manifests, artifact digests, and review history.
- Uploaded package bytes and derived previews.
- Download authorization, install receipts, ratings, and audit records.

## Primary threats and controls

| Threat | Required control |
| --- | --- |
| Malicious archive or path traversal | Quarantine first; validate archive type, size, entry count, normalized paths, symlinks, and decompression ratio in a sandbox. |
| Serving unverified bytes | Publication requires a verified immutable artifact and a passing moderation decision. |
| Credential or ticket replay | External issuer validation with issuer/audience/algorithm checks; short-lived, single-purpose edge tickets; nonce/idempotency where needed. |
| Origin abuse and egress exhaustion | CDN/object storage serves bytes; API only creates sessions and tickets; per-principal and per-IP quotas. |
| Supply-chain tampering | Digest-addressed objects, signed manifests, SBOM/provenance, dependency lockfiles and vulnerability gates. |
| App Update freeze, rollback, or cross-channel substitution | Independent product/channel TUF Roots, short-lived Timestamp, persistent trusted state, monotonic release sequence and policy epoch, signed control target, and fail-closed activation. |
| App Update online-key compromise | Offline 2-of-3 Root and Targets roles; separate HSM-backed Snapshot/Timestamp keys cannot authorize executable bytes. |
| Worker escape or resource exhaustion | Dedicated least-privilege worker identity, no host mounts, bounded CPU/memory/time, restricted network, and kill-on-timeout. |
| Search or cache poisoning | OpenSearch and Valkey contain projections only; rebuild from Postgres; namespace keys and validate all serialized data. |
| Reviewer or operator misuse | Separate roles, two-person approval for sensitive moderation actions, append-only audit events, and fail-closed permissions. |

## Trust tiers

Art, Capability, and future App Update packages use the same quarantine and
verification pipeline. A publisher may be verified for metadata publishing,
but package trust is earned per release. Unverified, revoked, or quarantined
artifacts are never installable.
