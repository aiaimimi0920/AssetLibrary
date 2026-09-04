# Release and supply-chain security runbook

## Purpose and trust boundary

This runbook covers source validation, immutable image construction, candidate
evidence, and the boundary before production promotion. It does not claim that a
GitHub Actions artifact proves cloud deployment, service health, cost, disaster
recovery, or canary success. Account Service credentials, publisher private keys,
cloud credentials, and application-update root keys must never enter candidate
evidence.

The release workflow consumes one full lowercase Git commit SHA. Security scans,
quality gates, image builds, and candidate assembly must all report that same SHA.
A tag or a mutable branch name is not an acceptable identity after preparation.

## Pinned toolchain

`security/dependency-security-policy.json` is the source of truth for pinned
GitHub Actions and scanner images. `deploy/images/build-matrix.json` fixes the six
first-party components and all builder/runtime base images, including the ClamAV
sidecar used by the rendered deployment. Renovation of any pin is a reviewed
policy change and must rerun the complete workflow.

The shared security workflow runs:

- GitHub dependency review for pull requests;
- Syft source SPDX generation;
- recursive OSV lockfile/source scanning;
- bounded pnpm audits for all three JavaScript workspaces;
- Gitleaks secret scanning;
- Trivy deployment/IaC scanning;
- CodeQL for Rust and JavaScript/TypeScript.

CodeQL writes SARIF to a retained workflow artifact. This keeps the scan usable
for a private trial repository whose plan has not enabled GitHub code scanning;
it does not pretend that the SARIF was uploaded to the repository Security tab.
When code scanning is enabled, a reviewed workflow change may switch the pinned
analyze action back to provider upload.

Each pnpm audit has a five-minute process deadline plus a termination grace
period. Timeout is failure, never an empty or successful report. Scanner,
dependency, secret, SBOM, provenance, signature, and quality failures prevent the
release jobs from reaching candidate assembly.

## Dependency exceptions

An exception is allowed only for a concrete advisory ID with a specific reason,
owner role, independent reviewer role, evidence file, creation date, and expiry.
The maximum lifetime is 90 days. The JSON registry, Cargo audit configuration,
and OSV configuration must agree. Broad package ignores, indefinite expiry, and
an exception created only in CI configuration are prohibited. Role labels in the
repository do not prove that a human approval occurred; protected-environment and
change-system evidence remain external requirements.

## Image build and verification

The `release` GitHub environment must require designated release reviewers and
must restrict deployment branches/tags. Repository settings must also protect the
release workflow and CODEOWNERS paths. The environment is an external control;
its current settings cannot be inferred from repository YAML.

For each component, the workflow:

1. checks out the already scanned and tested commit;
2. builds from digest-pinned bases with a locked dependency graph;
3. pushes both SemVer and source-SHA tags but records only the registry digest;
4. generates an image SPDX document and runs Trivy against `image@digest`;
5. signs `image@digest` with keyless Cosign;
6. verifies the certificate issuer and exact workflow identity;
7. attaches SLSA provenance and SPDX SBOM attestations;
8. hashes the complete per-image evidence set.

After all six jobs succeed, a separate job pulls the recorded API and web
digests, verifies their OCI source-revision labels, starts them as their declared
non-root users, and probes API health plus a server-rendered web response over an
isolated Docker network. That packaged-image result is bound to both digests and
included with the source-level CI result.

Tags are navigation aids only. Deployment values and the rendered manifest must
use `image@sha256:...`. A mutable tag or a signature whose workflow identity does
not match the current repository/ref is a hard failure.

## Candidate evidence assembly

The final workflow job downloads artifacts from the current workflow run without
merging their directories. `scripts/release-candidate-evidence.mjs` requires the
exact six component directories and exact security/quality directories. It
rejects symlinks, unexpected files, invalid hashes, findings, inconsistent
commits/versions/registries, missing migration numbers, and missing deployment
digests. Helm renders both the default Deployment form and a progressive form
with App Update disabled, then Kubeconform checks both outputs. The progressive
render contains exactly two Rollouts (API and web), 5/25/100 traffic steps,
stable/canary Services, TLS NGINX Ingress routing, and eight fail-closed
Prometheus checks covering traffic floor, 5xx ratio, p95 latency, and global SLO
alerts. Its annotations bind the reviewed Argo Rollouts version and controller
image digest; the chart does not install that cluster-scoped controller.

The completed candidate contains `release-candidate.json` plus `SHA256SUMS`.
Validate a downloaded directory before review:

```powershell
node scripts/validate-json-schema.mjs `
  --schema schemas/release-candidate-evidence.schema.json `
  --document release/candidate/release-candidate.json
node scripts/release-candidate-evidence.mjs `
  --phase verify `
  --output release/candidate
```

The verifier proves internal structure, hashes, and same-run bindings. It does
not independently contact Fulcio, Rekor, GitHub, GHCR, or the cloud provider;
provider authenticity must be independently verified before production.

## Promotion evidence contract

`schemas/production-promotion-evidence.schema.json` defines the immutable input
to that external decision. It requires same-commit candidate and P8 references,
the exact six deployed image digests, provider/account/cluster/workload
identifiers, the pinned Rollouts controller identity, a database checkpoint,
ordered non-overlapping 5/25/100 observation windows, rollback evaluation, and
five post-promotion smoke channels. Every referenced file is relative, redacted,
unique, regular, bounded, and SHA-256/length checked.

Run the repository verifier against a collected bundle:

```powershell
node scripts/verify-production-promotion.mjs `
  --evidence promotion/evidence/promotion.json `
  --report promotion/verification-report.json
```

