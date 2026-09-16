//! Standalone gateway HTTP host: compose with PolicyGateway and a separately administered journal.
//! Bind only behind authenticated TLS ingress; never expose this HTTP listener directly.
use crate::{
    B256, Error, Result,
    signing::{SignRequest, SigningGateway},
};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::json;
use std::{collections::BTreeSet, sync::Arc};
use uuid::Uuid;

pub struct GatewayAccess {
    token_digest: B256,
    allowed_corps: BTreeSet<Uuid>,
}
impl GatewayAccess {
    pub fn new(token: &[u8], allowed_corps: BTreeSet<Uuid>) -> Result<Self> {
        if token.len() < 32
            || token.len() > 8192
            || allowed_corps.is_empty()
            || allowed_corps.len() > 128
            || allowed_corps.contains(&Uuid::nil())
        {
            return Err(Error::Config(
                "gateway needs strong workload credential and explicit Corp scope",
            ));
        }
        Ok(Self {
            token_digest: B256::from(*blake3::hash(token).as_bytes()),
            allowed_corps,
        })
    }
    fn accepts(&self, headers: &HeaderMap) -> bool {
        let Some(header) = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
        else {
            return false;
        };
        if header.len() > 8192 {
            return false;
        }
        let hash = blake3::hash(header.as_bytes());
        hash.as_bytes()
            .iter()
            .zip(self.token_digest.as_slice())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
    }
}
struct GatewayState {
    gateway: Arc<dyn SigningGateway>,
    access: GatewayAccess,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    id: u64,
    method: String,
    params: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotQuery {
    chain_id: u64,
    publisher: crate::Address,
}
enum Operation {
    Sign(SignRequest),
    Lookup(SignRequest),
    Identity,
    Snapshot(SnapshotQuery),
}

pub fn router(gateway: Arc<dyn SigningGateway>, access: GatewayAccess) -> Router {
    Router::new()
        .route("/", post(handle))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .with_state(Arc::new(GatewayState { gateway, access }))
}

async fn handle(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !state.access.accepts(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let request: Request = match crony_audit::parse_json(&body) {
        Ok(r) => r,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    if request.jsonrpc != "2.0" {
        return StatusCode::FORBIDDEN.into_response();
    }
    let operation = match request.method.as_str() {
        "ecorp_signAttempt" | "ecorp_lookupAttempt" => {
            let [sign]: [SignRequest; 1] = match serde_json::from_value(request.params) {
                Ok(p) => p,
                Err(_) => return StatusCode::BAD_REQUEST.into_response(),
            };
            if !state.access.allowed_corps.contains(&sign.corp_id) {
                return StatusCode::FORBIDDEN.into_response();
            }
            if request.method == "ecorp_signAttempt" {
                Operation::Sign(sign)
            } else {
                Operation::Lookup(sign)
            }
        }
        "ecorp_gatewayIdentity" if request.params == json!([]) => Operation::Identity,
        "ecorp_journalSnapshot" => {
            let [query]: [SnapshotQuery; 1] = match serde_json::from_value(request.params) {
                Ok(p) => p,
                Err(_) => return StatusCode::BAD_REQUEST.into_response(),
            };
            Operation::Snapshot(query)
        }
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    let call = async {
        let signed_json = |signed: crate::signing::SignedTransaction| {
            json!({
                "raw_transaction":crate::Bytes::copy_from_slice(signed.raw()),"transaction_hash":signed.hash()
            })
        };
        match operation {
            Operation::Sign(sign) => state.gateway.sign(&sign).await.map(signed_json),
            Operation::Lookup(sign) => state
                .gateway
                .lookup(&sign)
                .await
                .map(|result| result.map(signed_json).unwrap_or(serde_json::Value::Null)),
            Operation::Identity => serde_json::to_value(state.gateway.identity().await?)
                .map_err(|_| Error::Signing("gateway identity encoding failed")),
            Operation::Snapshot(query) => {
                let snapshot = state
                    .gateway
                    .journal_snapshot(query.chain_id, query.publisher)
                    .await?;
                if snapshot
                    .requests
                    .iter()
                    .any(|r| !state.access.allowed_corps.contains(&r.corp_id))
                {
                    return Err(Error::Signing("journal wallet spans unauthorized Corps"));
                }
                serde_json::to_value(snapshot)
                    .map_err(|_| Error::Signing("journal snapshot encoding failed"))
            }
        }
    };
    let response = match tokio::time::timeout(std::time::Duration::from_secs(60), call).await {
        Ok(Ok(result)) => {
            json!({"jsonrpc":"2.0","id":request.id,"result":result})
        }
        Ok(Err(_)) | Err(_) => {
            json!({"jsonrpc":"2.0","id":request.id,"error":{"code":-32000,"message":"signing denied or unresolved; reconcile immutable attempt"}})
        }
    };
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(response),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Address,
        abi::AnchorCall,
        signing::{FrozenTransaction, SignedTransaction},
    };
    use async_trait::async_trait;
    struct UnavailableGateway;
    #[async_trait]
    impl SigningGateway for UnavailableGateway {
        async fn identity(&self) -> Result<crate::signing::GatewayIdentity> {
            Ok(crate::signing::GatewayIdentity {
                chain_id: 8453,
                publisher: Address::repeat_byte(1),
                immutable_key_identity: "fixture-key".into(),
            })
        }
        async fn journal_snapshot(
            &self,
            _: u64,
            _: Address,
        ) -> Result<crate::signing::JournalSnapshot> {
            Err(Error::Signing("journal unavailable"))
        }
        async fn sign(&self, _: &SignRequest) -> Result<SignedTransaction> {
            Err(Error::Signing("journal unavailable"))
        }
        async fn lookup(&self, _: &SignRequest) -> Result<Option<SignedTransaction>> {
            Err(Error::Signing("journal unavailable"))
        }
    }
    fn request(corp_id: Uuid) -> SignRequest {
        SignRequest {
            attempt_id: Uuid::from_u128(1),
            intent_id: Uuid::from_u128(2),
            corp_id,
            manifest_digest: B256::repeat_byte(1),
            immutable_key_identity: "fixture-key".into(),
            transaction: FrozenTransaction {
                chain_id: 8453,
                sender: Address::repeat_byte(1),
                contract: Address::repeat_byte(2),
                nonce: 0,
                gas_limit: 80_000,
                max_fee_per_gas: 10,
                max_priority_fee_per_gas: 1,
                call: AnchorCall {
                    stream_id: B256::repeat_byte(3),
                    sequence: 1,
                    checkpoint_digest: B256::repeat_byte(4),
                    previous_anchor_digest: B256::ZERO,
                },
            },
        }
    }
    #[tokio::test]
    async fn gateway_enforces_workload_auth_corp_scope_and_reports_journal_failure() {
        let token = "fixture-workload-token-at-least-32-bytes";
        let corp = Uuid::from_u128(3);
        let state = Arc::new(GatewayState {
            gateway: Arc::new(UnavailableGateway),
            access: GatewayAccess::new(token.as_bytes(), BTreeSet::from([corp])).unwrap(),
        });
        let body = Bytes::from(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"ecorp_signAttempt","params":[request(corp)]})).unwrap());
        assert_eq!(
            handle(State(state.clone()), HeaderMap::new(), body.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let foreign = Bytes::from(serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"ecorp_signAttempt","params":[request(Uuid::from_u128(4))]})).unwrap());
        assert_eq!(
            handle(State(state.clone()), headers.clone(), foreign)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let response = handle(State(state), headers, body).await;
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(json.get("error").is_some());
        assert!(json.get("result").is_none());
        assert!(
            !String::from_utf8(bytes.to_vec())
                .unwrap()
                .contains("raw_transaction")
        );
    }
    #[test]
    fn gateway_refuses_short_or_unscoped_workload_credentials() {
        assert!(GatewayAccess::new(b"short", BTreeSet::from([Uuid::from_u128(1)])).is_err());
        assert!(GatewayAccess::new(&[42; 32], BTreeSet::new()).is_err());
    }
}
