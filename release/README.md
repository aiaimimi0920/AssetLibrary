# Release evidence workspace

This directory is the bounded workspace for AssetLibrary release evidence. The
repository tracks this policy only; generated `evidence/`, `downloads/`, and
`candidate/` directories are ignored and must be retained by the release system
as immutable workflow artifacts.

## Signed image candidate

`.github/workflows/release.yml` accepts an exact 40-character source commit and
SemVer, then runs the same reusable security and quality workflows used for pull
requests and the default branch. It builds six images from digest-pinned bases,
scans each digest, signs it with GitHub OIDC/Sigstore, and attaches provenance and
SPDX SBOM attestations. The final job assembles:

- exact image digests and per-image checksums;
- source and image SPDX documents;
- OSV, pnpm, Trivy image, and Trivy IaC reports;
- Cosign verification and Sigstore attestation bundles;
- the same-commit CI result and exact-digest API/web container smoke result;
- all ordered SQL migrations;
- release-specific Helm values, a default digest-bound render, and a second
  disabled-by-default progressive-delivery render containing the exact
  5% -> 25% -> 100% Argo Rollouts contract;
- `release-candidate.json` and a top-level `SHA256SUMS` inventory.

`scripts/release-candidate-evidence.mjs` rejects missing, additional, linked,
oversized, cross-commit, vulnerable, checksum-invalid, or mutable image evidence.
Both renders keep App Update disabled, bind every first-party image by digest,
and are checked by Kubeconform. The progressive render additionally requires
the pinned controller contract, NGINX traffic routing, and fail-closed request
rate, 5xx, p95, and global-alert analysis. The manifest is also validated against
`schemas/release-candidate-evidence.schema.json`.

## Deliberate production boundary

A rendered Rollout is a deployment contract, not evidence that the controller is
installed or that any traffic moved. A signed candidate is **not a production
release**. Its schema permanently sets
`production_release_eligible` and `app_updates_enabled` to `false`, and records
these unresolved external gates:

1. P8 representative-cloud acceptance;
2. provider-side release/evidence authenticity;
3. observed 5% -> 25% -> 100% canary progression;
4. automatic rollback driven by production SLO burn.

No operator may edit a candidate manifest to change those values. The separate
`production-promotion-evidence.schema.json` contract references the immutable
candidate, provider deployment evidence, P8 evidence, ordered canary
observations, database checkpoint, rollback decision, and post-promotion smoke
evidence. Its repository verifier deliberately emits
`production_release_eligible: false`: an external provider/controller/reviewer
attestor is still required. App Update also remains disabled until its independent TUF root,
metadata, rotation, revocation, freeze/rollback protection, and client rollback
path have passed their own gates.
