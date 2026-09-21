#![cfg(all(
    feature = "gateway-service",
    feature = "test-support",
    debug_assertions
))]

use crony_base::{
    Address, B256, Error, Result,
    abi::AnchorCall,
    gateway::{GatewayAccess, router},
    rpc::{EndpointPolicy, EndpointSecret, EndpointSecrets, HttpSigningGateway},
    signing::{
        FrozenTransaction, GatewayIdentity, JournalSnapshot, SignRequest, SignedTransaction,
        SigningGateway,
    },
};
use std::sync::Arc;
use uuid::Uuid;

struct ReadOnlyFixture(SignRequest);
#[async_trait::async_trait]
impl SigningGateway for ReadOnlyFixture {
    async fn identity(&self) -> Result<GatewayIdentity> {
        Ok(GatewayIdentity {
            chain_id: 84532,
            publisher: self.0.transaction.sender,
            immutable_key_identity: self.0.immutable_key_identity.clone(),
        })
    }
    async fn journal_snapshot(&self, chain_id: u64, publisher: Address) -> Result<JournalSnapshot> {
        let snapshot = JournalSnapshot {
            epoch: "11111111-1111-4111-8111-111111111111".into(),
            cursor: 1,
            requests: vec![self.0.clone()],
            complete: true,
        };
        snapshot.validate(chain_id, publisher)?;
        Ok(snapshot)
    }
    async fn sign(&self, _: &SignRequest) -> Result<SignedTransaction> {
        Err(Error::Signing("read-only transport fixture does not sign"))
    }
    async fn lookup(&self, _: &SignRequest) -> Result<Option<SignedTransaction>> {
        Ok(None)
    }
}
struct Secrets {
    url: String,
    token: String,
}
#[async_trait::async_trait]
impl EndpointSecrets for Secrets {
    async fn resolve(&self, _: &str) -> Result<EndpointSecret> {
        Ok(EndpointSecret {
            url: self.url.clone(),
            bearer: Some(self.token.clone()),
        })
    }
}

#[tokio::test]
async fn unavailable_gateway_fails_closed_without_disclosing_endpoint_or_credential() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let secrets = Secrets {
        url: format!("http://{address}/synthetic-private-endpoint"),
        token: "synthetic-unavailable-gateway-token-00001".into(),
    };
    let gateway = HttpSigningGateway::connect_test_loopback("fixture", "fixture", &secrets)
        .await
        .unwrap();
    let error = gateway
        .identity()
        .await
        .expect_err("absent gateway must not qualify");
    assert!(matches!(error, Error::Rpc(_)));
    let message = error.to_string();
    assert!(!message.contains("synthetic-private-endpoint"));
    assert!(!message.contains(&secrets.token));
    assert!(!message.contains(&address.to_string()));
}

#[tokio::test]
async fn actual_client_and_router_authenticate_identity_and_nonempty_scoped_journal() {
    let corp = Uuid::new_v4();
    let request = SignRequest {
        attempt_id: Uuid::new_v4(),
        intent_id: Uuid::new_v4(),
        corp_id: corp,
        manifest_digest: B256::repeat_byte(1),
        immutable_key_identity: "fixture-key".into(),
        transaction: FrozenTransaction {
            chain_id: 84532,
            sender: Address::repeat_byte(1),
            contract: Address::repeat_byte(2),
            nonce: 0,
            gas_limit: 100000,
            max_fee_per_gas: 100,
            max_priority_fee_per_gas: 1,
            call: AnchorCall {
                stream_id: B256::repeat_byte(2),
                sequence: 1,
                checkpoint_digest: B256::repeat_byte(3),
                previous_anchor_digest: B256::ZERO,
            },
        },
    };
    let token = "synthetic-transport-only-token-000000000001";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(
        Arc::new(ReadOnlyFixture(request.clone())),
        GatewayAccess::new(token.as_bytes(), [corp].into()).unwrap(),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let secrets = Secrets {
        url: format!("http://{address}"),
        token: token.into(),
    };
    let gateway = HttpSigningGateway::connect_test_loopback("fixture", "fixture", &secrets)
        .await
        .unwrap();
    let identity = gateway.identity().await.unwrap();
    assert_eq!(identity.publisher, request.transaction.sender);
    assert_eq!(
        gateway
            .journal_snapshot(84532, identity.publisher)
            .await
            .unwrap()
            .requests,
        vec![request.clone()]
    );
    assert!(
        gateway
            .journal_snapshot(8453, identity.publisher)
            .await
            .is_err()
    );
    assert!(gateway.sign(&request).await.is_err());
    let wrong = Secrets {
        url: secrets.url,
        token: "synthetic-wrong-token-000000000000000000".into(),
    };
    let denied = HttpSigningGateway::connect(
        "fixture",
        "fixture",
        &wrong,
        EndpointPolicy::test_only_loopback(address).unwrap(),
    )
    .await
    .unwrap();
    assert!(denied.identity().await.is_err());
    server.abort();
}
