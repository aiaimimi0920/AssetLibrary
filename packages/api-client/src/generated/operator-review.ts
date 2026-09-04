// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/internal/review-queue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List a stable snapshot of submissions awaiting manual review */
        get: operations["listReviewQueue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/submissions/{submission_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get sanitized evidence and current-revision decisions for one submission */
        get: operations["getOperatorSubmission"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/submissions/{submission_id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publish an approved immutable release
         * @description Idempotent replays are returned only after the current Operator role, release and artifact lifecycle, approval revision, signing key, and blocklist policy are revalidated. Revocation and policy changes fail closed instead of exposing a stored result.
         */
        post: operations["publishSubmission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/submissions/{submission_id}/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record a revision-bound manual review decision */
        post: operations["decideSubmissionReview"];
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
        DecideReviewRequest: {
            /** @enum {string} */
            decision: "approved" | "rejected" | "needs_changes";
            findings: components["schemas"]["ReviewFinding"][];
            reason: string;
        };
        /** @enum {string} */
        HostProduct: "loom" | "hook";
        OperatorArtifactEvidence: {
            digest: string;
            media_type: string;
            policy_version: string;
            size_bytes: number;
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
        OperatorReviewQueueItem: {
            package: components["schemas"]["OperatorReviewPackage"];
            release_version: string;
            submission: components["schemas"]["SubmissionView"];
            /** Format: date-time */
            submitted_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        OperatorReviewQueuePage: {
            items: components["schemas"]["OperatorReviewQueueItem"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
        };
        OperatorReviewRecord: {
            /** Format: date-time */
            decided_at: string;
            /** @enum {string} */
            decision: "approved" | "rejected" | "needs_changes";
            findings: components["schemas"]["ReviewFinding"][];
            /** Format: uuid */
            id: string;
            reason: string;
            revision: number;
        };
        OperatorSubmissionDetail: {
            can_review: boolean;
            compatibility: components["schemas"]["PublicCompatibility"];
            evidence: components["schemas"]["OperatorArtifactEvidence"];
            item: components["schemas"]["OperatorReviewQueueItem"];
            permissions: string[];
            reviews: components["schemas"]["OperatorReviewRecord"][];
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
        PublisherSummary: {
            display_name: string;
            /** Format: uuid */
            id: string;
            slug: string;
        };
        ReviewDecisionView: {
            /** Format: uuid */
            review_id: string;
            submission: components["schemas"]["SubmissionView"];
        };
        ReviewFinding: {
            code: string;
            message: string;
            /** @enum {string} */
            severity: "info" | "warning" | "error";
        };
        SubmissionView: {
            approval_count: number;
            /** Format: uuid */
            artifact_id: string;
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            release_id: string;
            /** @enum {integer} */
            required_approvals: 1 | 2;
            revision: number;
            rule_version: string;
            scanner_version: string;
            /** @enum {string} */
            status: "in_review" | "changes_requested" | "approved" | "rejected" | "withdrawn";
        };
    };
    responses: {
        /** @description Current submission state with revision-bound approval counts. */
        SubmissionResponse: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["SubmissionView"];
            };
        };
    };
    parameters: {
        IdempotencyKey: string;
        PageCursor: string;
        PageLimit: number;
        SubmissionId: string;
    };
    requestBodies: never;
    headers: {
        /** @description Authenticated operator data must not be stored by shared or private caches. */
        PrivateCacheControl: "private, no-store";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listReviewQueue: {
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
            /** @description Bounded review queue without raw scanner evidence or storage coordinates. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorReviewQueuePage"];
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
            /** @description Active reviewer or operator role is required. */
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
    getOperatorSubmission: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                submission_id: components["parameters"]["SubmissionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review workspace data without account principals, raw scan evidence, or object keys. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorSubmissionDetail"];
                };
            };
            /** @description Submission identifier is invalid. */
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
            /** @description Active reviewer or operator role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Submission was not found. */
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
    publishSubmission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                submission_id: components["parameters"]["SubmissionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["SubmissionResponse"];
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Operator role is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Verification, approvals, signature key, or blocklist gate failed. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description App Update publication is feature-disabled. */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    decideSubmissionReview: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                submission_id: components["parameters"]["SubmissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DecideReviewRequest"];
            };
        };
        responses: {
            /** @description Stored review decision and resulting submission state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewDecisionView"];
                };
            };
            /** @description Review evidence is malformed or exceeds bounds. */
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
            /** @description Reviewer role is absent or reviewer belongs to the publisher. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Submission revision is no longer reviewable. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
