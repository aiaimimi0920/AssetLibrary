# Public Art browser download

The public package page offers `准备下载` for each published Art artifact,
including historical releases. Capability and App Update pages do not receive
this anonymous download control. Their authorization and client verification
policies are unchanged.

## Request and data boundary

The button makes a same-origin, credential-omitting POST to `/downloads/prepare`.
The web server requires an exact configured public Origin, a bounded JSON body
and six artifact fields: artifact ID, release ID, digest, size, media type and
safe filename. It reads the existing public Art download API at click time,
without forwarding cookies or authorization headers, following redirects or
caching the result. The complete request has a five-second deadline; input and
upstream JSON are limited to 2 KiB and 8 KiB respectively.

The API remains the authority for publication, verified artifact binding,
active signing key, public Art eligibility and revocation. Its returned identity
must exactly match the displayed selection. Only the configured download origin
and exact `/public/sha256/<digest>/<filename>` path are accepted. Query strings,
fragments, alternate encodings, private paths and token-bearing URLs fail closed.
Errors return fixed reason codes, never backend bodies or credentials.

After successful preparation, the user selects `下载文件`. The browser retrieves
bytes directly from the download service; neither Next nor the API proxies the
archive. The link omits the referrer. A browser-controlled download cannot promise
completion, signature validity or installation, and the UI makes no such claim.
The digest identifies the canonical package; it must not be presented as a
generic raw ZIP checksum. Loom or another compatible verifier must still check
the package digest, manifest, signature and compatibility before installation.

## Configuration

The web process needs `ASSETLIBRARY_PUBLIC_URL`, `ASSETLIBRARY_API_URL` and
`ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL`. The last value must be the same origin
used by the API's public download configuration. It accepts HTTPS, or explicitly
configured localhost/loopback HTTP for development. Missing configuration leaves
the page readable and download preparation unavailable. No production default
or incoming Host header selects a download destination.

The Helm web workload and existing PC2 cloud-download overlay pass the existing
public download origin through without secrets. This change does not start a
server, publish images, configure an account or deploy the overlay.

Use a dedicated, cookie-free download hostname and host-only account cookies.
The metadata request explicitly omits credentials, but a normal browser download
link cannot override cookies already scoped to its destination. `noreferrer`
does not suppress destination cookies. The browser regression uses different
loopback hostnames and verifies that its host-only account cookie is not sent.

## Cancellation, freshness and evidence

Only one preparation request per control can be active. Cancellation and route
unmount abort it; late responses cannot restore a link. A new preparation removes
the previous link until fresh metadata succeeds. Failed or revoked selections
remain retryable without being described as an empty catalog or a successful
download.

The existing Edge checks current public policy and revocation before consulting
its cache; a regression covers revocation while bytes are already cached there.
This is the decision for requests reaching Edge, not a guarantee of instantaneous
policy propagation or recovery of bytes already downloaded/browser-cached.

Tests cover exact identity and URL rejection, bounded bodies, cancellation,
credential isolation, real synthetic file download, keyboard entry, mobile and
desktop accessibility, repeated clicks, cancellation/navigation, and recovery
after errors. The synthetic HTTP fixture is not a real R2, account, archive
signature or local-user acceptance test. Existing API, Edge and full CI gates
remain required.
