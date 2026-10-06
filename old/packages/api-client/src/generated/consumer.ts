// Generated from contracts/openapi/domains. Do not edit manually.
export interface paths {
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve the current external principal */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/artifacts/{artifact_id}/download-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Issue a short-lived restricted edge download ticket */
        post: operations["createDownloadSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/download-sessions/{session_id}/install-challenge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bind an install receipt challenge to an authorized download session */
        post: operations["createInstallChallenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/install-receipts/{receipt_id}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify and consume one cryptographically bound install receipt */
        post: operations["verifyInstallReceipt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/library": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the current principal's library projection */
        get: operations["listLibrary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/library/{package_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Idempotently update one library entry */
        put: operations["updateLibraryEntry"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/packages/{package_id}/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Report a package or release for moderation */
        post: operations["reportPackage"];
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
        CreateDownloadSessionRequest: {
            /** @enum {string} */
            client_type: "web" | "loom" | "hook" | "cli";
        };
        CreateInstallChallengeRequest: {
            /** Format: uuid */
            client_instance_id: string;
            host: components["schemas"]["InstallHostProfile"];
            /** Format: uuid */
            receipt_id: string;
            /** @description Ephemeral Ed25519 public key; the corresponding private key stays on the client. */
            receipt_public_key_base64: string;
        };
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
        DownloadSession: {
            /** @description Sensitive bearer ticket; never persist or log this value. */
            access_token: string;
            artifact: components["schemas"]["DownloadArtifact"];
            /** Format: uri */
            download_url: string;
            /** Format: date-time */
            expires_at: string;
            /** @constant */
            schema_version: "1.0";
            /** Format: uuid */
            session_id: string;
        };
        HostApiSupport: {
            features: string[];
            version: string;
        };
        InstallChallenge: {
            archive_sha256: string;
            artifact: components["schemas"]["DownloadArtifact"];
            /** Format: uuid */
            client_instance_id: string;
            /** Format: uuid */
            download_session_id: string;
            /** Format: date-time */
            expires_at: string;
            host_profile_sha256: string;
            /** Format: date-time */
            issued_at: string;
            /** Format: uuid */
            nonce: string;
            package: components["schemas"]["InstallPackage"];
            /** Format: uuid */
            receipt_id: string;
            /** @constant */
            schema_version: "1.0";
            trusted_signing_key: components["schemas"]["TrustedPublisherKey"];
        };
        InstalledFramework: {
            id: string;
            ready: boolean;
            version: string;
        };
        InstallHostProfile: {
            frameworks: components["schemas"]["InstalledFramework"][];
            hook_extension_api: components["schemas"]["HostApiSupport"];
            hook_version: string;
            loom_capability_api: components["schemas"]["HostApiSupport"];
            loom_version: string;
            platform: string;
            surface_api: components["schemas"]["HostApiSupport"];
            surface_nodes: string[];
        };
        InstallPackage: {
            /** @enum {string} */
            kind: "art" | "capability";
            /** Format: uuid */
            package_id: string;
            package_slug: string;
            permissions: string[];
            /** Format: uuid */
            publisher_id: string;
            publisher_slug: string;
            version: string;
        };
        InstallReceipt: {
            /** Format: uuid */
            artifact_id: string;
            digest: string;
            /** Format: date-time */
            installed_at: string;
            /** Format: uuid */
            receipt_id: string;
            /** Format: uuid */
            release_id: string;
            /** @constant */
            schema_version: "1.0";
            /** @constant */
            status: "verified";
            /** Format: date-time */
            verified_at: string;
        };
        LibraryEntry: {
            favorite: boolean;
            /** Format: uuid */
            installed_artifact_id: string | null;
            /** Format: uuid */
            installed_release_id: string | null;
            package: components["schemas"]["Package"];
            /** @enum {string} */
            status: "listed" | "hidden" | "removed";
            /** Format: date-time */
            updated_at: string;
        };
        LibraryPage: {
            items: components["schemas"]["LibraryEntry"][];
            next_cursor: string | null;
            /** @constant */
            schema_version: "1.0";
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
        PrincipalRef: {
            issuer: string;
            subject: string;
        };
        PublisherSummary: {
            display_name: string;
            /** Format: uuid */
            id: string;
            slug: string;
        };
        ReportPackageRequest: {
            evidence_urls: string[];
            reason: string;
            /** Format: uuid */
            release_id: string | null;
        };
        TrustedPublisherKey: {
            /** @constant */
            algorithm: "ed25519";
            fingerprint: string;
            key_id: string;
            public_key_base64: string;
        };
        UpdateLibraryEntryRequest: {
            favorite: boolean;
            /** Format: uuid */
            installed_artifact_id: string | null;
            /** Format: uuid */
            installed_release_id: string | null;
            /** @enum {string} */
            status: "listed" | "hidden" | "removed";
        };
        VerifyInstallReceiptRequest: {
            /** Format: int64 */
            installed_at_epoch_seconds: number;
            signature_base64: string;
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
        IdempotencyKey: string;
        PackageId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Opaque external principal reference. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PrincipalRef"];
                };
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Account Service unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createDownloadSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                artifact_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateDownloadSessionRequest"];
            };
        };
        responses: {
            /** @description Ticket returned separately from its URL; send it in Authorization at the edge. */
            201: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DownloadSession"];
                };
            };
            /** @description Credential missing or invalid. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Artifact unavailable or principal lacks private-package access. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Idempotency conflict or existing session no longer replayable. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Persistence or ticket signer unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createInstallChallenge: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateInstallChallengeRequest"];
            };
        };
        responses: {
            /** @description One-time challenge, exact artifact identity, and currently trusted publisher key. */
            201: {
                headers: {
                    "Cache-Control"?: "private, no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstallChallenge"];
                };
            };
            /** @description Invalid client key or host profile. */
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
            /** @description Download session unavailable to this principal. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Host is incompatible, session is invalid, or idempotency conflicts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Account or persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    verifyInstallReceipt: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                receipt_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VerifyInstallReceiptRequest"];
            };
        };
        responses: {
            /** @description Verified receipt and atomically updated principal library projection. */
            200: {
                headers: {
                    "Cache-Control"?: "private, no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstallReceipt"];
                };
            };
            /** @description Invalid signature encoding or timestamp. */
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
            /** @description Receipt signature verification failed. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Receipt or currently installable artifact unavailable to this principal. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Challenge expired, receipt replayed, or idempotency conflicts. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Account or persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listLibrary: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Principal-scoped favorites and installed package projection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryPage"];
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
            /** @description Persistence dependency unavailable. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateLibraryEntry: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                package_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateLibraryEntryRequest"];
            };
        };
        responses: {
            /** @description Updated library projection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryEntry"];
                };
            };
            /** @description Install projection does not contain a valid release/artifact pair. */
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
            /** @description Package is unavailable to this principal. */
            404: {
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
    reportPackage: {
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
                "application/json": components["schemas"]["ReportPackageRequest"];
            };
        };
        responses: {
            200: components["responses"]["ModerationCaseResponse"];
            /** @description Report is malformed or exceeds bounds. */
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
            /** @description Package or release was not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
