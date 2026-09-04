// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me/releases/{release_id}/upload-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create an object-storage multipart upload session */
        post: operations["createUploadSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/releases/{release_id}/workspace": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read bounded artifact, submission, and review feedback for an owned release */
        get: operations["getPublisherReleaseWorkspace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/upload-sessions/{session_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete a multipart upload and enqueue verification */
        post: operations["completeUploadSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/upload-sessions/{session_id}/parts/{part_number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign one direct multipart upload request */
        post: operations["presignUploadPart"];
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
        ArtifactDigest: {
            /** @constant */
            algorithm: "sha256";
            value: string;
        };
        CompleteUploadPart: {
            checksum_sha256_base64: string;
            etag: string;
            part_number: number;
        };
        CompleteUploadSessionRequest: {
            parts: components["schemas"]["CompleteUploadPart"][];
        };
        CreateUploadSessionRequest: {
            expected_digest: components["schemas"]["ArtifactDigest"];
            file_name: string;
            /** @enum {string} */
            media_type: "application/zip" | "application/x-zip-compressed" | "application/octet-stream";
            part_count: number;
            part_size_bytes: number;
            size_bytes: number;
        };
        PresignedUploadPart: {
            expires_in_seconds: number;
            headers: {
                [key: string]: string;
            };
            /** @constant */
            method: "PUT";
            part_number: number;
            /** Format: uri */
            url: string;
        };
        PresignUploadPartRequest: {
            checksum_sha256_base64: string;
            size_bytes: number;
        };
        PublisherArtifactSummary: {
            /** Format: date-time */
            created_at: string;
            expected_digest: string | null;
            file_name: string;
            /** Format: uuid */
            id: string;
            media_type: string;
            rule_version: string | null;
            scanner_version: string | null;
            size_bytes: number;
            /** @enum {string} */
            status: "pending_upload" | "uploaded" | "scanning" | "verified" | "quarantined" | "deleted";
            /** Format: date-time */
            updated_at: string;
            /** Format: date-time */
            verified_at: string | null;
            verified_digest: string | null;
        };
        PublisherReleaseWorkspace: {
            artifacts: components["schemas"]["PublisherArtifactSummary"][];
            artifacts_truncated: boolean;
            can_upload: boolean;
            feedback: components["schemas"]["PublisherReviewFeedback"][];
            feedback_truncated: boolean;
            /** Format: uuid */
            release_id: string;
            /** @constant */
            schema_version: "1.0";
            submission: components["schemas"]["PublisherSubmissionSummary"] | null;
        };
        PublisherReviewFeedback: {
            /** Format: date-time */
            decided_at: string;
            /** @enum {string} */
            decision: "approved" | "rejected" | "needs_changes";
            findings: components["schemas"]["ReviewFinding"][];
            reason: string;
            revision: number;
        };
        PublisherSubmissionSummary: {
            approval_count: number;
            /** Format: uuid */
            artifact_id: string;
            /** Format: uuid */
            id: string;
            /** @enum {integer} */
            required_approvals: 1 | 2;
            revision: number;
            /** @enum {string} */
            status: "in_review" | "changes_requested" | "approved" | "rejected" | "withdrawn";
            /** Format: date-time */
            submitted_at: string | null;
            /** Format: date-time */
            updated_at: string;
        };
        ReviewFinding: {
            code: string;
            message: string;
            /** @enum {string} */
            severity: "info" | "warning" | "error";
        };
        UploadSession: {
            /** Format: uuid */
            artifact_id: string;
            expected_digest: components["schemas"]["ArtifactDigest"];
            expires_at_epoch_seconds: number;
            /** Format: uuid */
            id: string;
            max_parts: number;
            object_key: string;
            part_size_bytes: number;
            /** Format: uuid */
            release_id: string;
            /** @enum {string} */
            status: "pending_upload" | "uploaded" | "scanning" | "verified" | "quarantined" | "deleted";
        };
    };
    responses: never;
    parameters: {
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
    createUploadSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUploadSessionRequest"];
            };
        };
        responses: {
            /** @description Existing or newly created upload session. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadSession"];
                };
            };
            /** @description Invalid upload metadata. */
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
            /** @description Idempotency key was reused with different content. */
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
    getPublisherReleaseWorkspace: {
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
            /** @description Sanitized Publisher supply-chain state without object keys or reviewer principals. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["PrivateCacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublisherReleaseWorkspace"];
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
            /** @description Persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    completeUploadSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CompleteUploadSessionRequest"];
            };
        };
        responses: {
            /** @description Uploaded artifact awaiting asynchronous verification. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadSession"];
                };
            };
            /** @description Part list is incomplete, unordered, or invalid. */
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
            /** @description Upload session does not belong to this principal. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Object store or persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    presignUploadPart: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                part_number: number;
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PresignUploadPartRequest"];
            };
        };
        responses: {
            /** @description Short-lived direct object-store PUT request. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PresignedUploadPart"];
                };
            };
            /** @description Part number, size, or checksum is invalid. */
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
            /** @description Upload session does not belong to this principal. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Upload session no longer accepts parts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Object store or persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
