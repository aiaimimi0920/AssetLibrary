//! Exercise the real Loom download verifier without activating a host or receipt.

use assetlibrary_contracts::InstallHostProfile;
use assetlibrary_loom_client::{
    AccountBearer, ClientConfig, DownloadOrigin, LoomApiClient, ReceiptProofKey,
    ResumableDownloader,
};
use std::{env, error::Error};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[tokio::main]
async fn main() {
    if let Err(error) = verify().await {
        eprintln!("download verification failed: {error}");
        std::process::exit(1);
    }
}

async fn verify() -> Result<(), Box<dyn Error>> {
    let base = env::var("ASSETLIBRARY_API_URL")?;
    let origin = env::var("ASSETLIBRARY_DOWNLOAD_ORIGIN")?;
    let account = AccountBearer::new(&env::var("ASSETLIBRARY_TOKEN")?)?;
    let artifact = Uuid::parse_str(&env::var("ASSETLIBRARY_ARTIFACT_ID")?)?;
    let host_json = env::var("ASSETLIBRARY_HOST_PROFILE")?;
    if host_json.len() > 64 * 1024 {
        return Err("host profile exceeds 64 KiB".into());
    }
    let host: InstallHostProfile = serde_json::from_str(&host_json)?;
    let allow_http = env::var("ASSETLIBRARY_ALLOW_HTTP").as_deref() == Ok("true");
    let config = ClientConfig::new(
        &base,
        [DownloadOrigin::parse(&origin, allow_http)?],
        allow_http,
    )?;
    let api = LoomApiClient::new(config)?;
    let session = api
        .create_download_session(&account, artifact, &Uuid::new_v4().to_string())
        .await?;
    let (_proof, request) = ReceiptProofKey::generate(Uuid::new_v4(), host.clone())?;
    let challenge = api
        .create_install_challenge(
            &account,
            session.session_id,
            &Uuid::new_v4().to_string(),
            &request,
        )
        .await?;
    // A fresh private cache proves this run transferred bytes, not an old cache hit.
    let cache = tempfile::tempdir()?;
    let package = ResumableDownloader::new(api, cache.path())
        .download_and_verify(&session, &challenge, &host, &CancellationToken::new(), None)
        .await?;
    println!(
        "{}",
        serde_json::json!({
            "artifact_id": package.challenge().artifact.artifact_id,
            "bytes": package.challenge().artifact.size_bytes,
            "canonical_sha256": package.challenge().artifact.digest,
            "raw_sha256": package.challenge().archive_sha256,
            "signing_key_id": package.challenge().trusted_signing_key.key_id,
            "verified": true,
            "host_activated": false,
            "receipt_submitted": false,
        })
    );
    Ok(())
}
