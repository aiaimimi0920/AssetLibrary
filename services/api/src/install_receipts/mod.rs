mod access;
mod repository;

use assetlibrary_contracts::{
    CreateInstallChallengeRequest, InstallChallenge, InstallReceipt, VerifyInstallReceiptRequest,
};
use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{identity::PrincipalRef, workflow::WorkflowError};

pub struct PostgresInstallReceiptRepository {
    pool: PgPool,
}

impl PostgresInstallReceiptRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[derive(Default)]
pub struct UnavailableInstallReceiptRepository;

#[async_trait]
pub trait InstallReceiptRepository: Send + Sync {
    async fn challenge(
        &self,
        principal: &PrincipalRef,
        download_session_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateInstallChallengeRequest,
    ) -> Result<InstallChallenge, WorkflowError>;

    async fn verify(
        &self,
        principal: &PrincipalRef,
        receipt_id: Uuid,
        key: &str,
        request_id: &str,
        request: &VerifyInstallReceiptRequest,
    ) -> Result<InstallReceipt, WorkflowError>;
}

#[async_trait]
impl InstallReceiptRepository for UnavailableInstallReceiptRepository {
    async fn challenge(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &CreateInstallChallengeRequest,
    ) -> Result<InstallChallenge, WorkflowError> {
        Err(WorkflowError::Database)
    }

    async fn verify(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &VerifyInstallReceiptRequest,
    ) -> Result<InstallReceipt, WorkflowError> {
        Err(WorkflowError::Database)
    }
}
