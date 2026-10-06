use assetlibrary_contracts::{
    CreatePackageRequest, CreateReleaseRequest, OwnedPackage, OwnedPackageSummary, OwnedRelease,
    PublisherMembership, PublisherReleaseWorkspace, PublisherSigningKey, RegisterSigningKeyRequest,
    RevokeSigningKeyRequest, UpdatePackageRequest, UpdateReleaseRequest,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{identity::PrincipalRef, workflow::WorkflowError};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MembershipCursor {
    pub publisher_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub package_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub release_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SigningKeyCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub key_id: String,
}

pub struct PageFilter<T> {
    pub cursor: Option<T>,
    pub limit: u16,
}

#[async_trait]
pub trait PublisherRepository: Send + Sync {
    async fn list_memberships(
        &self,
        principal: &PrincipalRef,
        filter: &PageFilter<MembershipCursor>,
    ) -> Result<(Vec<PublisherMembership>, Option<MembershipCursor>), WorkflowError>;
    async fn list_packages(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        filter: &PageFilter<PackageCursor>,
    ) -> Result<(Vec<OwnedPackageSummary>, Option<PackageCursor>), WorkflowError>;
    async fn create_package(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreatePackageRequest,
    ) -> Result<OwnedPackage, WorkflowError>;
    async fn list_signing_keys(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        filter: &PageFilter<SigningKeyCursor>,
    ) -> Result<(Vec<PublisherSigningKey>, Option<SigningKeyCursor>), WorkflowError>;
    async fn register_signing_key(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        key: &str,
        request_id: &str,
        request: &RegisterSigningKeyRequest,
    ) -> Result<PublisherSigningKey, WorkflowError>;
    async fn revoke_signing_key(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        key_id: &str,
        key: &str,
        request_id: &str,
        request: &RevokeSigningKeyRequest,
    ) -> Result<PublisherSigningKey, WorkflowError>;
    async fn get_package(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
    ) -> Result<OwnedPackage, WorkflowError>;
    async fn update_package(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &UpdatePackageRequest,
    ) -> Result<OwnedPackage, WorkflowError>;
    async fn list_releases(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        filter: &PageFilter<ReleaseCursor>,
    ) -> Result<(Vec<OwnedRelease>, Option<ReleaseCursor>), WorkflowError>;
    async fn create_release(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateReleaseRequest,
    ) -> Result<OwnedRelease, WorkflowError>;
    async fn get_release(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
    ) -> Result<OwnedRelease, WorkflowError>;
    async fn update_release(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        key: &str,
        request_id: &str,
        request: &UpdateReleaseRequest,
    ) -> Result<OwnedRelease, WorkflowError>;
    async fn get_release_workspace(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
    ) -> Result<PublisherReleaseWorkspace, WorkflowError>;
}

pub struct PostgresPublisherRepository {
    pub(crate) pool: PgPool,
    pub(crate) app_updates_enabled: bool,
}

impl PostgresPublisherRepository {
    pub fn new(pool: PgPool, app_updates_enabled: bool) -> Self {
        Self {
            pool,
            app_updates_enabled,
        }
    }
}

#[derive(Default)]
pub struct UnavailablePublisherRepository;

#[async_trait]
impl PublisherRepository for PostgresPublisherRepository {
    async fn list_memberships(
        &self,
        principal: &PrincipalRef,
        filter: &PageFilter<MembershipCursor>,
    ) -> Result<(Vec<PublisherMembership>, Option<MembershipCursor>), WorkflowError> {
        crate::publisher_queries::list_memberships(self, principal, filter).await
    }

    async fn list_packages(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        filter: &PageFilter<PackageCursor>,
    ) -> Result<(Vec<OwnedPackageSummary>, Option<PackageCursor>), WorkflowError> {
        crate::publisher_queries::list_packages(self, principal, publisher_id, filter).await
    }

    async fn create_package(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreatePackageRequest,
    ) -> Result<OwnedPackage, WorkflowError> {
        crate::publisher_mutations::create_package(
            self,
            principal,
            publisher_id,
            key,
            request_id,
            request,
        )
        .await
    }

    async fn list_signing_keys(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        filter: &PageFilter<SigningKeyCursor>,
    ) -> Result<(Vec<PublisherSigningKey>, Option<SigningKeyCursor>), WorkflowError> {
        crate::publisher_signing_keys::list(self, principal, publisher_id, filter).await
    }

    async fn register_signing_key(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        key: &str,
        request_id: &str,
        request: &RegisterSigningKeyRequest,
    ) -> Result<PublisherSigningKey, WorkflowError> {
        crate::publisher_signing_keys::register(
            self,
            principal,
            publisher_id,
            key,
            request_id,
            request,
        )
        .await
    }

    async fn revoke_signing_key(
        &self,
        principal: &PrincipalRef,
        publisher_id: Uuid,
        key_id: &str,
        key: &str,
        request_id: &str,
        request: &RevokeSigningKeyRequest,
    ) -> Result<PublisherSigningKey, WorkflowError> {
        crate::publisher_signing_keys::revoke(
            self,
            principal,
            publisher_id,
            key_id,
            key,
            request_id,
            request,
        )
        .await
    }

    async fn get_package(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
    ) -> Result<OwnedPackage, WorkflowError> {
        crate::publisher_queries::get_package(self, principal, package_id).await
    }

    async fn update_package(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &UpdatePackageRequest,
    ) -> Result<OwnedPackage, WorkflowError> {
        crate::publisher_package_mutations::update(
            self, principal, package_id, key, request_id, request,
        )
        .await
    }

    async fn list_releases(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        filter: &PageFilter<ReleaseCursor>,
    ) -> Result<(Vec<OwnedRelease>, Option<ReleaseCursor>), WorkflowError> {
        crate::publisher_queries::list_releases(self, principal, package_id, filter).await
    }

    async fn create_release(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateReleaseRequest,
    ) -> Result<OwnedRelease, WorkflowError> {
        crate::publisher_mutations::create_release(
            self, principal, package_id, key, request_id, request,
        )
        .await
    }

    async fn get_release(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
    ) -> Result<OwnedRelease, WorkflowError> {
        crate::publisher_queries::get_release(self, principal, release_id).await
    }

    async fn update_release(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        key: &str,
        request_id: &str,
        request: &UpdateReleaseRequest,
    ) -> Result<OwnedRelease, WorkflowError> {
        crate::publisher_mutations::update_release(
            self, principal, release_id, key, request_id, request,
        )
        .await
    }

    async fn get_release_workspace(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
    ) -> Result<PublisherReleaseWorkspace, WorkflowError> {
        crate::publisher_workspace::get(self, principal, release_id).await
    }
}

#[async_trait]
impl PublisherRepository for UnavailablePublisherRepository {
    async fn list_memberships(
        &self,
        _: &PrincipalRef,
        _: &PageFilter<MembershipCursor>,
    ) -> Result<(Vec<PublisherMembership>, Option<MembershipCursor>), WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn list_packages(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &PageFilter<PackageCursor>,
    ) -> Result<(Vec<OwnedPackageSummary>, Option<PackageCursor>), WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn create_package(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &CreatePackageRequest,
    ) -> Result<OwnedPackage, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn list_signing_keys(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &PageFilter<SigningKeyCursor>,
    ) -> Result<(Vec<PublisherSigningKey>, Option<SigningKeyCursor>), WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn register_signing_key(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &RegisterSigningKeyRequest,
    ) -> Result<PublisherSigningKey, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn revoke_signing_key(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &str,
        _: &RevokeSigningKeyRequest,
    ) -> Result<PublisherSigningKey, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn get_package(&self, _: &PrincipalRef, _: Uuid) -> Result<OwnedPackage, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn update_package(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &UpdatePackageRequest,
    ) -> Result<OwnedPackage, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn list_releases(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &PageFilter<ReleaseCursor>,
    ) -> Result<(Vec<OwnedRelease>, Option<ReleaseCursor>), WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn create_release(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &CreateReleaseRequest,
    ) -> Result<OwnedRelease, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn get_release(&self, _: &PrincipalRef, _: Uuid) -> Result<OwnedRelease, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn update_release(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &UpdateReleaseRequest,
    ) -> Result<OwnedRelease, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn get_release_workspace(
        &self,
        _: &PrincipalRef,
        _: Uuid,
    ) -> Result<PublisherReleaseWorkspace, WorkflowError> {
        Err(WorkflowError::Database)
    }
}
