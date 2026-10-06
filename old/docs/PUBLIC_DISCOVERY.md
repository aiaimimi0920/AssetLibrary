# Public catalog discovery

This slice adds package-level structured data and a bounded sitemap for the
homepage and currently public, published packages. It does not submit URLs to
external services or establish production deployment readiness.

## Canonical origin and privacy

Set `ASSETLIBRARY_PUBLIC_URL` to the canonical HTTP(S) origin. Credentials,
non-root paths, query strings, fragments, whitespace, and control characters
are rejected. Request Host/forwarded headers never determine URLs. Missing or
invalid configuration omits JSON-LD and sitemap advertisement, marks pages
noindex at the root, and returns 503 for sitemaps. Tests/development must
configure their loopback origin explicitly; localhost is not advertised by default.

Package JSON-LD is a `CreativeWork` with only name, summary, slug, canonical URL,
and public publisher name/link. It invents no prices, ratings, download URL, or
latest version. Historical release cursor pages retain the same package identity.
Non-published or malformed responses produce no structured data. HTML-sensitive
`<` and line separators are escaped; unknown backend fields are not serialized.

Robots blocks the exact private `/publisher` and `/operator` roots, query URLs and their
children without blocking `/publishers/`. This supplements authorization, not
replaces it. Search filters, private consoles, release cursors and publisher
profiles are not added to this package sitemap; public publisher pages remain
discoverable through catalog links.

## Complete bounded partitions

Ordinary catalog cursors order by mutable `updated_at`; using them for sitemap
boundaries could miss packages moved by edits. The new projection divides the
native UUID domain into 256 fixed, disjoint first-byte intervals instead.

- `GET /v1/public/sitemap` returns schema version 1.0 and occupied shard IDs.
  One SQL statement performs at most 256 native UUID existence probes. It does
  not transfer/count the catalog or cast `p.id` to text for partition lookup.
- `GET /v1/public/sitemap/{shard}` returns schema version, matching shard and
  unique slugs. It queries at most 5001 rows; over 5000 is a 503, never truncation.
- Both reuse the literal catalog eligibility predicate: public visibility,
  published package/release, active publisher/key, the approved verified artifact,
  and existing blocklist checks. No separate indexing authorization is introduced.
- Database/request deadlines and strict schema checks bound the reads. Query
  parameters, invalid shard IDs, broken projections and unavailable dependencies
  fail explicitly. Existing public catalog pagination is unchanged.

The Web serves `/sitemap.xml` as a sitemap index referencing the root-level
`/sitemap.xml?shard=home` and occupied `?shard=00` through `?shard=ff`
leaves. Only one validated shard parameter is accepted; arbitrary cursors, extra
parameters and duplicate parameters are rejected. Root placement keeps package URLs within the protocol's path scope.
The homepage leaf exists even for a true empty catalog. Empty/removed package
leaves return 404; dependency failures return 503 with Retry-After. No partial or
old successful XML is returned on failure.

Sitemap/API responses are generated at request time with no-store. Robots is
also dynamic, with Next's max-age=0, must-revalidate response policy. Each
Web index/leaf request makes one upstream read: 4-second timeout, 1 MiB streamed
JSON limit, strict duplicate/schema checks, no cookies/bearer/redirects. XML uses
UTF-8 escaping and the 50,000-entry, 50 MiB and 2048-character URL protocol
limits. No fabricated lastmod timestamp is emitted.

These are current reads, not a cross-request snapshot. New publications appear
on the next index read; removals are rechecked on leaf access. Crawlers can keep
their own older copies. A skewed UUID distribution can fill one 5000-package
interval early, especially with time-based UUID prefixes. An overfull leaf needs
a separately reviewed finer partition design. Do not silently truncate, reshuffle
boundaries, or claim arbitrary catalog scalability.

## Validation boundary

Tests cover origin/schema rejection, JSON-LD script-breakout strings, private-field
omission, robots boundaries, response-size limits, empty/removed shards, failures,
and runtime XML/canonical metadata in desktop/mobile browsers. A fixed test-only
robots-parser 3.0.1 matches actual HTTP robots output against private roots,
children/query URLs and public publisher/package URLs. It has no transitive or
production dependency; this addition changes only the Web development lock.
Existing visual
and accessibility assertions remain intact.

The explicit Rust `sitemap_postgres_gate` uses only a disposable localhost
database named `assetlibrary_sitemap_test`, never DATABASE_URL. CI provisions a
digest-pinned PostgreSQL 18.6 service on loopback. TEMP projection tables exercise
the production queries, all UUID boundaries, private filler rows, publishability
and revocation, 5000/5001 limits, statement timeouts and native UUID index plans
with EXPLAIN ANALYZE/BUFFERS. This is synthetic query validation, not migration
coverage or production-scale evidence. The ordinary Rust suite labels this test
ignored; CI explicitly invokes it and fails if its database/assertions fail.
Skipped local integration work is not a passing gate.

Next's existing streamed not-found pages can have HTTP 200 after streaming starts;
removed package pages must still render the not-found state, noindex metadata,
and no JSON-LD. Sitemap leaves have explicit HTTP 404/503 statuses independently.

These tests use no real Account Service, PC2, R2, credentials or deployment.
Publisher-profile sitemap enumeration, automatic shard expansion, Node image
alignment and the remaining P6/P8/P9 acceptance work stay separate.
