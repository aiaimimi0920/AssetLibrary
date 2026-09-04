use assetlibrary_contracts::{
    AppealModerationRequest, CreateSubmissionRequest, DecideReviewRequest, ModerationActionView,
    ModerationCaseView, OperatorModerationCaseDetail, OperatorModerationQueuePage,
    OperatorReviewQueuePage, OperatorSubmissionDetail, ProposeModerationActionRequest,
    PublisherModerationCaseDetail, PublisherModerationCasePage, ReportPackageRequest,
    ResolveModerationRequest, ReviewDecisionView, SCHEMA_VERSION_V1, SubmissionView,
    WithdrawSubmissionRequest,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::CACHE_CONTROL},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::{
    AppState,
    identity::{IdentityError, PrincipalRef},
    workflow::{
        ModerationQueueCursor, ModerationQueueFilter, ReviewQueueCursor, ReviewQueueFilter,
        WorkflowError,
    },
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueQuery {
    cursor: Option<String>,
    limit: Option<u16>,
}

pub async fn submit(
    State(state): State<AppState>,
    Path(release_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateSubmissionRequest>,
) -> Result<Json<SubmissionView>, StatusCode> {
    if request.artifact_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .reviews
        .submit(&principal, release_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn withdraw(
    State(state): State<AppState>,
    Path(submission_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<WithdrawSubmissionRequest>,
) -> Result<Json<SubmissionView>, StatusCode> {
    if !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .reviews
        .withdraw(&principal, submission_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn review_queue(
    State(state): State<AppState>,
    Query(query): Query<QueueQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OperatorReviewQueuePage>), StatusCode> {
    let filter = queue_filter(query)?;
    let principal = authenticate(&state, &headers).await?;
    let (items, next) = state
        .reviews
        .queue(&principal, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(OperatorReviewQueuePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn submission_detail(
    State(state): State<AppState>,
    Path(submission_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OperatorSubmissionDetail>), StatusCode> {
    if submission_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let detail = state
        .reviews
        .submission_detail(&principal, submission_id)
        .await
        .map_err(map_workflow)?;
    private_json(detail)
}

pub async fn decide(
    State(state): State<AppState>,
    Path(submission_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<DecideReviewRequest>,
) -> Result<Json<ReviewDecisionView>, StatusCode> {
    if !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .reviews
        .decide(&principal, submission_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn publish(
    State(state): State<AppState>,
    Path(submission_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<SubmissionView>, StatusCode> {
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .reviews
        .publish(&principal, submission_id, key, request_id)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn report(
    State(state): State<AppState>,
    Path(package_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<ReportPackageRequest>,
) -> Result<Json<ModerationCaseView>, StatusCode> {
    if !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .moderation
        .report(&principal, package_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn moderation_queue(
    State(state): State<AppState>,
    Query(query): Query<QueueQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OperatorModerationQueuePage>), StatusCode> {
    let filter = moderation_queue_filter(query)?;
    let principal = authenticate(&state, &headers).await?;
    let (items, next) = state
        .moderation
        .queue(&principal, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(OperatorModerationQueuePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn moderation_case_detail(
    State(state): State<AppState>,
    Path(case_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OperatorModerationCaseDetail>), StatusCode> {
    if case_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let detail = state
        .moderation
        .case_detail(&principal, case_id)
        .await
        .map_err(map_workflow)?;
    private_json(detail)
}

pub async fn publisher_moderation_queue(
    State(state): State<AppState>,
    Query(query): Query<QueueQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<PublisherModerationCasePage>), StatusCode> {
    let filter = moderation_queue_filter(query)?;
    let principal = authenticate(&state, &headers).await?;
    let (items, next) = state
        .moderation
        .publisher_queue(&principal, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(PublisherModerationCasePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn publisher_moderation_case_detail(
    State(state): State<AppState>,
    Path(case_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<PublisherModerationCaseDetail>), StatusCode> {
    if case_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let detail = state
        .moderation
        .publisher_case_detail(&principal, case_id)
        .await
        .map_err(map_workflow)?;
    private_json(detail)
}

pub async fn propose(
    State(state): State<AppState>,
    Path(case_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<ProposeModerationActionRequest>,
) -> Result<Json<ModerationActionView>, StatusCode> {
    if !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .moderation
        .propose(&principal, case_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn approve(
    State(state): State<AppState>,
    Path(action_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ModerationActionView>, StatusCode> {
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .moderation
        .approve(&principal, action_id, key, request_id)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn appeal(
    State(state): State<AppState>,
    Path(case_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<AppealModerationRequest>,
) -> Result<Json<ModerationCaseView>, StatusCode> {
    if !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .moderation
        .appeal(&principal, case_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn resolve(
    State(state): State<AppState>,
    Path(case_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<ResolveModerationRequest>,
) -> Result<Json<ModerationCaseView>, StatusCode> {
    if !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .moderation
        .resolve(&principal, case_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub(crate) async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<PrincipalRef, StatusCode> {
    state
        .identity
        .authenticate(headers.get("authorization").and_then(|v| v.to_str().ok()))
        .await
        .map_err(|error| match error {
            IdentityError::MissingCredential | IdentityError::InvalidCredential => {
                StatusCode::UNAUTHORIZED
            }
            IdentityError::ExternalUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        })
}

pub(crate) fn mutation_headers(headers: &HeaderMap) -> Result<(&str, &str), StatusCode> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|value| {
            (8..=200).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic())
        })
        .ok_or(StatusCode::BAD_REQUEST)?;
    let request_id = headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|value| {
            !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_graphic())
        })
        .ok_or(StatusCode::BAD_REQUEST)?;
    Ok((key, request_id))
}

pub(crate) fn map_workflow(error: WorkflowError) -> StatusCode {
    match error {
        WorkflowError::Forbidden => StatusCode::FORBIDDEN,
        WorkflowError::NotFound => StatusCode::NOT_FOUND,
        WorkflowError::InvalidState | WorkflowError::IdempotencyConflict => StatusCode::CONFLICT,
        WorkflowError::FeatureDisabled => StatusCode::NOT_IMPLEMENTED,
        WorkflowError::Database => StatusCode::SERVICE_UNAVAILABLE,
    }
}

fn queue_filter(query: QueueQuery) -> Result<ReviewQueueFilter, StatusCode> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor::<ReviewQueueCursor>)
        .transpose()?;
    if cursor.as_ref().is_some_and(|value| {
        value.submission_id.is_nil()
            || value.snapshot_at.unix_timestamp() <= 0
            || value.submitted_at.unix_timestamp() <= 0
            || value.submitted_at > value.snapshot_at
            || value.snapshot_at > OffsetDateTime::now_utc() + Duration::minutes(1)
    }) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(ReviewQueueFilter { cursor, limit })
}

fn moderation_queue_filter(query: QueueQuery) -> Result<ModerationQueueFilter, StatusCode> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor::<ModerationQueueCursor>)
        .transpose()?;
    if cursor.as_ref().is_some_and(|value| {
        value.case_id.is_nil()
            || value.snapshot_at.unix_timestamp() <= 0
            || value.created_at.unix_timestamp() <= 0
            || value.created_at > value.snapshot_at
            || value.snapshot_at > OffsetDateTime::now_utc() + Duration::minutes(1)
    }) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(ModerationQueueFilter { cursor, limit })
}

fn encode_cursor<T: Serialize>(value: T) -> Result<String, StatusCode> {
    serde_json::to_vec(&value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn decode_cursor<T: DeserializeOwned>(value: &str) -> Result<T, StatusCode> {
    if value.len() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or(StatusCode::BAD_REQUEST)
}

fn private_json<T>(value: T) -> Result<(HeaderMap, Json<T>), StatusCode> {
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok((headers, Json(value)))
}

#[cfg(test)]
mod tests {
    use super::{QueueQuery, decode_cursor, encode_cursor, moderation_queue_filter, queue_filter};
    use crate::workflow::{ModerationQueueCursor, ReviewQueueCursor};
    use time::{Duration, OffsetDateTime};
    use uuid::Uuid;

    #[test]
    fn review_cursor_round_trips_and_bounds_are_strict() {
        let now = OffsetDateTime::now_utc();
        let cursor = ReviewQueueCursor {
            snapshot_at: now,
            submitted_at: now - Duration::seconds(1),
            submission_id: Uuid::new_v4(),
        };
        let encoded = encode_cursor(cursor).expect("cursor must encode");
        let filter = queue_filter(QueueQuery {
            cursor: Some(encoded),
            limit: Some(100),
        })
        .expect("cursor must decode");
        assert_eq!(filter.limit, 100);
        assert!(filter.cursor.is_some());
        assert!(decode_cursor::<ReviewQueueCursor>("not-a-cursor").is_err());
        assert!(
            queue_filter(QueueQuery {
                cursor: None,
                limit: Some(0)
            })
            .is_err()
        );
    }

    #[test]
    fn review_cursor_rejects_future_or_reversed_windows() {
        let now = OffsetDateTime::now_utc();
        for cursor in [
            ReviewQueueCursor {
                snapshot_at: now + Duration::minutes(2),
                submitted_at: now,
                submission_id: Uuid::new_v4(),
            },
            ReviewQueueCursor {
                snapshot_at: now,
                submitted_at: now + Duration::seconds(1),
                submission_id: Uuid::new_v4(),
            },
        ] {
            assert!(
                queue_filter(QueueQuery {
                    cursor: Some(encode_cursor(cursor).unwrap()),
                    limit: None,
                })
                .is_err()
            );
        }
    }

    #[test]
    fn moderation_cursor_round_trips_and_rejects_reversed_windows() {
        let now = OffsetDateTime::now_utc();
        let cursor = ModerationQueueCursor {
            snapshot_at: now,
            created_at: now - Duration::seconds(1),
            case_id: Uuid::new_v4(),
        };
        let filter = moderation_queue_filter(QueueQuery {
            cursor: Some(encode_cursor(cursor).unwrap()),
            limit: Some(100),
        })
        .unwrap();
        assert_eq!(filter.limit, 100);
        assert!(filter.cursor.is_some());
        let reversed = ModerationQueueCursor {
            snapshot_at: now,
            created_at: now + Duration::seconds(1),
            case_id: Uuid::new_v4(),
        };
        assert!(
            moderation_queue_filter(QueueQuery {
                cursor: Some(encode_cursor(reversed).unwrap()),
                limit: None,
            })
            .is_err()
        );
    }
}
