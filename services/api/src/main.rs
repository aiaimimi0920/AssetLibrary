mod artifact;
mod catalog;
mod config;
mod download_routes;
mod downloads;
mod identity;
mod install_receipt_routes;
mod install_receipts;
mod library;
mod library_routes;
mod observability;
mod public_releases;
mod public_routes;
mod publisher;
mod publisher_mutations;
mod publisher_package_mutations;
mod publisher_queries;
mod publisher_routes;
mod publisher_signing_keys;
mod publisher_workspace;
mod routes;
mod search;
mod search_routes;
mod uploads;
mod workflow;
mod workflow_routes;

use assetlibrary_object_store::{ObjectStore, S3ObjectStore};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderName, StatusCode},
    routing::get,
};
use catalog::{CatalogRepository, PostgresCatalog};
use config::{Config, Environment};
use downloads::{DownloadRepository, PostgresDownloadRepository, UnavailableDownloadRepository};
use identity::{DevelopmentIdentityAdapter, ExternalIdentityAdapter, IdentityProvider};
use install_receipts::{
    InstallReceiptRepository, PostgresInstallReceiptRepository, UnavailableInstallReceiptRepository,
};
use library::{LibraryRepository, PostgresLibraryRepository, UnavailableLibraryRepository};
use public_releases::{
    DevelopmentPublicReleaseRepository, PostgresPublicReleaseRepository, PublicReleaseRepository,
};
use publisher::{PostgresPublisherRepository, PublisherRepository, UnavailablePublisherRepository};
use search::{OpenSearchRepository, SearchRepository, UnavailableSearchRepository};
use serde::Serialize;
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use uploads::{DevelopmentUploadRepository, PostgresUploadRepository, UploadRepository};
use workflow::{
    ModerationRepository, PostgresModerationRepository, PostgresReviewRepository, ReviewRepository,
    UnavailableModerationRepository, UnavailableReviewRepository,
};

#[derive(Clone)]
pub struct AppState {
    pub catalog: Arc<dyn CatalogRepository>,
    pub identity: Arc<dyn identity::IdentityProvider>,
    pub uploads: Arc<dyn UploadRepository>,
    pub object_store: Option<Arc<dyn ObjectStore>>,
    pub reviews: Arc<dyn ReviewRepository>,
    pub moderation: Arc<dyn ModerationRepository>,
    pub library: Arc<dyn LibraryRepository>,
    pub install_receipts: Arc<dyn InstallReceiptRepository>,
    pub downloads: Arc<dyn DownloadRepository>,
    pub search: Arc<dyn SearchRepository>,
    pub public_releases: Arc<dyn PublicReleaseRepository>,
    pub publishers: Arc<dyn PublisherRepository>,
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}
async fn readiness(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    match state.catalog.ready().await {
        Ok(()) => (StatusCode::OK, Json(Health { status: "ok" })),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Health {
                status: "not_ready",
            }),
        ),
    }
}