The report path must be outside the immutable evidence directory. The verifier
cross-binds candidate/P8/provider commit, account, deployment and image values;
checks provider-exported traffic and metrics identities; and rejects reordered,
overlapping, missing, reused, linked, or altered evidence. It always reports
`provider_authenticity_verified: false` and `production_release_eligible: false`.
That is a deliberate trust boundary, not an unfinished boolean to edit.

## Production promotion and rollback

Do not promote the candidate until all of the following external evidence is
attached to a separate immutable promotion record:

- complete P8 cloud capacity, cost, failure, backup, and recovery acceptance;
- registry digest/signature/attestation verification from the deployment plane;
- database backup checkpoint and ordered migration decision;
- provider-rendered workload identity and deployed digest inventory;
- 5%, 25%, and 100% traffic windows with SLO/error-budget observations;
- automated rollback evaluation and its action/result;
- post-promotion API, edge download, event, search, and audit smoke results.

At each canary stage, stop progression on excessive error rate, latency, event
lag, search freshness, download authorization failures, or a multi-window SLO
burn alert. Roll application traffic back to the last verified image digests.
Database rollback remains a separately approved operation following
`migrations/README.md`; never automatically reverse destructive schema changes.

The repository now implements and adversarially verifies the disabled-by-default
workload-side canary contract and the pending-external-attestation promotion
bundle contract. It does not install or prove the cloud controller,
NGINX integration, production metrics, provider authenticity check, observed
traffic windows, or automatic production rollback. Therefore the current
candidate manifest cannot satisfy the P9 exit gate.

## App Update

`ASSETLIBRARY_APP_UPDATES_ENABLED` remains false in default and release-rendered
configuration. Art/Capability Ed25519 signatures and Sigstore image identity are
not substitutes for application-update trust.

`ADR-008-app-update-tuf.md` fixes the product design. The native Rust client uses
exactly `tough` 0.24.0 and TUF 1.0 consistent snapshots. Because that library's
documented client does not support delegated roles, AssetLibrary uses six
separate Roots: Loom and Hook each have stable, beta, and nightly repositories.
No catalog or CDN response can change the configured product/channel bootstrap
Root. Root and Targets are independent offline 2-of-3 Ed25519 roles; Snapshot
and Timestamp use distinct online HSM-backed ECDSA P-256 keys. Role keys cannot
overlap.

Each repository publishes release targets named
`release.<platform>.<sequence>.<filename>` and a mandatory signed
`control.<platform>.json`. The control target supplies a monotonic policy epoch,
installation kill switch, minimum release sequence, and bounded revoked-digest
set. The client rejects non-HTTPS origins, writable-cache bootstrapping, expired
metadata, role-policy drift, non-canonical paths, wrong identity, target
downgrade, stable prerelease, digest revocation, and policy-epoch rollback. It
fully consumes hash-checked target streams and uses an atomic temporary file
before exposing staged bytes. Verified control and candidate values are opaque
read-only result types, so host code cannot forge a download authorization.

Run the local contract and cryptographic-path tests:

```powershell
./scripts/Test-AppUpdateTufPolicy.ps1
cargo test -p assetlibrary-app-update-client --locked
node scripts/validate-json-schema.mjs `
  --schema schemas/app-update-tuf-policy.schema.json `
  --document security/app-update-tuf-policy.json
```

The Rust test repository generates six ephemeral Ed25519 keys and two ephemeral
ECDSA P-256 keys, enforces the configured 2-of-3 offline and 1-of-1 online role
algorithms, signs Root/Targets/Snapshot/Timestamp and real targets, and verifies
control retrieval plus atomic download. It also proves online-role algorithm
drift, expired Timestamp, altered metadata, metadata-version rollback, incomplete
Root rotation thresholds, consistent-snapshot mixing, datastore loss followed by
policy rollback, and altered target bytes fail closed without publishing staged
bytes. Test keys never become files in source control.

This is not production admission. Before changing any App Update flag, collect
and independently verify six production root ceremonies, old-and-new threshold
sequential rotation, HSM identities, emergency key rotation, freeze/rollback/
mix-and-match tests, updater binary SBOM/provenance/signature, and Hook/Loom
single-instance activation/health-check/rollback/recovery evidence. A signed
control target cannot make missing host activation evidence optional.

## Primary implementation references

- OSV Scanner source scanning and supported lockfiles:
  <https://google.github.io/osv-scanner/usage/> and
  <https://google.github.io/osv-scanner/supported-languages-and-lockfiles/>.
- Syft CLI and source-selection controls:
  <https://oss.anchore.com/docs/reference/syft/cli/> and
  <https://oss.anchore.com/docs/guides/sbom/file-selection/>.
- GitHub artifact attestations:
  <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>.
- Sigstore/Cosign signing and verification:
  <https://docs.sigstore.dev/quickstart/quickstart-cosign/>.
- Argo Rollouts canary, analysis, Prometheus, and NGINX contracts:
  <https://argoproj.github.io/argo-rollouts/features/canary/>,
  <https://argoproj.github.io/argo-rollouts/features/analysis/>,
  <https://argoproj.github.io/argo-rollouts/analysis/prometheus/>, and
  <https://argoproj.github.io/argo-rollouts/features/traffic-management/nginx/>.
- TUF client workflow and metadata roles:
  <https://theupdateframework.github.io/specification/latest/> and
  <https://theupdateframework.io/docs/metadata/>.
- Native `tough` 0.24.0 client and its documented feature boundary:
  <https://docs.rs/tough/0.24.0/tough/>.
