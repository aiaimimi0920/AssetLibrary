// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me/moderation-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List applied moderation cases visible to the affected publisher */
        get: operations["listMyPublisherModerationCases"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/moderation-cases/{case_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an applied moderation case and appeal state as its publisher */
        get: operations["getMyPublisherModerationCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/moderation-cases/{case_id}/appeal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Appeal an applied moderation case as its publisher */
        post: operations["appealModerationCase"];
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
        ModerationCaseView: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            package_id: string;
            /** Format: uuid */
            release_id: string | null;
            /** @enum {string} */
            status: "open" | "actioned" | "appealed" | "resolved";
        };
        PublisherModerationAction: {
            /** @enum {string} */
            action: "suspend" | "yank" | "revoke" | "block";
            /** Format: date-time */
            applied_at: string;
            /** Format: uuid */
            id: string;
            reason_preview: string;
            /** @constant */
            status: "applied";
            target_ref: string;
            /** @enum {string} */
            target_type: "publisher" | "package" | "release" | "artifact" | "signing_key";
        };
        PublisherModerationAppeal: {
            reason: string;
            resolution: ("upheld" | "block_lifted") | null;
            resolution_reason: string | null;
            resolved_at: string | null;
        };
        PublisherModerationCaseDetail: {
            action_reason: string;
            appeal: components["schemas"]["PublisherModerationAppeal"] | null;
            can_appeal: boolean;
            item: components["schemas"]["PublisherModerationCaseItem"];
            /** @constant */
            schema_version: "1.0";
        };
        PublisherModerationCaseItem: {
            action: components["schemas"]["PublisherModerationAction"];
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            id: string;
            package: components["schemas"]["PublisherModerationPackage"];
            release: components["schemas"]["PublisherModerationRelease"] | null;
            /** @enum {string} */
            status: "actioned" | "appealed" | "resolved";
            /** Format: date-time */
            updated_at: string;
        };
        PublisherModerationCasePage: {
            items: components["schemas"]["PublisherModerationCaseItem"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        PublisherModerationPackage: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "art" | "capability" | "app_update";
            name: string;
            /** Format: uuid */
            publisher_id: string;
            slug: string;
        };
        PublisherModerationRelease: {
            /** Format: uuid */
            id: string;
            version: string;
        };
        ReasonRequest: {
            reason: string;
        };
    };
    responses: {
        /** @description Current moderation case state. */
        ModerationCaseResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ModerationCaseView"];
            };
        };
    };
    parameters: {
        CaseId: string;
        IdempotencyKey: string;
        PageCursor: string;
        PageLimit: number;
    };
    requestBodies: never;
    headers: {
        /** @description Publisher moderation data must not be stored by shared or private caches. */
        PrivateCacheControl: "private, no-store";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listMyPublisherModerationCases: {
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
            /** @description Stable page of enforcement summaries scoped to active publisher memberships. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherModerationCasePage"];
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
    getMyPublisherModerationCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                case_id: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Enforcement and appeal facts without report evidence, principals, or internal storage data. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherModerationCaseDetail"];
                };
            };
            /** @description Case identifier is invalid. */
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
            /** @description Case is absent, not yet enforced, or outside active publisher memberships. */
            404: {
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
    appealModerationCase: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                case_id: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["ModerationCaseResponse"];
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
            /** @description Case has no applied action to appeal. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
