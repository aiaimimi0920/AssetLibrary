use assetlibrary_supply_chain::{
    ExpectedPackage, MAX_ARCHIVE_BYTES, PackageKind as SupplyKind, SignatureDocument,
    canonical_zip_digest_file, hex_digest, read_zip_entry_file, sha256_digest_file,
    validate_archive_path, validate_package_manifest, verify_signature_digest,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{PrivateKeyInfoRef, SecretDocument},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use walkdir::WalkDir;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    cli::{DigestArgs, IdentityArgs, Kind, PackArgs, ValidateArgs},
    error::CliError,
};

struct PackageIdentity<'a> {
    kind: SupplyKind,
    publisher: &'a str,
    package: &'a str,
    version: &'a str,
    permissions: &'a [String],
}

pub fn pack(args: &PackArgs) -> Result<Value, CliError> {
    validate_archive_path(&args.signature_file)
        .then_some(())
        .ok_or_else(|| CliError::Validation("unsafe signature path".to_owned()))?;
    let identity = identity(&args.identity)?;
    if !safe_key_id(&args.key_id) {
        return Err(CliError::Validation("invalid signing key id".to_owned()));
    }
    let source = canonical_directory(&args.source)?;
    let output = absolute_output(&args.output)?;
    if output.starts_with(&source) {
        return Err(CliError::Validation(
            "output archive cannot be inside its source directory".to_owned(),
        ));
    }
    reject_symlink(&args.private_key)?;
    let private_key = fs::canonicalize(&args.private_key)?;
    if private_key.starts_with(&source) {
        return Err(CliError::Validation(
            "private key cannot be inside the package source".to_owned(),
        ));
    }
    let entries = collect_entries(&source, &args.signature_file, &args.executables)?;
    let signing_key = read_signing_key(&private_key)?;
    let parent = output
        .parent()
        .ok_or(CliError::Configuration("output has no parent"))?;
    fs::create_dir_all(parent)?;

    let mut unsigned = NamedTempFile::new_in(parent)?;
    write_archive(unsigned.as_file_mut(), &entries, None)?;
    unsigned.as_file_mut().sync_all()?;
    let canonical = canonical_zip_digest_file(unsigned.path(), None)?;
    let canonical_hex = hex_digest(&canonical);
    let verifying_key = signing_key.verifying_key().to_bytes();
    let signature = signing_key.sign(canonical_hex.as_bytes());
    let document = SignatureDocumentOutput {
        schema_version: 1,
        algorithm: "ed25519",
        key_id: &args.key_id,
        digest_algorithm: "sha256",
        digest: &canonical_hex,
        signature: STANDARD.encode(signature.to_bytes()),
        public_key: STANDARD.encode(verifying_key),
    };
    let signature_bytes = serde_json::to_vec_pretty(&document)
        .map_err(|_| CliError::Validation("signature serialization failed".to_owned()))?;
    let mut signed = NamedTempFile::new_in(parent)?;
    write_archive(
        signed.as_file_mut(),
        &entries,
        Some((&args.signature_file, signature_bytes.as_slice())),
    )?;
    signed.as_file_mut().sync_all()?;
    let metadata = verify(signed.path(), &identity, &args.key_id, &verifying_key)?;
    if !args.dry_run {
        signed
            .persist_noclobber(&output)
            .map_err(|error| CliError::Io(error.error))?;
    }
    Ok(json!({
        "command":"pack","dry_run":args.dry_run,"output":if args.dry_run { None } else { Some(output) },
        "key_id":args.key_id,"public_key_base64":STANDARD.encode(verifying_key),
        "fingerprint":format!("sha256:{}", hex_digest(&Sha256::digest(verifying_key).into())),
        "artifact":metadata
    }))
}

pub fn validate(args: &ValidateArgs) -> Result<Value, CliError> {
    let identity = identity(&args.identity)?;
    if !safe_key_id(&args.key_id) {
        return Err(CliError::Validation("invalid signing key id".to_owned()));
    }
    reject_symlink(&args.archive)?;
    let key = read_public_key(&args.public_key)?;
    let metadata = verify(&args.archive, &identity, &args.key_id, &key)?;
    Ok(json!({"command":"validate","valid":true,"artifact":metadata}))
}