fn router(state: AppState) -> Router {
    let request_id = HeaderName::from_static("x-request-id");
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(readiness))
        .route("/v1/public/packages", get(routes::list_packages))
        .route("/v1/public/search", get(search_routes::search))
        .route("/v1/public/packages/{slug}", get(routes::get_package))
        .route(
            "/v1/public/packages/{slug}/releases",
            get(public_routes::list_releases),
        )
        .route(
            "/v1/public/publishers/{slug}",
            get(public_routes::get_publisher),
        )
        .route(
            "/v1/public/artifacts/{artifact_id}/download",
            get(download_routes::public_download),
        )
        .route("/v1/me", get(routes::get_me))
        .route("/v1/me/publishers", get(publisher_routes::list_memberships))
        .route(
            "/v1/me/publishers/{publisher_id}/packages",
            get(publisher_routes::list_packages).post(publisher_routes::create_package),
        )
        .route(
            "/v1/me/publishers/{publisher_id}/signing-keys",
            get(publisher_routes::list_signing_keys).post(publisher_routes::register_signing_key),
        )
        .route(
            "/v1/me/publishers/{publisher_id}/signing-keys/{key_id}/revoke",
            axum::routing::post(publisher_routes::revoke_signing_key),
        )
        .route(
            "/v1/me/packages/{package_id}/releases",
            get(publisher_routes::list_releases).post(publisher_routes::create_release),
        )
        .route(
            "/v1/me/packages/{package_id}",
            get(publisher_routes::get_package).patch(publisher_routes::update_package),
        )
        .route(
            "/v1/me/releases/{release_id}",
            get(publisher_routes::get_release).patch(publisher_routes::update_release),
        )
        .route(
            "/v1/me/releases/{release_id}/workspace",
            get(publisher_routes::get_release_workspace),
        )
        .route("/v1/me/library", get(library_routes::list))
        .route(
            "/v1/me/library/{package_id}",
            axum::routing::put(library_routes::update),
        )
        .route(
            "/v1/me/artifacts/{artifact_id}/download-sessions",
            axum::routing::post(download_routes::issue),
        )
        .route(
            "/v1/me/download-sessions/{session_id}/install-challenge",
            axum::routing::post(install_receipt_routes::challenge),
        )
        .route(
            "/v1/me/install-receipts/{receipt_id}/verify",
            axum::routing::post(install_receipt_routes::verify),
        )
        .route(
            "/v1/me/releases/{release_id}/upload-sessions",
            axum::routing::post(routes::create_upload_session),
        )
        .route(
            "/v1/me/upload-sessions/{session_id}",
            get(routes::get_upload_session),
        )
        .route(
            "/v1/me/upload-sessions/{session_id}/parts/{part_number}",
            axum::routing::post(routes::presign_upload_part),
        )
        .route(
            "/v1/me/upload-sessions/{session_id}/complete",
            axum::routing::post(routes::complete_upload_session),
        )
        .route(
            "/v1/me/releases/{release_id}/submissions",
            axum::routing::post(workflow_routes::submit),
        )
        .route(
            "/v1/me/submissions/{submission_id}/withdraw",
            axum::routing::post(workflow_routes::withdraw),
        )
        .route(
            "/v1/internal/review-queue",
            get(workflow_routes::review_queue),
        )
        .route(
            "/v1/internal/submissions/{submission_id}/reviews",
            axum::routing::post(workflow_routes::decide),
        )
        .route(
            "/v1/internal/submissions/{submission_id}",
            get(workflow_routes::submission_detail),
        )
        .route(
            "/v1/internal/submissions/{submission_id}/publish",
            axum::routing::post(workflow_routes::publish),
        )
        .route(
            "/v1/me/packages/{package_id}/reports",
            axum::routing::post(workflow_routes::report),
        )
        .route(
            "/v1/internal/moderation-cases",
            get(workflow_routes::moderation_queue),
        )
        .route(
            "/v1/internal/moderation-cases/{case_id}",
            get(workflow_routes::moderation_case_detail),
        )
        .route(
            "/v1/me/moderation-cases",
            get(workflow_routes::publisher_moderation_queue),
        )
        .route(
            "/v1/me/moderation-cases/{case_id}",
            get(workflow_routes::publisher_moderation_case_detail),
        )
        .route(
            "/v1/internal/moderation-cases/{case_id}/actions",
            axum::routing::post(workflow_routes::propose),
        )
        .route(
            "/v1/internal/moderation-actions/{action_id}/approve",
            axum::routing::post(workflow_routes::approve),
        )
        .route(
            "/v1/me/moderation-cases/{case_id}/appeal",
            axum::routing::post(workflow_routes::appeal),
        )
        .route(
            "/v1/internal/moderation-cases/{case_id}/resolve",
            axum::routing::post(workflow_routes::resolve),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(axum::middleware::from_fn(observability::observe_http))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .with_state(state)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _telemetry = assetlibrary_telemetry::init(
        "assetlibrary-api",
        assetlibrary_telemetry::metrics_endpoint_from_env()?,
    )?;
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let pool = match config.database_url.as_deref() {
        Some(database_url) => Some(
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(20)
                .min_connections(2)
                .connect(database_url)
                .await?,
        ),
        None => None,
    };
    let _pool_metrics = pool
        .clone()
        .map(|pool| assetlibrary_telemetry::monitor_postgres_pool(pool, "primary", 20));
    let catalog: Arc<dyn CatalogRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresCatalog::new(pool)),
        None => Arc::new(catalog::DevelopmentCatalog::default()),
    };
    let identity: Arc<dyn IdentityProvider> =
        match config.environment {
            Environment::Development => Arc::new(DevelopmentIdentityAdapter),
            Environment::Staging | Environment::Production => Arc::new(
                ExternalIdentityAdapter::new(config.oidc.ok_or_else(|| {
                    std::io::Error::other("Config rejects missing production OIDC")
                })?)
                .map_err(std::io::Error::other)?,
            ),
        };
    let uploads: Arc<dyn UploadRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresUploadRepository::new(pool)),
        None => Arc::new(DevelopmentUploadRepository::default()),
    };
    let reviews: Arc<dyn ReviewRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresReviewRepository::new(
            pool,
            config.app_updates_enabled,
        )),
        None => Arc::new(UnavailableReviewRepository),
    };
    let moderation: Arc<dyn ModerationRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresModerationRepository::new(pool)),
        None => Arc::new(UnavailableModerationRepository),
    };
    let library: Arc<dyn LibraryRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresLibraryRepository::new(pool)),
        None => Arc::new(UnavailableLibraryRepository),
    };
    let install_receipts: Arc<dyn InstallReceiptRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresInstallReceiptRepository::new(pool)),
        None => Arc::new(UnavailableInstallReceiptRepository),
    };
    let downloads: Arc<dyn DownloadRepository> = match (pool.clone(), config.downloads) {
        (Some(pool), Some(downloads)) => Arc::new(
            PostgresDownloadRepository::new(pool, downloads).map_err(std::io::Error::other)?,
        ),
        _ => Arc::new(UnavailableDownloadRepository),
    };
    let search: Arc<dyn SearchRepository> = match config.search {
        Some(search) => Arc::new(OpenSearchRepository::new(search).map_err(std::io::Error::other)?),
        None => Arc::new(UnavailableSearchRepository),
    };
    let public_releases: Arc<dyn PublicReleaseRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresPublicReleaseRepository::new(pool)),
        None => Arc::new(DevelopmentPublicReleaseRepository),
    };
    let publishers: Arc<dyn PublisherRepository> = match pool.clone() {
        Some(pool) => Arc::new(PostgresPublisherRepository::new(
            pool,
            config.app_updates_enabled,
        )),
        None => Arc::new(UnavailablePublisherRepository),
    };
    let object_store: Option<Arc<dyn ObjectStore>> = match config.object_store {
        Some(store) => Some(Arc::new(
            S3ObjectStore::new(assetlibrary_object_store::ObjectStoreConfig {
                endpoint_url: store.endpoint_url,
                region: store.region,
                quarantine_bucket: store.quarantine_bucket,
                published_bucket: store.published_bucket,
                force_path_style: store.force_path_style,
            })
            .await?,
        )),
        None => None,
    };
    let state = AppState {
        catalog,
        identity,
        uploads,
        object_store,
        reviews,
        moderation,
        library,
        install_receipts,
        downloads,
        search,
        public_releases,
        publishers,
    };
    let listener = TcpListener::bind(config.bind).await?;
    tracing::info!(address = ?config.bind, "assetlibrary api listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
