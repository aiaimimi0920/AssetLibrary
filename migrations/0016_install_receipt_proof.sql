BEGIN;

ALTER TABLE install_receipts
    ALTER COLUMN installed_at DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS download_session_id uuid REFERENCES download_sessions(id),
    ADD COLUMN IF NOT EXISTS client_instance_id uuid,
    ADD COLUMN IF NOT EXISTS receipt_public_key bytea,
    ADD COLUMN IF NOT EXISTS challenge_nonce uuid,
    ADD COLUMN IF NOT EXISTS challenge_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS archive_digest bytea,
    ADD COLUMN IF NOT EXISTS host_profile_digest bytea,
    ADD COLUMN IF NOT EXISTS signature bytea,
    ADD COLUMN IF NOT EXISTS verified_at timestamptz;

ALTER TABLE install_receipts DROP CONSTRAINT IF EXISTS install_receipts_proof_shape_check;
ALTER TABLE install_receipts ADD CONSTRAINT install_receipts_proof_shape_check CHECK (
    (download_session_id IS NULL
        AND client_instance_id IS NULL
        AND receipt_public_key IS NULL
        AND challenge_nonce IS NULL
        AND challenge_expires_at IS NULL
        AND archive_digest IS NULL
        AND host_profile_digest IS NULL
        AND signature IS NULL
        AND verified_at IS NULL)
    OR
    (download_session_id IS NOT NULL
        AND client_instance_id IS NOT NULL
        AND octet_length(receipt_public_key) = 32
        AND challenge_nonce IS NOT NULL
        AND challenge_expires_at IS NOT NULL
        AND octet_length(archive_digest) = 32
        AND octet_length(host_profile_digest) = 32
        AND (signature IS NULL OR octet_length(signature) = 64)
        AND ((status = 'pending' AND installed_at IS NULL AND signature IS NULL AND verified_at IS NULL)
            OR (status = 'verified' AND installed_at IS NOT NULL AND signature IS NOT NULL AND verified_at IS NOT NULL)
            OR status IN ('revoked', 'superseded')))
) NOT VALID;

ALTER TABLE install_receipts DROP CONSTRAINT IF EXISTS install_receipts_release_artifact_fkey;
ALTER TABLE install_receipts ADD CONSTRAINT install_receipts_release_artifact_fkey
    FOREIGN KEY (release_id, artifact_id)
    REFERENCES published_release_artifacts(release_id, artifact_id) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS install_receipts_download_session_idx
    ON install_receipts (download_session_id) WHERE download_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS install_receipts_challenge_nonce_idx
    ON install_receipts (challenge_nonce) WHERE challenge_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS install_receipts_principal_created_idx
    ON install_receipts (principal_issuer, principal_subject, created_at DESC, id);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0016_install_receipt_proof')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
