// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me/releases/{release_id}/submissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit or resubmit a verified release for review */
        post: operations["submitRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/submissions/{submission_id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Withdraw a submission without deleting review history */
        post: operations["withdrawSubmission"];
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
        CreateSubmissionRequest: {
            /** Format: uuid */
            artifact_id: string;
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
        WithdrawSubmissionRequest: {
            reason: string;
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
        ReleaseId: string;
        SubmissionId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    submitRelease: {
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
                "application/json": components["schemas"]["CreateSubmissionRequest"];
            };
        };
        responses: {
            200: components["responses"]["SubmissionResponse"];
            /** @description Invalid submission. */
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
            /** @description Publisher membership does not authorize the release. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Release, artifact, policy, or idempotency state conflicts. */
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
    withdrawSubmission: {
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
                "application/json": components["schemas"]["WithdrawSubmissionRequest"];
            };
        };
        responses: {
            200: components["responses"]["SubmissionResponse"];
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Publisher membership is required. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Submission cannot be withdrawn from its current state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
