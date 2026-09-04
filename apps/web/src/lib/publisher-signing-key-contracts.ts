export type SigningKeyAlgorithm = "ed25519";
export type SigningKeyStatus = "active" | "revoked";

export interface RegisterSigningKeyRequest {
  key_id: string;
  algorithm: SigningKeyAlgorithm;
  public_key_base64: string;
}

export interface PublisherSigningKey {
  publisher_id: string;
  key_id: string;
  algorithm: SigningKeyAlgorithm;
  public_key_base64: string;
  fingerprint: string;
  status: SigningKeyStatus;
  created_at: string;
  revoked_at: string | null;
}

export interface PublisherSigningKeyPage {
  schema_version: "1.0";
  items: PublisherSigningKey[];
  next_cursor: string | null;
}
