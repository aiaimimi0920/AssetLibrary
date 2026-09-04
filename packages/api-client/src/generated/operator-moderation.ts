// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/internal/moderation-actions/{action_id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply a proposed action as an independent second approver */
        post: operations["approveModerationAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/moderation-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List a stable snapshot of unresolved moderation cases */
        get: operations["listOperatorModerationCases"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/moderation-cases/{case_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get sanitized report, action, and appeal facts for one moderation case */
        get: operations["getOperatorModerationCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/moderation-cases/{case_id}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Propose a moderation action requiring a second approver */
        post: operations["proposeModerationAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/moderation-cases/{case_id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve an appeal and optionally lift its blocklist facts */
        post: operations["resolveModerationCase"];
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
        ModerationActionView: {
            /** @enum {string} */
            action: "suspend" | "yank" | "revoke" | "block";
            /** Format: uuid */
            case_id: string;
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            status: "proposed" | "applied";
            target_ref: string;
            /** @enum {string} */
            target_type: "publisher" | "package" | "release" | "artifact" | "signing_key";
        };
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
        OperatorModerationActionRecord: {
            /** @enum {string} */
            action: "suspend" | "yank" | "revoke" | "block";
            applied_at: string | null;
            can_approve: boolean;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            id: string;
            reason: string;
            /** @enum {string} */
            status: "proposed" | "applied";
            target_ref: string;
            /** @enum {string} */
            target_type: "publisher" | "package" | "release" | "artifact" | "signing_key";
        };
        OperatorModerationAppeal: {
            reason: string;
            resolution: ("upheld" | "block_lifted") | null;
            resolution_reason: string | null;
            resolved_at: string | null;
        };
        OperatorModerationCaseDetail: {
            actions: components["schemas"]["OperatorModerationActionRecord"][];
            appeal: components["schemas"]["OperatorModerationAppeal"] | null;
            can_propose: boolean;
            can_resolve: boolean;
            evidence_urls: string[];
            item: components["schemas"]["OperatorModerationCaseItem"];
            report_reason: string;
            /** @constant */
            schema_version: "1.0";
        };
        OperatorModerationCaseItem: {
            action_status: ("proposed" | "applied") | null;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            id: string;
            package: components["schemas"]["OperatorReviewPackage"];
            reason_preview: string;
            release: components["schemas"]["OperatorModerationRelease"] | null;
            /** @enum {string} */
            status: "open" | "actioned" | "appealed" | "resolved";
            /** Format: date-time */
            updated_at: string;
        };
        OperatorModerationQueuePage: {
            items: components["schemas"]["OperatorModerationCaseItem"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        OperatorModerationRelease: {
            /** Format: uuid */
            id: string;
            version: string;
        };
        OperatorReviewPackage: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "art" | "capability" | "app_update";
            name: string;
            publisher: components["schemas"]["PublisherSummary"];
            slug: string;
            summary: string;
        };
        ProposeModerationActionRequest: {
            /** @enum {string} */
            action: "suspend" | "yank" | "revoke" | "block";
            reason: string;
            target_ref: string;
            /** @enum {string} */
            target_type: "publisher" | "package" | "release" | "artifact" | "signing_key";
        };
        PublisherSummary: {
            display_name: string;
            /** Format: uuid */
            id: string;
            slug: string;
        };
        ResolveModerationRequest: {
            reason: string;
            /** @enum {string} */
            resolution: "upheld" | "block_lifted";
        };
    };
    responses: {
        /** @description Proposed or applied two-person moderation action. */
        ModerationActionResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ModerationActionView"];
            };
        };
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
        ActionId: string;
        CaseId: string;
        IdempotencyKey: string;
        PageCursor: string;
        PageLimit: number;
    };
    requestBodies: never;
    headers: {
        /** @description Authenticated moderation data must not be stored by shared or private caches. */
        PrivateCacheControl: "private, no-store";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    approveModerationAction: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                action_id: components["parameters"]["ActionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ModerationActionResponse"];
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Role is absent or proposer attempted self-approval. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Target is already blocked or action is no longer applicable. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listOperatorModerationCases: {
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
            /** @description Bounded case summaries without reporter or operator principals. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorModerationQueuePage"];
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
            /** @description Active moderator or operator role is required. */
            403: {
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
    getOperatorModerationCase: {
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
            /** @description Moderation workspace without account principals, object keys, or raw scan evidence. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorModerationCaseDetail"];
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
            /** @description Active moderator or operator role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Moderation case was not found. */
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
    proposeModerationAction: {
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
                "application/json": components["schemas"]["ProposeModerationActionRequest"];
            };
        };
        responses: {
            200: components["responses"]["ModerationActionResponse"];
            /** @description Action and target do not form a valid policy operation. */
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
            /** @description Moderator or operator role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Case or target is not actionable. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    resolveModerationCase: {
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
                "application/json": components["schemas"]["ResolveModerationRequest"];
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
            /** @description Moderator or operator role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Case is not awaiting appeal resolution. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
