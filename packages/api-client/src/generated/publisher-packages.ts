// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me/packages/{package_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a complete package owned by an authorized publisher membership */
        get: operations["getOwnedPackage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Idempotently edit mutable metadata on a draft package */
        patch: operations["updatePackageDraft"];
        trace?: never;
    };
    "/v1/me/publishers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List active publisher memberships for the current external principal */
        get: operations["listMyPublisherMemberships"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/publishers/{publisher_id}/packages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List packages owned by one authorized publisher membership */
        get: operations["listOwnedPackages"];
        put?: never;
        /** Create an idempotent package draft */
        post: operations["createPackageDraft"];
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
        CreatePackageRequest: {
            description: string;
            /** @enum {string} */
            kind: "art" | "capability" | "app_update";
            name: string;
            slug: string;
            summary: string;
            tags: string[];
            visibility: components["schemas"]["PackageVisibility"];
        };
        OwnedPackage: {
            /** Format: date-time */
            created_at: string;
            description: string;
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "art" | "capability" | "app_update";
            name: string;
            /** Format: uuid */
            publisher_id: string;
            slug: string;
            status: components["schemas"]["OwnedPackageStatus"];
            summary: string;
            tags: string[];
            /** Format: date-time */
            updated_at: string;
            visibility: components["schemas"]["PackageVisibility"];
        };
        OwnedPackagePage: {
            items: components["schemas"]["OwnedPackageSummary"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        /** @enum {string} */
        OwnedPackageStatus: "draft" | "submitted" | "published" | "suspended" | "deprecated" | "archived";
        OwnedPackageSummary: {
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "art" | "capability" | "app_update";
            name: string;
            /** Format: uuid */
            publisher_id: string;
            slug: string;
            status: components["schemas"]["OwnedPackageStatus"];
            summary: string;
            tags: string[];
            /** Format: date-time */
            updated_at: string;
            visibility: components["schemas"]["PackageVisibility"];
        };
        /** @enum {string} */
        PackageVisibility: "public" | "unlisted" | "private";
        PublisherMembership: {
            publisher: components["schemas"]["PublisherSummary"];
            publisher_status: components["schemas"]["PublisherState"];
            role: components["schemas"]["PublisherRole"];
        };
        PublisherMembershipPage: {
            items: components["schemas"]["PublisherMembership"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        /** @enum {string} */
        PublisherRole: "owner" | "maintainer" | "release_manager";
        /** @enum {string} */
        PublisherState: "pending" | "active" | "suspended" | "closed";
        PublisherSummary: {
            display_name: string;
            /** Format: uuid */
            id: string;
            slug: string;
        };
        UpdatePackageRequest: {
            description: string;
            /** Format: date-time */
            expected_updated_at: string;
            name: string;
            summary: string;
            tags: string[];
            visibility: components["schemas"]["PackageVisibility"];
        };
    };
    responses: never;
    parameters: {
        IdempotencyKey: string;
        PackageId: string;
        PageCursor: string;
        PageLimit: number;
        PublisherId: string;
    };
    requestBodies: never;
    headers: {
        /** @description Authenticated publisher data must not be stored by shared or private caches. */
        PrivateCacheControl: "private, no-store";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getOwnedPackage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                package_id: components["parameters"]["PackageId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Complete owned package metadata including its bounded description. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedPackage"];
                };
            };
            /** @description Package identifier is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Active publisher membership is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Package was not found. */
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
    updatePackageDraft: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                package_id: components["parameters"]["PackageId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePackageRequest"];
            };
        };
        responses: {
            /** @description Existing idempotent result or newly updated draft package. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedPackage"];
                };
            };
            /** @description Editable metadata, timestamp, or package identifier is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Active owner or maintainer role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Package lifecycle, publisher lifecycle, optimistic concurrency, or idempotency state conflicts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description App Update package editing is feature-disabled. */
            501: {
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
    listMyPublisherMemberships: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["PageCursor"];
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Publisher memberships scoped to the authenticated principal. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherMembershipPage"];
                };
            };
            /** @description Cursor or limit is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Account Service or persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listOwnedPackages: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["PageCursor"];
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path: {
                publisher_id: components["parameters"]["PublisherId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Newest-updated-first package page including non-public lifecycle states. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedPackagePage"];
                };
            };
            /** @description Publisher identifier, cursor, or limit is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Active publisher membership is required. */
            403: {
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
    createPackageDraft: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                publisher_id: components["parameters"]["PublisherId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreatePackageRequest"];
            };
        };
        responses: {
            /** @description Existing idempotent result or newly created package draft. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedPackage"];
                };
            };
            /** @description Package metadata or publisher identifier is invalid. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Active owner or maintainer role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Slug, publisher lifecycle, or idempotency state conflicts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description App Update package creation is feature-disabled. */
            501: {
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
}
