// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me/packages/{package_id}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List releases owned by an authorized package publisher */
        get: operations["listOwnedReleases"];
        put?: never;
        /** Create an immutable semantic-version release draft */
        post: operations["createReleaseDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/releases/{release_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one release owned by an authorized publisher membership */
        get: operations["getOwnedRelease"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Idempotently edit compatibility and permissions on a draft release */
        patch: operations["updateReleaseDraft"];
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        CreateReleaseRequest: {
            compatibility: components["schemas"]["PublicCompatibility"];
            permissions: string[];
            version: string;
        };
        /** @enum {string} */
        HostProduct: "loom" | "hook";
        OwnedRelease: {
            compatibility: components["schemas"]["PublicCompatibility"];
            /** Format: date-time */
            created_at: string;
            created_by: components["schemas"]["PrincipalRef"];
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            package_id: string;
            permissions: string[];
            /** Format: date-time */
            published_at: string | null;
            status: components["schemas"]["OwnedReleaseStatus"];
            /** Format: date-time */
            updated_at: string;
            version: string;
            /** Format: date-time */
            yanked_at: string | null;
        };
        OwnedReleasePage: {
            items: components["schemas"]["OwnedRelease"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        /** @enum {string} */
        OwnedReleaseStatus: "draft" | "uploading" | "submitted" | "in_review" | "approved" | "published" | "rejected" | "yanked";
        PrincipalRef: {
            issuer: string;
            subject: string;
        };
        ProductCompatibility: {
            name: components["schemas"]["HostProduct"];
            version_requirement: string;
        };
        PublicCompatibility: {
            products: components["schemas"]["ProductCompatibility"][];
        };
        UpdateReleaseRequest: {
            compatibility: components["schemas"]["PublicCompatibility"];
            /** Format: date-time */
            expected_updated_at: string;
            permissions: string[];
        };
    };
    responses: never;
    parameters: {
        IdempotencyKey: string;
        PackageId: string;
        PageCursor: string;
        PageLimit: number;
        ReleaseId: string;
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
    listOwnedReleases: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["PageCursor"];
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path: {
                package_id: components["parameters"]["PackageId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Newest-created-first release page including non-public lifecycle states. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedReleasePage"];
                };
            };
            /** @description Package identifier, cursor, or limit is invalid. */
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
    createReleaseDraft: {
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
                "application/json": components["schemas"]["CreateReleaseRequest"];
            };
        };
        responses: {
            /** @description Existing idempotent result or newly created release draft. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedRelease"];
                };
            };
            /** @description Version, compatibility, permissions, or package identifier is invalid. */
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
            /** @description Active owner, maintainer, or release-manager role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Version, package lifecycle, publisher lifecycle, or idempotency state conflicts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description App Update release creation is feature-disabled. */
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
    getOwnedRelease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                release_id: components["parameters"]["ReleaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Complete owned release metadata without artifact storage or scanner evidence. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedRelease"];
                };
            };
            /** @description Release identifier is invalid. */
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
            /** @description Release was not found. */
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
    updateReleaseDraft: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                release_id: components["parameters"]["ReleaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateReleaseRequest"];
            };
        };
        responses: {
            /** @description Existing idempotent result or newly updated draft release. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnedRelease"];
                };
            };
            /** @description Compatibility, permissions, timestamp, or release identifier is invalid. */
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
            /** @description Active owner, maintainer, or release-manager role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Release lifecycle, publisher lifecycle, optimistic concurrency, or idempotency state conflicts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description App Update release editing is feature-disabled. */
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
