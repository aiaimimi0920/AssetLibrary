use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Cursor, Read, Seek};
use std::path::{Component, Path};
use zip::ZipArchive;

#[cfg(test)]
#[path = "archive_name_tests.rs"]
mod name_tests;

pub const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_EXPANDED_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const MAX_COMPRESSION_RATIO: u64 = 1_000;

pub fn validate_archive_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || Path::new(path).is_absolute() {
        return false;
    }
    let mut depth = 0usize;
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) if !value.is_empty() => depth += 1,
            Component::Normal(_) => return false,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    (1..=32).contains(&depth)
}

pub fn hex_digest(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn sha256_digest_file(
    path: &Path,
    maximum_bytes: u64,
) -> Result<([u8; 32], u64), ArchiveError> {
    let mut file = File::open(path).map_err(|_| ArchiveError::OpenArchive)?;
    if file
        .metadata()
        .map_err(|_| ArchiveError::OpenArchive)?
        .len()
        > maximum_bytes
    {
        return Err(ArchiveError::CompressedTooLarge);
    }
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ArchiveError::ReadEntry)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| ArchiveError::CompressedTooLarge)?)
            .ok_or(ArchiveError::CompressedTooLarge)?;
        if total > maximum_bytes {
            return Err(ArchiveError::CompressedTooLarge);
        }
        hasher.update(&buffer[..read]);
    }
    Ok((hasher.finalize().into(), total))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ArchiveError {
    #[error("archive exceeds compressed size limit")]
    CompressedTooLarge,
    #[error("archive contains too many entries")]
    TooManyEntries,
    #[error("archive entry has an unsafe path")]
    UnsafePath,
    #[error("archive entry is a symbolic link")]
    SymbolicLink,
    #[error("archive entry is encrypted")]
    Encrypted,
    #[error("archive entry is too large")]
    EntryTooLarge,
    #[error("archive expanded size exceeds limit")]
    ExpandedTooLarge,
    #[error("archive entry compression ratio is suspicious")]
    CompressionRatio,
    #[error("archive entry cannot be read")]
    ReadEntry,
    #[error("archive format is invalid")]
    InvalidArchive,
    #[error("archive file cannot be opened")]
    OpenArchive,
    #[error("required archive entry is missing")]
    MissingEntry,
}

struct EntryMeta {
    name: String,
    index: usize,
    size: u64,
}

pub fn canonical_zip_digest(
    bytes: &[u8],
    excluded_name: Option<&str>,
) -> Result<[u8; 32], ArchiveError> {
    let compressed_size =
        u64::try_from(bytes.len()).map_err(|_| ArchiveError::CompressedTooLarge)?;
    canonical_zip_digest_reader(Cursor::new(bytes), compressed_size, excluded_name)
}

pub fn canonical_zip_digest_file(
    path: &Path,
    excluded_name: Option<&str>,
) -> Result<[u8; 32], ArchiveError> {
    let file = File::open(path).map_err(|_| ArchiveError::OpenArchive)?;
    let compressed_size = file
        .metadata()
        .map_err(|_| ArchiveError::OpenArchive)?
        .len();
    canonical_zip_digest_reader(file, compressed_size, excluded_name)
}

fn canonical_zip_digest_reader<R: Read + Seek>(
    reader: R,
    compressed_size: u64,
    excluded_name: Option<&str>,
) -> Result<[u8; 32], ArchiveError> {
    if compressed_size > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::CompressedTooLarge);
    }
    let mut archive = ZipArchive::new(reader).map_err(|_| ArchiveError::InvalidArchive)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::TooManyEntries);
    }
    let mut seen = BTreeSet::new();
    let mut entries = Vec::with_capacity(archive.len());
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| ArchiveError::InvalidArchive)?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_owned();
        if !validate_archive_path(&name) || file.enclosed_name().is_none() {
            return Err(ArchiveError::UnsafePath);
        }
        if file.is_symlink() {
            return Err(ArchiveError::SymbolicLink);
        }
        if file.encrypted() {
            return Err(ArchiveError::Encrypted);
        }
        if file.size() == 0 || file.size() > MAX_ENTRY_BYTES {
            return Err(ArchiveError::EntryTooLarge);
        }
        let folded = name.to_ascii_lowercase();
        if !seen.insert(folded) {
            return Err(ArchiveError::UnsafePath);
        }
        let next = expanded
            .checked_add(file.size())
            .ok_or(ArchiveError::ExpandedTooLarge)?;
        if next > MAX_EXPANDED_BYTES {
            return Err(ArchiveError::ExpandedTooLarge);
        }
        let maximum_expanded = file
            .compressed_size()
            .checked_mul(MAX_COMPRESSION_RATIO)
            .ok_or(ArchiveError::CompressionRatio)?;
        if file.compressed_size() == 0 || file.size() > maximum_expanded {
            return Err(ArchiveError::CompressionRatio);
        }
        expanded = next;
        if excluded_name.is_none_or(|excluded| !name.eq_ignore_ascii_case(excluded)) {
            entries.push(EntryMeta {
                name,
                index,
                size: file.size(),
            });
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update(entry.name.as_bytes());
        hasher.update([0]);
        hasher.update(entry.size.to_le_bytes());
        hasher.update([0]);
        let mut file = archive
            .by_index(entry.index)
            .map_err(|_| ArchiveError::InvalidArchive)?;
        let mut buffer = [0u8; 64 * 1024];
        let mut remaining = entry.size;
        while remaining > 0 {
            let read = file
                .read(&mut buffer)
                .map_err(|_| ArchiveError::ReadEntry)?;
            if read == 0 || u64::try_from(read).map_err(|_| ArchiveError::ReadEntry)? > remaining {
                return Err(ArchiveError::ReadEntry);
            }
            hasher.update(&buffer[..read]);
            remaining -= u64::try_from(read).map_err(|_| ArchiveError::ReadEntry)?;
        }
    }
    Ok(hasher.finalize().into())
}

