# Public web boundary

This document records the first P6 public-web slice. It is an implementation
checkpoint, not a claim that P6 or production acceptance is complete.

## Runtime routes

| Route | Rendering | Data source | Failure behavior |
| --- | --- | --- | --- |
| `/` | dynamic server rendering | `GET /v1/public/packages` | explicit invalid or unavailable panel |
| `/search` | dynamic server rendering | `GET /v1/public/search` | prompt, empty, invalid, and unavailable are distinct |
| `/packages/[slug]` | dynamic server rendering | package detail plus `GET /v1/public/packages/{slug}/releases` | package 404 is distinct from a release projection failure |
| `/publishers/[slug]` | dynamic server rendering | publisher detail plus publisher-filtered package catalog | 404 unless the publisher owns a currently installable public package |
| `/robots.txt` | static metadata route | repository policy | private route prefixes are disallowed |
| `/sitemap.xml` | static metadata route | configured public origin | currently contains only the catalog root |

Package bytes never enter these routes. Version rows expose only bounded public
install metadata. A future download component must request the control-plane
download contract and then use the returned edge URL; it must not add a Next
route that proxies artifact bytes.

The public release projection includes release/version/time, normalized Loom or
Hook version requirements, declared permission names, and verified artifact
identity (UUID, SHA-256, size, media type, derived safe filename, signing key
ID). It deliberately excludes storage keys, quarantine paths, raw manifests,
scanner evidence and versions, key bytes, account principals, moderation
evidence, and download tickets. Malformed or over-bound persistence values fail
the projection as unavailable rather than being rendered as trusted metadata.

All current catalog fetches use `cache: no-store`. This deliberately favors
revocation freshness and multi-Pod correctness until the planned shared Next
cache handler and event invalidation are deployed. OpenSearch and Valkey remain
behind the API and are not contacted by the web application directly.

## Configuration

Server-side API resolution uses, in order:

1. `ASSETLIBRARY_API_URL`;
2. `NEXT_PUBLIC_ASSETLIBRARY_API_URL` for the existing public configuration;
3. `http://127.0.0.1:8080` for local development.

Only HTTP and HTTPS URLs are accepted. Public canonical metadata and the sitemap
use `ASSETLIBRARY_PUBLIC_URL`, with `http://localhost:3000` as the local default.
Production deployment must set both origins explicitly.

The API adapter bounds query length, cursor length, page size, and exact slug shape
before sending a request. Responses pass the versioned runtime parser before
rendering. A network error, timeout, non-success response, malformed JSON, or
schema mismatch cannot become a successful empty catalog.

## UI semantics

The implementation maps the canonical Neuro roles rather than copying example
data:

- signal yellow `#d9ff38`: keyboard focus and the single primary action;
- signal green `#22c55e`: published/success state;
- information blue `#06b6d4`: detail and navigation links;
- danger red `#f43f5e`: unavailable/error state;
- near-black shell and dense release rows, with yellow restricted to the latest
  release signal and primary actions.

Package results are dense rows rather than an equal-weight card wall. Mobile
layouts retain navigation and reflow rows without hiding business content.
Transitions only exist under `prefers-reduced-motion: no-preference`.

## Validation

`scripts/Test-WebRuntime.ps1` creates exact random PostgreSQL fixtures, starts
the real Rust API and a production Next build, and proves:

- the catalog response HTML contains a real published package and summary;
- package detail HTML contains its real package, publisher, release, permission,
  and digest projection;
- the public Publisher API/page returns the real publisher-filtered package list;
- release JSON contains no internal storage, scan, identity, manifest, or key-byte fields;
- release JSON includes only artifacts explicitly bound to the approved
  Submission; an unapproved verified sibling fails closed across detail and
  download resolution;
- dynamic catalog/detail responses are marked `no-store`, and detail emits a
  canonical link;
- the search prompt route renders;
- stopping the API produces an explicit unavailable page, not an empty result;
- child process trees and the exact database fixture are cleaned in `finally`,
  then checked for a remaining package row or bound test port.

`-VisualHoldSeconds` may keep the validated instance alive briefly for a manual
browser review; zero is the default so CI cannot hang. Subprocess logs are
always removed because they may contain operational diagnostics derived from
secret-bearing runtime configuration.

Unit tests separately cover contract rejection, API status mapping, input
bounds, URL encoding, primary SSR content, and empty/unavailable separation.

## Deliberately open P6 work

- Authenticated Publisher membership, owned package/release listing, package
  detail, idempotent draft creation APIs, external-account session adapter, and
  the first real Publisher Console slice now exist; see `docs/PUBLISHER_API.md`.
  Package release history, Release detail and optimistic draft editing, bounded
  Artifact/current-Submission state, de-identified decided review feedback, and
  verified-Artifact submission now exist. Browser multipart upload now hashes in
  bounded chunks and sends bytes directly to the quarantine object store with
  progress, cancellation, concurrency and bounded retry. A private signing-key
  workspace now lists, registers, and irreversibly revokes Ed25519 public keys
  without accepting private material. Package editing and reload-resumable upload
  recovery now exist; recovery reselects and rehashes the same file, re-authorizes
  the session, and reconciles only object-store-authoritative part metadata.
- Operator Review and Moderation now have private queue/detail read models,
  decision/downlisting actions, independent approval, and appeal resolution;
  see `docs/OPERATOR_CONSOLE.md`. Publisher-side applied-case discovery, bounded
  enforcement detail, and appeal submission are implemented in the private
  Publisher Console; see `docs/PUBLISHER_API.md`.
- Browser-authenticated routes exchange only the configured session cookie with
  the external Account Service and keep the resulting bearer server-only. A
  production OIDC/Account Service environment remains open; no login system will
  be added here. The local browser fixture is deliberately not an identity
  implementation.
- Package-level escaped JSON-LD and a runtime, bounded package sitemap now use
  only the public catalog projection. Native UUID ranges avoid mutable cursor
  gaps; overfull or unavailable shards fail rather than returning partial success.
  See `docs/PUBLIC_DISCOVERY.md` for origin, privacy, capacity and verification
  boundaries. Publisher-profile sitemap enumeration and automatic shard expansion
  remain open.
- Playwright now gates public-catalog and signing-key pages at desktop/mobile
  widths with keyboard entry, visible focus, overflow checks, Axe WCAG 2.0/2.1
  A/AA checks, privacy assertions, CI-configured Linux visual baselines, and
  separately verified Windows baselines. Reload recovery additionally verifies
  restored file-input focus, Axe, overflow, identity isolation, and missing-part
  transfer in both browser projects on Windows and the pinned Linux image. Focus
  restoration for future dialogs and full Publisher/Operator journeys remain open.
- `packages/api-client` now generates bounded domain-specific OpenAPI path types
  and typed client factories. CI rejects generated drift. These compile-time
  types complement rather than replace strict runtime response parsers.
