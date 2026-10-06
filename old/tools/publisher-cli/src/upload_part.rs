use assetlibrary_contracts::{CompleteUploadPart, PresignUploadPartRequest, UploadedPart};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{StreamExt, stream};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use url::Url;
use uuid::Uuid;

use crate::{api::PublisherApi, error::CliError};

#[derive(Clone)]
pub struct PartSource {
    pub path: PathBuf,
    pub part_number: u16,
    pub offset: u64,
    pub size: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

pub struct AllowedOrigins {
    values: BTreeSet<Origin>,
    allow_http: bool,
}

impl AllowedOrigins {
    pub fn new(values: &[String], allow_http: bool) -> Result<Self, CliError> {
        let values = values
            .iter()
            .map(|value| {
                let url = Url::parse(value)
                    .map_err(|_| CliError::Configuration("invalid upload origin"))?;
                if url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || !matches!(url.scheme(), "http" | "https")
                    || (url.scheme() == "http" && !allow_http)
                {
                    return Err(CliError::Configuration("unsafe upload origin"));
                }
                origin(&url).ok_or(CliError::Configuration("invalid upload origin"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        if values.is_empty() {
            return Err(CliError::Configuration("upload origin allowlist is empty"));
        }
        Ok(Self { values, allow_http })
    }

    fn allows(&self, url: &Url) -> bool {
        (url.scheme() != "http" || self.allow_http)
            && origin(url).is_some_and(|value| self.values.contains(&value))
    }
}

pub async fn upload_parts(
    api: &PublisherApi,
    origins: &AllowedOrigins,
    session_id: Uuid,
    sources: Vec<PartSource>,
    existing: &[UploadedPart],
) -> Result<Vec<CompleteUploadPart>, CliError> {
    let mut existing_by_number = BTreeMap::new();
    for part in existing {
        if existing_by_number
            .insert(part.part_number, part.clone())
            .is_some()
        {
            return Err(CliError::Validation(
                "upload status contains duplicate parts".to_owned(),
            ));
        }
    }
    let largest_part = sources.iter().map(|source| source.size).max().unwrap_or(1);
    let concurrency = ((128 * 1024 * 1024 / largest_part).clamp(1, 3)) as usize;
    let mut completed = stream::iter(sources.into_iter().map(|source| {
        let existing = existing_by_number.get(&source.part_number).cloned();
        async move { upload_or_reuse(api, origins, session_id, source, existing).await }
    }))
    .buffer_unordered(concurrency)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    completed.sort_by_key(|part| part.part_number);
    Ok(completed)
}

async fn upload_or_reuse(
    api: &PublisherApi,
    origins: &AllowedOrigins,
    session_id: Uuid,
    source: PartSource,
    existing: Option<UploadedPart>,
) -> Result<CompleteUploadPart, CliError> {
    let bytes = read_part(&source).await?;
    let checksum = STANDARD.encode(Sha256::digest(&bytes));
    if let Some(existing) = existing
        && existing.size_bytes == source.size
        && existing.checksum_sha256_base64 == checksum
    {
        return Ok(CompleteUploadPart {
            part_number: source.part_number,
            etag: existing.etag,
            checksum_sha256_base64: checksum,
        });
    }
    let mut attempt = 0u8;
    loop {
        match put_part(api, origins, session_id, &source, &bytes, &checksum).await {
            Ok(value) => return Ok(value),
            Err(error) if retryable(&error) && attempt < 3 => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(250 * (1u64 << attempt))).await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn put_part(
    api: &PublisherApi,
    origins: &AllowedOrigins,
    session_id: Uuid,
    source: &PartSource,
    bytes: &[u8],
    checksum: &str,
) -> Result<CompleteUploadPart, CliError> {
    let presigned = api
        .presign_part(
            session_id,
            source.part_number,
            &PresignUploadPartRequest {
                size_bytes: source.size,
                checksum_sha256_base64: checksum.to_owned(),
            },
        )
        .await?;
    if presigned.part_number != source.part_number
        || presigned.method != "PUT"
        || !(1..=900).contains(&presigned.expires_in_seconds)
    {
        return Err(CliError::Validation(
            "invalid presigned upload response".to_owned(),
        ));
    }
    let url = Url::parse(&presigned.url)
        .map_err(|_| CliError::Validation("invalid presigned upload URL".to_owned()))?;
    if !origins.allows(&url)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(CliError::Configuration(
            "presigned upload origin is not allowed",
        ));
    }
    if presigned.headers.len() > 32 {
        return Err(CliError::Validation(
            "presigned upload requested too many headers".to_owned(),
        ));
    }
    let mut headers = HeaderMap::new();
    for (name, value) in presigned.headers {
        let lower = name.to_ascii_lowercase();
        if name.len() > 128
            || value.len() > 4096
            || matches!(
                lower.as_str(),
                "authorization"
                    | "connection"
                    | "cookie"
                    | "proxy-authorization"
                    | "transfer-encoding"
            )
        {
            return Err(CliError::Validation(
                "presigned upload requested a sensitive header".to_owned(),
            ));
        }
        if transport_header(&lower, &value, &url, bytes.len())? {
            continue;
        }
        headers.insert(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| CliError::Validation("invalid presigned header".to_owned()))?,
            HeaderValue::from_str(&value)
                .map_err(|_| CliError::Validation("invalid presigned header".to_owned()))?,
        );
    }
    let response = api
        .upload_client()
        .put(url)
        .timeout(Duration::from_secs(900))
        .headers(headers)
        .body(bytes.to_vec())
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(CliError::Server(response.status().as_u16()));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 200
                && value.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or_else(|| CliError::Validation("upload response omitted ETag".to_owned()))?;
    Ok(CompleteUploadPart {
        part_number: source.part_number,
        etag: etag.to_owned(),
        checksum_sha256_base64: checksum.to_owned(),
    })
}

async fn read_part(source: &PartSource) -> Result<Vec<u8>, CliError> {
    let size = usize::try_from(source.size)
        .map_err(|_| CliError::Validation("part is too large".to_owned()))?;
    let mut file = tokio::fs::File::open(&source.path).await?;
    file.seek(std::io::SeekFrom::Start(source.offset)).await?;
    let mut bytes = vec![0u8; size];
    file.read_exact(&mut bytes).await?;
    Ok(bytes)
}

/// SigV4 signs `host` and `content-length`, but the HTTP client owns both headers.
/// They are skipped when they match the request and rejected when they conflict.
fn transport_header(
    name: &str,
    value: &str,
    url: &Url,
    body_length: usize,
) -> Result<bool, CliError> {
    let expected = match name {
        "host" => url.host_str().map(|host| match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        }),
        "content-length" => Some(body_length.to_string()),
        _ => return Ok(false),
    };
    if expected.as_deref() == Some(value) {
        return Ok(true);
    }
    Err(CliError::Validation(
        "presigned upload header conflicts with the request".to_owned(),
    ))
}

fn origin(url: &Url) -> Option<Origin> {
    Some(Origin {
        scheme: url.scheme().to_owned(),
        host: url.host_str()?.to_ascii_lowercase(),
        port: url.port_or_known_default()?,
    })
}

fn retryable(error: &CliError) -> bool {
    matches!(
        error,
        CliError::Network(_) | CliError::Server(408 | 429 | 500..=599)
    )
}
