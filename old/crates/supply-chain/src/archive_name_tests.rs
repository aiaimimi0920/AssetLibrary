use super::{
    ArchiveError, canonical_zip_digest, hex_digest, read_zip_entry_file, zip_entry_exists_file,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};

// Frozen stored bytes, CRC32("x"), flags and name encodings, independent of
// ZipWriter's version. The canonical digest was captured with zip 2.4.2.
const LEGACY_DIGEST: &str = "6a9b8f4df13030c3e306f808de9bd232ac21f7c02656a0a97acb73dbdc25d206";
const CP437: &[u8] = b"\x82.txt";
const UTF8: &[u8] = b"\xc3\xa9.txt";

fn fixture(names: &[(&[u8], u16, &[u8])]) -> Vec<u8> {
    fn u16_bytes(out: &mut Vec<u8>, value: u16) {
        out.extend_from_slice(&value.to_le_bytes());
    }
    fn u32_bytes(out: &mut Vec<u8>, value: u32) {
        out.extend_from_slice(&value.to_le_bytes());
    }
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for (name, flags, extra) in names {
        let offset = out.len() as u32;
        u32_bytes(&mut out, 0x04034b50);
        for value in [20, *flags, 0, 0, 0] {
            u16_bytes(&mut out, value);
        }
        for value in [0x8cdc1683, 1, 1] {
            u32_bytes(&mut out, value);
        }
        u16_bytes(&mut out, name.len() as u16);
        u16_bytes(&mut out, extra.len() as u16);
        out.extend_from_slice(name);
        out.extend_from_slice(extra);
        out.push(b'x');
        u32_bytes(&mut directory, 0x02014b50);
        for value in [20, 20, *flags, 0, 0, 0] {
            u16_bytes(&mut directory, value);
        }
        for value in [0x8cdc1683, 1, 1] {
            u32_bytes(&mut directory, value);
        }
        for value in [name.len() as u16, extra.len() as u16, 0, 0, 0] {
            u16_bytes(&mut directory, value);
        }
        u32_bytes(&mut directory, 0);
        u32_bytes(&mut directory, offset);
        directory.extend_from_slice(name);
        directory.extend_from_slice(extra);
    }
    let offset = out.len() as u32;
    let length = directory.len() as u32;
    out.extend(directory);
    u32_bytes(&mut out, 0x06054b50);
    for value in [0, 0, names.len() as u16, names.len() as u16] {
        u16_bytes(&mut out, value);
    }
    u32_bytes(&mut out, length);
    u32_bytes(&mut out, offset);
    u16_bytes(&mut out, 0);
    out
}

fn with_archive(bytes: &[u8], run: impl FnOnce(&std::path::Path)) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.zip");
    std::fs::write(&path, bytes).unwrap();
    run(&path);
}

#[test]
fn decoded_cp437_and_utf8_names_preserve_legacy_digest_and_lookup() {
    for (name, flags) in [(CP437, 0), (UTF8, 0x800)] {
        let bytes = fixture(&[(name, flags, &[])]);
        assert_eq!(
            hex_digest(&canonical_zip_digest(&bytes, None).unwrap()),
            LEGACY_DIGEST
        );
        with_archive(&bytes, |path| {
            assert_eq!(read_zip_entry_file(path, "\u{e9}.txt", 1).unwrap(), b"x");
            assert!(zip_entry_exists_file(path, "\u{e9}.txt").unwrap());
            assert!(!zip_entry_exists_file(path, "missing.txt").unwrap());
            assert_eq!(
                read_zip_entry_file(path, "missing.txt", 1),
                Err(ArchiveError::MissingEntry)
            );
        });
    }
}

#[test]
fn unicode_path_extra_field_preserves_decoded_identity() {
    // Info-ZIP 0x7075, version 1, CRC32("legacy.txt"), UTF-8 "e-acute.txt".
    let extra = b"\x75\x70\x0b\x00\x01\x80\x07\x73\x10\xc3\xa9.txt";
    let bytes = fixture(&[(b"legacy.txt", 0, extra)]);
    assert_eq!(
        hex_digest(&canonical_zip_digest(&bytes, None).unwrap()),
        LEGACY_DIGEST
    );
    with_archive(&bytes, |path| {
        assert_eq!(read_zip_entry_file(path, "\u{e9}.txt", 1).unwrap(), b"x");
        assert!(zip_entry_exists_file(path, "\u{e9}.txt").unwrap());
    });
}

#[test]
fn decoded_and_ascii_case_collisions_fail_closed_in_digest_and_lookup() {
    for names in [
        [(CP437, 0, &[][..]), (UTF8, 0x800, &[][..])],
        [
            (b"A.txt".as_slice(), 0, &[][..]),
            (b"a.txt".as_slice(), 0, &[][..]),
        ],
    ] {
        let bytes = fixture(&names);
        assert_eq!(
            canonical_zip_digest(&bytes, None),
            Err(ArchiveError::UnsafePath)
        );
        let name = if names[0].0 == CP437 {
            "\u{e9}.txt"
        } else {
            "A.txt"
        };
        with_archive(&bytes, |path| {
            assert_eq!(
                read_zip_entry_file(path, name, 1),
                Err(ArchiveError::UnsafePath)
            );
            assert_eq!(
                zip_entry_exists_file(path, name),
                Err(ArchiveError::UnsafePath)
            );
        });
    }
}

#[test]
fn signatures_bound_to_the_frozen_old_digest_still_verify() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let document = crate::SignatureDocument {
        schema_version: 1,
        algorithm: "ed25519".into(),
        key_id: "fixture".into(),
        digest_algorithm: "sha256".into(),
        digest: LEGACY_DIGEST.into(),
        signature: STANDARD.encode(key.sign(LEGACY_DIGEST.as_bytes()).to_bytes()),
        public_key: STANDARD.encode(key.verifying_key().to_bytes()),
    };
    let bytes = fixture(&[(CP437, 0, &[]), (b"signature.json", 0, &[])]);
    crate::verify_signature_document(
        &bytes,
        &document,
        "signature.json",
        "fixture",
        &key.verifying_key().to_bytes(),
    )
    .unwrap();
    with_archive(&bytes, |path| {
        crate::verify_signature_document_file(
            path,
            &document,
            "signature.json",
            "fixture",
            &key.verifying_key().to_bytes(),
        )
        .unwrap();
    });
}

#[test]
fn entry_lookup_keeps_size_path_and_format_boundaries() {
    with_archive(&fixture(&[(b"a.txt", 0, &[])]), |path| {
        assert_eq!(
            read_zip_entry_file(path, "a.txt", 0),
            Err(ArchiveError::UnsafePath)
        );
        assert_eq!(read_zip_entry_file(path, "a.txt", u64::MAX).unwrap(), b"x");
        assert_eq!(
            zip_entry_exists_file(path, "../a.txt"),
            Err(ArchiveError::UnsafePath)
        );
    });
    with_archive(b"invalid", |path| {
        assert_eq!(
            read_zip_entry_file(path, "a.txt", 1),
            Err(ArchiveError::InvalidArchive)
        );
        assert_eq!(
            zip_entry_exists_file(path, "a.txt"),
            Err(ArchiveError::InvalidArchive)
        );
    });
}
