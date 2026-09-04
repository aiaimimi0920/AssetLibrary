// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me/publishers/{publisher_id}/signing-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List signing keys for an authorized publisher membership */
        get: operations["listPublisherSigningKeys"];
        put?: never;
        /** Register immutable Ed25519 public key material */
        post: operations["registerPublisherSigningKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/publishers/{publisher_id}/signing-keys/{key_id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Irreversibly revoke a publisher signing key */
        post: operations["revokePublisherSigningKey"];
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
        PublisherSigningKey: {
            algorithm: components["schemas"]["SigningKeyAlgorithm"];
            /** Format: date-time */
            created_at: string;
            fingerprint: string;
            key_id: string;
            /** Format: byte */
            public_key_base64: string;
            /** Format: uuid */
            publisher_id: string;
            /** Format: date-time */
            revoked_at: string | null;
            status: components["schemas"]["SigningKeyStatus"];
        };
        PublisherSigningKeyPage: {
            items: components["schemas"]["PublisherSigningKey"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        RegisterSigningKeyRequest: {
            algorithm: components["schemas"]["SigningKeyAlgorithm"];
            key_id: string;
            /** Format: byte */
            public_key_base64: string;
        };
        RevokeSigningKeyRequest: {
            reason: string;
        };
        /** @constant */
        SigningKeyAlgorithm: "ed25519";
        /** @enum {string} */
        SigningKeyStatus: "active" | "revoked";
    };
    responses: never;
    parameters: {
        IdempotencyKey: string;
        PageCursor: string;
        PageLimit: number;
        PublisherId: string;
        SigningKeyId: string;
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
    listPublisherSigningKeys: {
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
            /** @description Signing-key public material and lifecycle state; private key material never enters AssetLibrary. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherSigningKeyPage"];
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
    registerPublisherSigningKey: {
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
                "application/json": components["schemas"]["RegisterSigningKeyRequest"];
            };
        };
        responses: {
            /** @description Existing idempotent result or newly registered public key. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherSigningKey"];
                };
            };
            /** @description Key identifier, algorithm, or canonical public key is invalid. */
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
            /** @description Active publisher owner or maintainer role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Publisher lifecycle, key identity, public-key reuse, or idempotency state conflicts. */
            409: {
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
    revokePublisherSigningKey: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                key_id: components["parameters"]["SigningKeyId"];
                publisher_id: components["parameters"]["PublisherId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RevokeSigningKeyRequest"];
            };
        };
        responses: {
            /** @description Existing idempotent result or terminal revoked key state. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherSigningKey"];
                };
            };
            /** @description Publisher identifier, key identifier, or reason is invalid. */
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
            /** @description Active publisher owner or maintainer role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Signing key was not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Publisher lifecycle or idempotency state conflicts. */
            409: {
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
