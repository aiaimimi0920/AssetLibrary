mod authorization;
mod decision;
pub(crate) mod idempotency;
mod moderation;
mod operator_moderation;
mod operator_reads;
pub(crate) mod publication;
mod publisher_moderation;
mod submission;

use assetlibrary_contracts::{
    AppealModerationRequest, CreateSubmissionRequest, DecideReviewRequest, ModerationActionView,
    ModerationCaseView, OperatorModerationCaseDetail, OperatorModerationCaseItem,
    OperatorReviewQueueItem, OperatorSubmissionDetail, ProposeModerationActionRequest,
    PublisherModerationCaseDetail, PublisherModerationCaseItem, ReportPackageRequest,
    ResolveModerationRequest, ReviewDecisionView, SubmissionView, WithdrawSubmissionRequest,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::identity::PrincipalRef;

pub use moderation::PostgresModerationRepository;

#[derive(Debug)]
pub enum WorkflowError {
    Forbidden,
    NotFound,
    InvalidState,
    IdempotencyConflict,
    FeatureDisabled,
    Database,
}

pub struct PostgresReviewRepository {
    pool: PgPool,
    app_updates_enabled: bool,
}

impl PostgresReviewRepository {
    pub fn new(pool: PgPool, app_updates_enabled: bool) -> Self {
        Self {
            pool,
            app_updates_enabled,
        }
    }
}

#[derive(Default)]
pub struct UnavailableReviewRepository;

#[derive(Default)]
pub struct UnavailableModerationRepository;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewQueueCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub snapshot_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub submitted_at: OffsetDateTime,
    pub submission_id: Uuid,
}

pub struct ReviewQueueFilter {
    pub cursor: Option<ReviewQueueCursor>,
    pub limit: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModerationQueueCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub snapshot_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub case_id: Uuid,
}

pub struct ModerationQueueFilter {
    pub cursor: Option<ModerationQueueCursor>,
    pub limit: u16,
}

#[async_trait]
pub trait ReviewRepository: Send + Sync {
    async fn submit(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateSubmissionRequest,
    ) -> Result<SubmissionView, WorkflowError>;
    async fn withdraw(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
        key: &str,
        request_id: &str,
        request: &WithdrawSubmissionRequest,
    ) -> Result<SubmissionView, WorkflowError>;
    async fn queue(
        &self,
        principal: &PrincipalRef,
        filter: &ReviewQueueFilter,
    ) -> Result<(Vec<OperatorReviewQueueItem>, Option<ReviewQueueCursor>), WorkflowError>;
    async fn submission_detail(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
    ) -> Result<OperatorSubmissionDetail, WorkflowError>;
    async fn decide(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
        key: &str,
        request_id: &str,
        request: &DecideReviewRequest,
    ) -> Result<ReviewDecisionView, WorkflowError>;
    async fn publish(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
        key: &str,
        request_id: &str,
    ) -> Result<SubmissionView, WorkflowError>;
}

#[async_trait]
pub trait ModerationRepository: Send + Sync {
    async fn queue(
        &self,
        principal: &PrincipalRef,
        filter: &ModerationQueueFilter,
    ) -> Result<
        (
            Vec<OperatorModerationCaseItem>,
            Option<ModerationQueueCursor>,
        ),
        WorkflowError,
    >;
    async fn case_detail(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
    ) -> Result<OperatorModerationCaseDetail, WorkflowError>;
    async fn publisher_queue(
        &self,
        principal: &PrincipalRef,
        filter: &ModerationQueueFilter,
    ) -> Result<
        (
            Vec<PublisherModerationCaseItem>,
            Option<ModerationQueueCursor>,
        ),
        WorkflowError,
    >;
    async fn publisher_case_detail(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
    ) -> Result<PublisherModerationCaseDetail, WorkflowError>;
    async fn report(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &ReportPackageRequest,
    ) -> Result<ModerationCaseView, WorkflowError>;
    async fn propose(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
        key: &str,
        request_id: &str,
        request: &ProposeModerationActionRequest,
    ) -> Result<ModerationActionView, WorkflowError>;
    async fn approve(
        &self,
        principal: &PrincipalRef,
        action_id: Uuid,
        key: &str,
        request_id: &str,
    ) -> Result<ModerationActionView, WorkflowError>;
    async fn appeal(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
        key: &str,
        request_id: &str,
        request: &AppealModerationRequest,
    ) -> Result<ModerationCaseView, WorkflowError>;
    async fn resolve(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
        key: &str,
        request_id: &str,
        request: &ResolveModerationRequest,
    ) -> Result<ModerationCaseView, WorkflowError>;
}

macro_rules! unavailable {
    ($type:ty, $trait_name:ident, {$($method:item)*}) => {
        #[async_trait]
        impl $trait_name for $type { $($method)* }
    };
}

unavailable!(UnavailableReviewRepository, ReviewRepository, {
    async fn submit(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &CreateSubmissionRequest,
    ) -> Result<SubmissionView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn withdraw(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &WithdrawSubmissionRequest,
    ) -> Result<SubmissionView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn queue(
        &self,
        _: &PrincipalRef,
        _: &ReviewQueueFilter,
    ) -> Result<(Vec<OperatorReviewQueueItem>, Option<ReviewQueueCursor>), WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn submission_detail(
        &self,
        _: &PrincipalRef,
        _: Uuid,
    ) -> Result<OperatorSubmissionDetail, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn decide(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &DecideReviewRequest,
    ) -> Result<ReviewDecisionView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn publish(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
    ) -> Result<SubmissionView, WorkflowError> {
        Err(WorkflowError::Database)
    }
});

unavailable!(UnavailableModerationRepository, ModerationRepository, {
    async fn queue(
        &self,
        _: &PrincipalRef,
        _: &ModerationQueueFilter,
    ) -> Result<
        (
            Vec<OperatorModerationCaseItem>,
            Option<ModerationQueueCursor>,
        ),
        WorkflowError,
    > {
        Err(WorkflowError::Database)
    }
    async fn case_detail(
        &self,
        _: &PrincipalRef,
        _: Uuid,
    ) -> Result<OperatorModerationCaseDetail, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn publisher_queue(
        &self,
        _: &PrincipalRef,
        _: &ModerationQueueFilter,
    ) -> Result<
        (
            Vec<PublisherModerationCaseItem>,
            Option<ModerationQueueCursor>,
        ),
        WorkflowError,
    > {
        Err(WorkflowError::Database)
    }
    async fn publisher_case_detail(
        &self,
        _: &PrincipalRef,
        _: Uuid,
    ) -> Result<PublisherModerationCaseDetail, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn report(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &ReportPackageRequest,
    ) -> Result<ModerationCaseView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn propose(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &ProposeModerationActionRequest,
    ) -> Result<ModerationActionView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn approve(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
    ) -> Result<ModerationActionView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn appeal(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &AppealModerationRequest,
    ) -> Result<ModerationCaseView, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn resolve(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &ResolveModerationRequest,
    ) -> Result<ModerationCaseView, WorkflowError> {
        Err(WorkflowError::Database)
    }
});
