//! Bounded harmless workloads; fixture construction is outside measured processes.
#[allow(dead_code)]
#[path = "build_signed_fixture.rs"]
mod signed_fixture;

use assetlibrary_supply_chain::{canonical_zip_digest, hex_digest, sha256_digest};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use std::{fs, io::Cursor, io::Read, io::Write, path::Path};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

type Entries = Vec<(String, Vec<u8>)>;
type Error = Box<dyn std::error::Error>;
const JSON_LIMIT: usize = 8 * 1024 * 1024;

fn archive(entries: &Entries) -> Result<Vec<u8>, Error> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        // Stored data isolates parser/entry-count costs and never relies on a
        // high compression ratio to manufacture a deceptively tiny workload.
        writer.start_file(
            name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )?;
        writer.write_all(bytes)?;
    }
    Ok(writer.finish()?.into_inner())
}

fn seed_entries(path: &Path) -> Result<Entries, Error> {
    let mut seed = ZipArchive::new(fs::File::open(path)?)?;
    let mut entries = Vec::new();
    for index in 0..seed.len() {
        let mut entry = seed.by_index(index)?;
        if entry.name() == "signature.json" {
            continue;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        entries.push((entry.name().to_owned(), bytes));
    }
    Ok(entries)
}

fn json_workload(size: usize, sbom: bool) -> Vec<u8> {
    let components: Vec<_> = (0..50_000)
        .map(|index| json!({"type":"library", "name":format!("synthetic-{index:05}"), "version":"0.0.0"}))
        .collect();
    let mut document = json!({"components":components,"padding":""});
    if sbom {
        document["bomFormat"] = json!("CycloneDX");
    } else {
        document["_type"] = json!("https://in-toto.io/Statement/v1");
    }
    let overhead = serde_json::to_vec(&document).unwrap().len();
    assert!(overhead < size);
    document["padding"] = json!("x".repeat(size - overhead));
    let bytes = serde_json::to_vec(&document).unwrap();
    assert_eq!(bytes.len(), size);
    bytes
}

fn write_variant(
    root: &Path,
    name: &str,
    mut entries: Entries,
    expected: &str,
) -> Result<Value, Error> {
    let unsigned = archive(&entries)?;
    let canonical = hex_digest(&canonical_zip_digest(&unsigned, None)?);
    let key = SigningKey::from_bytes(&[7u8; 32]); // Public test fixture key only.
    let signature = json!({
        "schemaVersion":1,"algorithm":"ed25519","keyId":"local-test-key",
        "digestAlgorithm":"sha256","digest":canonical,
        "signature":STANDARD.encode(key.sign(canonical.as_bytes()).to_bytes()),
        "publicKey":STANDARD.encode(key.verifying_key().to_bytes())
    });
    entries.push(("signature.json".to_owned(), serde_json::to_vec(&signature)?));
    let signed = archive(&entries)?;
    fs::write(root.join(format!("{name}.zip")), &signed)?;
    let attestations: Vec<_> = entries
        .iter()
        .filter(|(path, _)| path == "sbom.cdx.json" || path == "provenance/build-provenance.json")
        .map(|(path, bytes)| json!({"path":path,"bytes":bytes.len()}))
        .collect();
    Ok(json!({
        "name":name,"expected":expected,"entries":entries.len(),"size_bytes":signed.len(),
        "expanded_bytes":entries.iter().map(|(_, bytes)| bytes.len()).sum::<usize>(),
        "digest":hex_digest(&sha256_digest(&signed)),"canonical_digest":canonical,
        "attestations":attestations,"compression":"stored"
    }))
}

fn main() -> Result<(), Error> {
    let output = std::env::args_os()
        .nth(1)
        .ok_or("usage: build_resource_fixtures <new-directory>")?;
    let root = Path::new(&output);
    fs::create_dir(root)?;
    let baseline = signed_fixture::write_fixture(&root.join("baseline.zip"))?;
    let entries = seed_entries(&root.join("baseline.zip"))?;
    let mut profiles = vec![json!({
        "name":"baseline","expected":"ok","entries":6,
        "size_bytes":baseline["size_bytes"],"digest":baseline["digest"],
        "canonical_digest":baseline["canonical_digest"],"compression":"seed-default"
    })];
    let mut many = entries.clone();
    // Five seed entries plus 9,994 extras and one signature total exactly 10,000.
    for index in 0..9_994 {
        many.push((
            format!("resource/entry-{index:05}.txt"),
            b"harmless fixture bytes".to_vec(),
        ));
    }
    profiles.push(write_variant(root, "many-entries", many, "ok")?);
    let mut large = entries.clone();
    for (path, bytes) in &mut large {
        if path == "sbom.cdx.json" || path == "provenance/build-provenance.json" {
            *bytes = json_workload(JSON_LIMIT - 1, path == "sbom.cdx.json");
        }
    }
    profiles.push(write_variant(root, "large-json", large, "ok")?);
    let mut oversized = entries;
    for (path, bytes) in &mut oversized {
        if path == "sbom.cdx.json" {
            *bytes = json_workload(JSON_LIMIT + 1, true);
        }
    }
    profiles.push(write_variant(
        root,
        "oversized-json",
        oversized,
        "attestation_missing",
    )?);
    let invalid = b"not a ZIP archive";
    fs::write(root.join("invalid-zip.zip"), invalid)?;
    profiles.push(
        json!({"name":"invalid-zip","expected":"manifest_invalid","entries":0,
        "size_bytes":invalid.len(),"digest":hex_digest(&sha256_digest(invalid))}),
    );
    let metadata = json!({"schema_version":1,"profiles":profiles,"real_malware":false});
    fs::write(
        root.join("fixtures.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    println!(
        "generated {} bounded fixture profiles",
        metadata["profiles"].as_array().unwrap().len()
    );
    Ok(())
}