pub fn digest(args: &DigestArgs) -> Result<Value, CliError> {
    if !validate_archive_path(&args.signature_file) {
        return Err(CliError::Validation("unsafe signature path".to_owned()));
    }
    reject_symlink(&args.archive)?;
    let (raw, size) = sha256_digest_file(&args.archive, MAX_ARCHIVE_BYTES)?;
    let canonical = canonical_zip_digest_file(&args.archive, Some(&args.signature_file))?;
    Ok(json!({
        "command":"digest","size_bytes":size,"archive_sha256":hex_digest(&raw),
        "canonical_sha256":hex_digest(&canonical),"signature_file":args.signature_file
    }))
}

fn verify(
    archive: &Path,
    identity: &PackageIdentity<'_>,
    key_id: &str,
    trusted_key: &[u8; 32],
) -> Result<Value, CliError> {
    let expected = ExpectedPackage {
        kind: identity.kind,
        publisher: identity.publisher,
        package: identity.package,
        version: identity.version,
        permissions: identity.permissions,
    };
    let manifest = validate_package_manifest(archive, &expected)?;
    if manifest.key_id != key_id {
        return Err(CliError::Validation(
            "manifest key id differs from CLI key id".to_owned(),
        ));
    }
    let canonical = canonical_zip_digest_file(archive, Some(&manifest.signature_file))?;
    let signature: SignatureDocument = serde_json::from_slice(&read_zip_entry_file(
        archive,
        &manifest.signature_file,
        64 * 1024,
    )?)
    .map_err(|_| CliError::Validation("signature document is invalid".to_owned()))?;
    verify_signature_digest(canonical, &signature, key_id, trusted_key)?;
    let (raw, size) = sha256_digest_file(archive, MAX_ARCHIVE_BYTES)?;
    Ok(json!({
        "size_bytes":size,"archive_sha256":hex_digest(&raw),
        "canonical_sha256":hex_digest(&canonical),"manifest_file":manifest.manifest_file,
        "signature_file":manifest.signature_file
    }))
}

fn identity<'a>(args: &'a IdentityArgs) -> Result<PackageIdentity<'a>, CliError> {
    semver::Version::parse(&args.version)
        .map_err(|_| CliError::Validation("version must be SemVer".to_owned()))?;
    if !safe_id(&args.publisher) || !safe_id(&args.package) {
        return Err(CliError::Validation(
            "publisher or package identity is invalid".to_owned(),
        ));
    }
    Ok(PackageIdentity {
        kind: match args.kind {
            Kind::Art => SupplyKind::Art,
            Kind::Capability => SupplyKind::Capability,
        },
        publisher: &args.publisher,
        package: &args.package,
        version: &args.version,
        permissions: &args.permissions,
    })
}

struct Entry {
    relative: String,
    source: PathBuf,
    executable: bool,
}