pub fn read_zip_entry_file(
    path: &Path,
    entry_name: &str,
    maximum_bytes: u64,
) -> Result<Vec<u8>, ArchiveError> {
    if maximum_bytes == 0 || !validate_archive_path(entry_name) {
        return Err(ArchiveError::UnsafePath);
    }
    let maximum_bytes = maximum_bytes.min(MAX_ENTRY_BYTES);
    let mut archive = open_entry_archive(path)?;
    let index = decoded_entry_index(&mut archive, entry_name)?.ok_or(ArchiveError::MissingEntry)?;
    let mut entry = archive
        .by_index(index)
        .map_err(|_| ArchiveError::InvalidArchive)?;
    if entry.is_dir() || entry.size() == 0 || entry.size() > maximum_bytes {
        return Err(ArchiveError::EntryTooLarge);
    }
    let capacity = usize::try_from(entry.size()).map_err(|_| ArchiveError::EntryTooLarge)?;
    let mut output = Vec::with_capacity(capacity);
    entry
        .by_ref()
        .take(maximum_bytes + 1)
        .read_to_end(&mut output)
        .map_err(|_| ArchiveError::ReadEntry)?;
    if output.len() as u64 > maximum_bytes {
        return Err(ArchiveError::EntryTooLarge);
    }
    Ok(output)
}

pub fn zip_entry_exists_file(path: &Path, entry_name: &str) -> Result<bool, ArchiveError> {
    if !validate_archive_path(entry_name) {
        return Err(ArchiveError::UnsafePath);
    }
    let mut archive = open_entry_archive(path)?;
    Ok(decoded_entry_index(&mut archive, entry_name)?.is_some())
}

fn open_entry_archive(path: &Path) -> Result<ZipArchive<File>, ArchiveError> {
    let file = File::open(path).map_err(|_| ArchiveError::OpenArchive)?;
    if file
        .metadata()
        .map_err(|_| ArchiveError::OpenArchive)?
        .len()
        > MAX_ARCHIVE_BYTES
    {
        return Err(ArchiveError::CompressedTooLarge);
    }
    let archive = ZipArchive::new(file).map_err(|_| ArchiveError::InvalidArchive)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::TooManyEntries);
    }
    Ok(archive)
}

fn decoded_entry_index<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_name: &str,
) -> Result<Option<usize>, ArchiveError> {
    // zip 8 indexes raw bytes, whereas manifests and the canonical digest use
    // decoded names. Inspect metadata without decompressing unrelated entries;
    // never select a last-wins result for a canonical-name collision.
    let mut folded_match = false;
    let mut selected = None;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| ArchiveError::InvalidArchive)?;
        if entry.is_dir() || !entry.name().eq_ignore_ascii_case(entry_name) {
            continue;
        }
        if folded_match || entry.enclosed_name().is_none() || !validate_archive_path(entry.name()) {
            return Err(ArchiveError::UnsafePath);
        }
        folded_match = true;
        if entry.is_symlink() {
            return Err(ArchiveError::SymbolicLink);
        }
        if entry.encrypted() {
            return Err(ArchiveError::Encrypted);
        }
        if entry.name() == entry_name {
            selected = Some(index);
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::{
        ArchiveError, canonical_zip_digest, hex_digest, sha256_digest, validate_archive_path,
    };
    use std::io::Write;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(&mut output);
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        output.into_inner()
    }

    use std::io::Cursor;

    #[test]
    fn digest_is_independent_of_entry_order() {
        let left = archive(&[("b.txt", b"two"), ("a.txt", b"one")]);
        let right = archive(&[("a.txt", b"one"), ("b.txt", b"two")]);
        assert_eq!(
            canonical_zip_digest(&left, None),
            canonical_zip_digest(&right, None)
        );
    }

    #[test]
    fn raw_digest_is_real_sha256_not_multipart_etag() {
        assert_eq!(
            hex_digest(&sha256_digest(b"assetlibrary")),
            "8671e233a7d3afb943109ea0094c03894bf405e06ff5d7022ad0e814d8a15a50"
        );
    }

    #[test]
    fn unsafe_and_duplicate_names_fail_closed() {
        assert!(validate_archive_path("assets/icon.png"));
        assert!(!validate_archive_path("../secrets"));
        assert!(!validate_archive_path("assets\\icon.png"));
        assert!(!validate_archive_path("/absolute/path"));
        assert!(!validate_archive_path("."));
        assert_eq!(
            canonical_zip_digest(&archive(&[("../x", b"x")]), None),
            Err(ArchiveError::UnsafePath)
        );
        assert_eq!(
            canonical_zip_digest(&archive(&[("A", b"x"), ("a", b"y")]), None),
            Err(ArchiveError::UnsafePath)
        );
    }

    #[test]
    fn excluded_signature_document_does_not_change_digest() {
        let left = archive(&[("manifest.json", b"manifest"), ("signature.json", b"one")]);
        let right = archive(&[("manifest.json", b"manifest"), ("signature.json", b"two")]);
        assert_eq!(
            canonical_zip_digest(&left, Some("signature.json")),
            canonical_zip_digest(&right, Some("signature.json"))
        );
    }
}
