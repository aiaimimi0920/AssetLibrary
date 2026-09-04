use assetlibrary_supply_chain::{canonical_zip_digest, hex_digest, sha256_digest};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use std::{env, fs, io::Cursor, io::Write, path::Path};
use zip::{ZipWriter, write::SimpleFileOptions};

fn archive(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut output);
    for (name, bytes) in entries {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .expect("fixture entry");
        writer.write_all(bytes).expect("fixture bytes");
    }
    writer.finish().expect("fixture ZIP");
    output.into_inner()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args_os()
        .nth(1)
        .ok_or("usage: build_signed_fixture <output.zip>")?;
    let output = Path::new(&output);
    let manifest = json!({
        "id": "neuro-starter-art",
        "name": "Neuro Starter Art",
        "description": "AssetLibrary signed runtime fixture",
        "enabled": true,
        "execution": {"type": "framework_art", "framework": "neuro/runtime"},
        "inputs": [],
        "outputs": [],
        "params": [],
        "metadata": {
            "art": {"qualifiedId": "neuro-fixture-publisher/neuro-starter-art"},
            "dependencies": {"framework": "neuro/runtime", "frameworkVersion": "^1.0"},
            "packageSecurity": {
                "version": "1.0.0-dev",
                "publisher": {"id": "neuro-fixture-publisher", "keyId": "local-test-key"},
                "signature": {"algorithm": "ed25519", "keyId": "local-test-key", "file": "signature.json"}
            }
        }
    });
    let entries = vec![
        ("manifest.json", serde_json::to_vec_pretty(&manifest)?),
        (
            "art.runtime.json",
            serde_json::to_vec_pretty(&json!({
                "protocolVersion": "loom.art.runtime.v1",
                "entry": {"command": "runtime/main.exe", "args": []}
            }))?,
        ),
        ("runtime/main.exe", b"assetlibrary-fixture-runtime".to_vec()),
        (
            "sbom.cdx.json",
            serde_json::to_vec_pretty(&json!({
                "bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1,
                "metadata": {"component": {"type": "application", "name": "neuro-starter-art"}}
            }))?,
        ),
        (
            "provenance/build-provenance.json",
            serde_json::to_vec_pretty(&json!({
                "_type": "https://in-toto.io/Statement/v1",
                "predicateType": "https://slsa.dev/provenance/v1",
                "subject": [{"name": "neuro-starter-art"}]
            }))?,
        ),
    ];
    let unsigned = archive(&entries);
    let canonical = canonical_zip_digest(&unsigned, None)?;
    let canonical_hex = hex_digest(&canonical);
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let signature = signing_key.sign(canonical_hex.as_bytes());
    let signature_document = json!({
        "schemaVersion": 1,
        "algorithm": "ed25519",
        "keyId": "local-test-key",
        "digestAlgorithm": "sha256",
        "digest": canonical_hex.clone(),
        "signature": STANDARD.encode(signature.to_bytes()),
        "publicKey": STANDARD.encode(signing_key.verifying_key().to_bytes())
    });
    let mut signed_entries = entries;
    signed_entries.push((
        "signature.json",
        serde_json::to_vec_pretty(&signature_document)?,
    ));
    let signed = archive(&signed_entries);
    fs::write(output, &signed)?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "digest": hex_digest(&sha256_digest(&signed)),
            "canonical_digest": canonical_hex,
            "public_key": hex_digest(&signing_key.verifying_key().to_bytes()),
            "size_bytes": signed.len()
        }))?
    );
    Ok(())
}
