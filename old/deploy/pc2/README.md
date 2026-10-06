# PC2 download deployment

PC2 runs the AssetLibrary API, Next.js web, PostgreSQL, Valkey, JetStream,
OpenSearch, and workers. The download overlay uses the existing S3 and
Cloudflare adapters with dedicated PC2 trial resources:

- `assetlibrary-pc2-quarantine`: private R2 upload objects;
- `assetlibrary-pc2-published`: private, Worker-bound immutable R2 objects;
- `assetlibrary-pc2-policy`: the PC2 indexer's KV authorization projection;
- `assetlibrary-pc2-download-events`: asynchronous Worker download events;
- `neuro-assetlibrary-edge-pc2`: the unchanged `services/edge` implementation.

These resources are separate from the earlier staging deployment. The Account
Service is still external; PC2 uses explicit development identities. App Update
remains disabled. This is local/hybrid functional validation, not production
acceptance.

## Preserved inputs

The existing deployment is `/volume3/hixel/homes/mjc/assetlibrary-local-pc2` only
when that exact path is confirmed on the target. The established PC2 deployment
path is `/volume3/homes/mjc/assetlibrary-local-pc2`.
Its `pc2.dependencies.compose.yaml`, `pc2.compose.yaml`, and `.env` remain the
base inputs. Keep the original MinIO objects and volumes. Never regenerate
`.env`, run a project-wide `down`, or operate on another project's containers.

Before switching storage, stop new uploads, verify there are no active multipart
sessions or scans, and copy existing quarantine and published objects into the
dedicated R2 buckets. Preserve exact keys and compare lengths and full raw
SHA-256 hashes. Refuse an existing destination with different bytes. A canonical
ZIP digest names a published object; it is not the raw archive hash.

## Private configuration

Store the cloud configuration in a separate `cloud-downloads.env` on PC2, mode
`0600`, outside source control and release bundles. Required variables are:

- `ASSETLIBRARY_R2_ACCESS_KEY_ID`, `ASSETLIBRARY_R2_SECRET_ACCESS_KEY`, and
  `ASSETLIBRARY_R2_ENDPOINT`;
- `ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID`,
  `ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID`, and
  `ASSETLIBRARY_EDGE_POLICY_API_TOKEN`;
- `ASSETLIBRARY_DOWNLOAD_ORIGIN` and
  `ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64`;
- `ASSETLIBRARY_PC2_RUST_IMAGE`, bound to the validated image digest.

The API and Worker must share a random unpadded base64url ticket secret of at
least 32 bytes, issuer `assetlibrary-pc2`, and audience `assetlibrary-pc2-edge`.
The indexer receives the KV writer token and never the ticket secret. R2 CORS
must allow the exact PC2 web origin; the Next upload-origin allowlist contains
the R2 endpoint. Neither bucket enables public `r2.dev` access.

R2 upload CORS must also allow `x-amz-content-sha256`. R2 rejects the
Multipart Upload `x-amz-checksum-sha256` header with HTTP 501. The S3 adapter
therefore binds the SHA-256 payload header into the presigned request for HTTPS
R2 endpoints. Corrupted bytes must return `XAmzContentSHA256Mismatch`; never
remove integrity checks to make an upload succeed. Other S3 providers retain
their standard checksum headers. R2 does not return per-part SHA-256 in
`ListParts`, so recovery reuses the session but retransmits unverifiable parts.
The scanner still verifies the full raw digest and canonical package signature.

`wrangler.toml` contains only PC2 resource identifiers. Set `TICKET_SECRET`
separately through the provider's secret interface. Never share staging KV
namespaces or bucket bindings with PC2.

## Copy-only migration utility

`copy_objects.py` uses Python, boto3, and process-scoped `SOURCE_ENDPOINT`,
`SOURCE_ACCESS_KEY_ID`, `SOURCE_SECRET_ACCESS_KEY`, `TARGET_ENDPOINT`,
`TARGET_ACCESS_KEY_ID`, and `TARGET_SECRET_ACCESS_KEY`. The source must be a
loopback SSH relay to PC2 MinIO and the target must be HTTPS R2. The NAS can
disable SFTP and SSH forwarding; an SSH execution-channel TCP relay is sufficient
without changing its server settings.

The default invocation checks source bytes and existing destination bytes;
`--copy` additionally creates absent objects with a signed `If-None-Match: *`
condition. It checks full SHA-256 after each copy, never deletes source data,
refuses mismatches and active multipart uploads, and bounds work to 1,000 objects
of at most 1 GiB each. Quiesce API/scanner writers and retain a database checkpoint
before running it. Restart the original services on any failed migration gate.

Run `python -m unittest discover -s deploy/pc2 -p test_copy_objects.py` for its
no-overwrite, idempotency, and actual signed-request regression checks.

## Apply and verify

Copy `pc2.cloud-downloads.compose.yaml` beside the existing compose files, load
the cloud environment without displaying it, and validate the merged inputs:

```sh
cd /volume3/homes/mjc/assetlibrary-local-pc2
set -a
. ./cloud-downloads.env
set +a
/usr/local/bin/docker-compose --env-file ./.env -p assetlibrary-pc2 \
  -f pc2.dependencies.compose.yaml -f pc2.compose.yaml \
  -f pc2.cloud-downloads.compose.yaml config --quiet
```

Use the same arguments with `up -d --no-build --no-deps` and only the affected
service names. Preserve the previous image under a distinct rollback tag before
recreation. Run cleanup once with `run --rm --no-deps cleanup`, not as a daemon.

The first catalog event after enabling KV projection must reload authoritative
publication facts and write the public allowlist. Search rebuild does not
reconcile Edge KV. For an existing published test package, use a new audited
catalog invalidation event; never invent an allowlist based solely on an object
being present in R2.

Acceptance must verify upload/scan/publication after the switch, public metadata,
full and Range byte reads, HEAD, ETag/304, invalid-range 416, missing-policy 404,
restricted-ticket rejection, and the real Loom client's raw/canonical digest,
publisher signature, and host-profile checks. Record failed and unavailable
checks explicitly. Download verification alone does not activate a Loom host or
prove an installation receipt.

`cargo run --release --locked -p assetlibrary-loom-client --example verify_download`
exercises the real Loom verifier against `ASSETLIBRARY_API_URL`,
`ASSETLIBRARY_DOWNLOAD_ORIGIN`, `ASSETLIBRARY_ARTIFACT_ID`, an in-memory
`ASSETLIBRARY_TOKEN`, and JSON `ASSETLIBRARY_HOST_PROFILE`. Set
`ASSETLIBRARY_ALLOW_HTTP=true` only for this private PC2 development API.
It uses a fresh temporary cache, cleans it on exit, and never activates a host
or submits an installation receipt.

## Rollback

Before new writes, the retained MinIO copy and original configuration provide
the rollback point: omit the cloud overlay, restore the known-good service image,
and recreate only the affected services. The original PC2 API port must remain
`28080`; older bundled compose inputs incorrectly used the occupied `18080` port.

After R2 accepts new writes, first quiesce uploads/scans, resolve active multipart
sessions, and copy new objects back with the same no-overwrite/hash checks. Only
then switch the readers and writers together. Do not delete cloud objects, KV
state, queues, old MinIO volumes, or previous images as an implicit rollback.
