// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Report process liveness */
        get: operations["health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Report dependency readiness */
        get: operations["readiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/artifacts/{artifact_id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve an immutable public Art download */
        get: operations["getPublicDownload"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/packages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List published packages */
        get: operations["listPackages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/packages/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a published package by slug */
        get: operations["getPackage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/packages/{slug}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List installable published releases for a public package */
        get: operations["listPackageReleases"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/publishers/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a publisher represented in the installable public catalog */
        get: operations["getPublisher"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search the rebuildable public package projection */
        get: operations["searchPackages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/sitemap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List occupied public sitemap shards
         * @description Accepts no query parameters. Computes at most 256 native UUID interval existence probes under the public catalog eligibility gate. Responses use Cache-Control no-store; reads are current, not a multi-request snapshot.
         */
        get: operations["getSitemapManifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/public/sitemap/{shard}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a complete bounded public sitemap shard
         * @description Accepts no query parameters. The lowercase two-digit shard selects an immutable UUID first-byte interval. Each request applies current public catalog eligibility. At most 5000 unique slugs are returned; an overfull interval fails with 503 and never returns a truncated successful response. All responses use Cache-Control no-store.
         */
        get: operations["getSitemapShard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        DownloadArtifact: {
            /** Format: uuid */
            artifact_id: string;
            digest: string;
            file_name: string;
            media_type: string;
            /** Format: uuid */
            release_id: string;
            /** Format: int64 */
            size_bytes: number;
        };
        Health: {
            /** @enum {string} */
            status: "ok" | "not_ready";
        };
        /** @enum {string} */
        HostProduct: "loom" | "hook";
        Package: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "art" | "capability" | "app_update";
            name: string;
            publisher: components["schemas"]["PublisherSummary"];
            slug: string;
            /** @enum {string} */
            status: "published" | "suspended" | "archived";
            summary?: string;
        };
        PackagePage: {
            items: components["schemas"]["Package"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        ProductCompatibility: {
            name: components["schemas"]["HostProduct"];
            version_requirement: string;
        };
        PublicCompatibility: {
            products: components["schemas"]["ProductCompatibility"][];
        };
        PublicDownload: {
            artifact: components["schemas"]["DownloadArtifact"];
            /** Format: uri */
            download_url: string;
            /** @constant */
            schema_version: "1.0";
        };
        PublishedRelease: {
            artifacts: components["schemas"]["PublishedReleaseArtifact"][];
            compatibility: components["schemas"]["PublicCompatibility"];
            /** Format: uuid */
            id: string;
            permissions: string[];
            /** Format: date-time */
            published_at: string;
            version: string;
        };
        PublishedReleaseArtifact: {
            /** Format: uuid */
            artifact_id: string;
            digest: string;
            file_name: string;
            media_type: string;
            /** Format: uuid */
            release_id: string;
            signing_key_id: string;
            /** Format: int64 */
            size_bytes: number;
        };
        PublishedReleasePage: {
            items: components["schemas"]["PublishedRelease"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        PublisherProfile: {
            publisher: components["schemas"]["PublisherSummary"];
            /** @constant */
            schema_version: "1.0";
        };
        PublisherSummary: {
            display_name: string;
            /** Format: uuid */
            id: string;
            slug: string;
        };
        SitemapManifest: {
            /** @constant */
            schema_version: "1.0";
            /** @description Ascending occupied UUID first-byte intervals, recomputed from current public eligibility. */
            shards: string[];
        };
        SitemapShard: {
            /** @constant */
            schema_version: "1.0";
            shard: string;
            /** @description Complete current public package slugs in this fixed UUID interval, ordered by UUID. */
            slugs: string[];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Client request error. */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Process is alive. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
        };
    };
    readiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Client request error. */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Required dependencies are usable. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
            /** @description Dependency readiness failed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getPublicDownload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifact_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Public edge URL for a verified, non-blocked Art artifact. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicDownload"];
                };
            };
            /** @description Artifact is unavailable or is not public Art. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listPackages: {
        parameters: {
            query?: {
                cursor?: string;
                kind?: "art" | "capability" | "app_update";
                limit?: number;
                publisher?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Client request error. */
            "4XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Published package summaries. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PackagePage"];
                };
            };
        };
    };
    getPackage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Published package detail. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Package"];
                };
            };
            /** @description Package not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listPackageReleases: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Newest-first release page containing only verified artifact projections. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublishedReleasePage"];
                };
            };
            /** @description Slug, cursor, or limit is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Public package was not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Persistence or release projection is unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getPublisher: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Public publisher identity. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherProfile"];
                };
            };
            /** @description Publisher slug is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Publisher has no currently installable public package. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Catalog persistence is unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    searchPackages: {
        parameters: {
            query?: {
                cursor?: string;
                kind?: "art" | "capability" | "app_update";
                limit?: number;
                q?: string;
                tag?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Public package matches from the OpenSearch projection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PackagePage"];
                };
            };
            /** @description Search input or cursor is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Search projection is unavailable or invalid. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getSitemapManifest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ordered occupied shards. An empty array is a true empty catalog. */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SitemapManifest"];
                };
            };
            /** @description Query parameters are not accepted. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Catalog query timed out or its projection is unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getSitemapShard: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                shard: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Complete eligible slug list. Empty valid intervals return an empty list. */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SitemapShard"];
                };
            };
            /** @description Invalid shard or query parameters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Overfull interval, invalid projection, timeout, or unavailable catalog. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
