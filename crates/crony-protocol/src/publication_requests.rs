use super::*;
use crony_domain::PullRequestPublicationPreview;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewHumanPublicationRequest {
    pub actor_id: Uuid,
    pub source_deliverable_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestHumanPublicationRequest {
    pub actor_id: Uuid,
    pub preview: PullRequestPublicationPreview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherQueueQuery {
    pub repository: String,
    pub after: Option<Uuid>,
    #[serde(default = "default_queue_limit")]
    pub limit: i64,
}

const fn default_queue_limit() -> i64 {
    25
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublisherQueueResponse {
    pub publisher_id: String,
    pub publication_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestedPublicationContextResponse {
    pub publisher_id: String,
    #[serde(flatten)]
    pub context: FactoryPublicationContextResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherRepositoryQuery {
    pub repository: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimRequestedPublicationRequest {
    pub repository: String,
    pub idempotency_key: String,
    #[serde(default = "default_publication_lease_seconds")]
    pub lease_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewRequestedPublicationRequest {
    pub repository: String,
    pub publisher_token: Uuid,
    pub expected_version: i64,
    pub idempotency_key: String,
    #[serde(default = "default_publication_lease_seconds")]
    pub lease_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestedPublicationCheckpointRequest {
    pub repository: String,
    pub publisher_token: Uuid,
    pub expected_version: i64,
    pub idempotency_key: String,
    pub checkpoint: PullRequestPublicationCheckpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestedPublicationArtifactRequest {
    pub repository: String,
    pub publisher_token: Uuid,
    pub expected_version: i64,
}
