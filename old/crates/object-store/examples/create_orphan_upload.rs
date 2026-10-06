use assetlibrary_object_store::{ObjectStore, ObjectStoreConfig, S3ObjectStore};
use std::env;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("ASSETLIBRARY_ENVIRONMENT").as_deref() != Ok("development") {
        return Err("this fixture helper is development-only".into());
    }
    let object_key = env::args()
        .nth(1)
        .filter(|value| value.starts_with("quarantine/") && value.ends_with(".zip"))
        .ok_or("usage: create_orphan_upload <canonical quarantine key>")?;
    let endpoint = required("ASSETLIBRARY_S3_ENDPOINT")?;
    if !endpoint.starts_with("http://127.0.0.1:") {
        return Err("fixture object store must be loopback HTTP".into());
    }
    let store = S3ObjectStore::new(ObjectStoreConfig {
        endpoint_url: Some(endpoint),
        region: required("ASSETLIBRARY_S3_REGION")?,
        quarantine_bucket: required("ASSETLIBRARY_QUARANTINE_BUCKET")?,
        published_bucket: required("ASSETLIBRARY_PUBLISHED_BUCKET")?,
        force_path_style: true,
    })
    .await?;
    store
        .create_quarantine_upload(&object_key, "application/zip")
        .await?;
    if !store
        .list_quarantine_multipart_uploads(100)
        .await?
        .iter()
        .any(|upload| upload.object_key == object_key)
    {
        return Err("created multipart upload was not listed".into());
    }
    Ok(())
}

fn required(name: &str) -> Result<String, Box<dyn std::error::Error>> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required").into())
}
