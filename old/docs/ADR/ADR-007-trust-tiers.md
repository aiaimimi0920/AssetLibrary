# ADR-007: Package trust tiers

Status: Accepted

Art packages are data-oriented but still require archive safety, manifest,
digest, policy, and malware verification. Capability packages may execute code
and additionally require permission declarations, publisher verification,
provenance, SBOM, sandbox policy, and manual review. App Update packages affect
the host application and additionally require TUF-style threshold roles,
expiry, rollback protection, staged rollout, and recovery evidence.

The concrete App Update repository, role, client, channel-isolation, and
admission decision is defined by `ADR-008-app-update-tuf.md`.

A higher publisher trust level never bypasses per-release verification.
Revocation and suspension fail closed for all new download authorizations.