fn collect_entries(
    root: &Path,
    signature_file: &str,
    executables: &[String],
) -> Result<Vec<Entry>, CliError> {
    let executable_set = executables
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if executable_set.len() != executables.len()
        || executables.iter().any(|path| !validate_archive_path(path))
    {
        return Err(CliError::Validation("invalid executable path".to_owned()));
    }
    let mut entries = Vec::new();
    let mut total = 0u64;
    for item in WalkDir::new(root).follow_links(false).into_iter() {
        let item = item.map_err(|error| CliError::Validation(error.to_string()))?;
        if item.file_type().is_symlink() {
            return Err(CliError::Validation("source contains a symlink".to_owned()));
        }
        if !item.file_type().is_file() {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if !validate_archive_path(&relative) || relative.eq_ignore_ascii_case(signature_file) {
            return Err(CliError::Validation(
                "source contains an unsafe or reserved path".to_owned(),
            ));
        }
        let size = item
            .metadata()
            .map_err(|error| CliError::Validation(error.to_string()))?
            .len();
        if size == 0 {
            return Err(CliError::Validation(
                "source contains an empty file".to_owned(),
            ));
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| CliError::Validation("source is too large".to_owned()))?;
        if total > MAX_ARCHIVE_BYTES || entries.len() >= 9_999 {
            return Err(CliError::Validation(
                "source exceeds package limits".to_owned(),
            ));
        }
        entries.push(Entry {
            executable: executable_set.contains(relative.as_str()),
            relative,
            source: item.path().to_owned(),
        });
    }
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    if entries.is_empty()
        || !executable_set
            .iter()
            .all(|path| entries.iter().any(|entry| entry.relative == *path))
    {
        return Err(CliError::Validation(
            "package is empty or an executable is missing".to_owned(),
        ));
    }
    Ok(entries)
}

fn write_archive(
    destination: &mut fs::File,
    entries: &[Entry],
    signature: Option<(&str, &[u8])>,
) -> Result<(), CliError> {
    let mut writer = ZipWriter::new(destination);
    for entry in entries {
        let mode = if entry.executable { 0o755 } else { 0o644 };
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(mode);
        writer
            .start_file(&entry.relative, options)
            .map_err(zip_error)?;
        let mut source = fs::File::open(&entry.source)?;
        std::io::copy(&mut source, &mut writer)?;
    }
    if let Some((name, bytes)) = signature {
        writer
            .start_file(
                name,
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .unix_permissions(0o644),
            )
            .map_err(zip_error)?;
        writer.write_all(bytes)?;
    }
    writer.finish().map_err(zip_error)?;
    Ok(())
}

fn read_signing_key(path: &Path) -> Result<SigningKey, CliError> {
    reject_symlink(path)?;
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(CliError::SigningKey);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(CliError::SigningKey);
        }
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        return Err(CliError::SigningKey);
    }
    let pem = std::str::from_utf8(&bytes).map_err(|_| CliError::SigningKey)?;
    let (label, document) = SecretDocument::from_pem(pem).map_err(|_| CliError::SigningKey)?;
    if label != "PRIVATE KEY" {
        return Err(CliError::SigningKey);
    }
    let info =
        PrivateKeyInfoRef::try_from(document.as_bytes()).map_err(|_| CliError::SigningKey)?;
    // ed25519 3 otherwise discards an unaligned embedded public key, bypassing
    // the keypair consistency check. Preserve the previous import rejection.
    if info.public_key.is_some_and(|key| key.unused_bits() != 0) {
        return Err(CliError::SigningKey);
    }
    SigningKey::try_from(info).map_err(|_| CliError::SigningKey)
}

fn read_public_key(path: &Path) -> Result<[u8; 32], CliError> {
    reject_symlink(path)?;
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 {
        return Err(CliError::SigningKey);
    }
    let value = fs::read_to_string(path)?.trim().to_owned();
    let bytes = STANDARD.decode(&value).map_err(|_| CliError::SigningKey)?;
    if STANDARD.encode(&bytes) != value {
        return Err(CliError::SigningKey);
    }
    bytes.try_into().map_err(|_| CliError::SigningKey)
}

fn reject_symlink(path: &Path) -> Result<(), CliError> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(CliError::Validation(
            "key path cannot be a symlink".to_owned(),
        ));
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, CliError> {
    let path = fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(CliError::Validation("source is not a directory".to_owned()));
    }
    Ok(path)
}

fn absolute_output(path: &Path) -> Result<PathBuf, CliError> {
    let file_name = path
        .file_name()
        .filter(|_| path.extension().and_then(|value| value.to_str()) == Some("zip"))
        .ok_or_else(|| CliError::Validation("output must be a .zip file".to_owned()))?;
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let parent = absolute
        .parent()
        .ok_or(CliError::Configuration("output has no parent"))?;
    fs::create_dir_all(parent)?;
    Ok(fs::canonicalize(parent)?.join(file_name))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !value.contains("..")
}

fn safe_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn zip_error(error: zip::result::ZipError) -> CliError {
    CliError::Validation(format!("ZIP construction failed: {error}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureDocumentOutput<'a> {
    schema_version: u32,
    algorithm: &'static str,
    key_id: &'a str,
    digest_algorithm: &'static str,
    digest: &'a str,
    signature: String,
    public_key: String,
}
