mod archive;
mod manifest;
mod signature;

#[cfg(test)]
mod manifest_tests;

pub use archive::{
    ArchiveError, MAX_ARCHIVE_BYTES, canonical_zip_digest, canonical_zip_digest_file, hex_digest,
    read_zip_entry_file, sha256_digest, sha256_digest_file, validate_archive_path,
    zip_entry_exists_file,
};
pub use manifest::{
    ExpectedPackage, ManifestError, PackageKind, ValidatedManifest, validate_package_manifest,
};
pub use signature::{
    SignatureDocument, SignatureError, verify_ed25519_message, verify_signature_digest,
    verify_signature_document, verify_signature_document_file,
};
