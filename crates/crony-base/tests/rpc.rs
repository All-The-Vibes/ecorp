use crony_base::{B256, rpc::*};

#[test]
fn finality_requires_contiguous_parent_hashes_not_only_height() {
    let included = SealedHeader {
        number: 10,
        hash: B256::repeat_byte(1),
        parent_hash: B256::repeat_byte(2),
        timestamp: 100,
    };
    let finalized = SealedHeader {
        number: 12,
        hash: B256::repeat_byte(3),
        parent_hash: B256::repeat_byte(4),
        timestamp: 102,
    };
    let middle = SealedHeader {
        number: 11,
        hash: B256::repeat_byte(4),
        parent_hash: included.hash,
        timestamp: 101,
    };
    verify_ancestry(&included, &finalized, &[finalized.clone(), middle.clone()]).unwrap();
    let mut wrong = middle;
    wrong.parent_hash = B256::repeat_byte(9);
    assert!(verify_ancestry(&included, &finalized, &[finalized.clone(), wrong]).is_err());
    assert!(verify_ancestry(&included, &finalized, &[]).is_err());
}

#[test]
fn private_and_special_destinations_are_never_public_rpc() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
    ] {
        assert!(!public_rpc_ip(ip.parse().unwrap()), "{ip}");
    }
    assert!(public_rpc_ip("1.1.1.1".parse().unwrap()));
}
#[cfg(all(feature = "test-support", debug_assertions))]
#[tokio::test]
async fn test_loopback_policy_is_explicit_and_cannot_authorize_other_addresses() {
    use crony_base::rpc::{EndpointPolicy, EndpointSecret, EndpointSecrets, HttpRpc};
    struct Secrets;
    #[async_trait::async_trait]
    impl EndpointSecrets for Secrets {
        async fn resolve(&self, _: &str) -> crony_base::Result<EndpointSecret> {
            Ok(EndpointSecret {
                url: "http://127.0.0.1:18545".into(),
                bearer: None,
            })
        }
    }
    assert!(EndpointPolicy::test_only_loopback("10.0.0.1:18545".parse().unwrap()).is_err());
    assert!(EndpointPolicy::test_only_loopback("127.0.0.1:0".parse().unwrap()).is_err());
    let wrong_port =
        EndpointPolicy::test_only_loopback("127.0.0.1:18546".parse().unwrap()).unwrap();
    assert!(
        HttpRpc::connect("fixture", "fixture", &Secrets, wrong_port)
            .await
            .is_err()
    );
    let production = EndpointPolicy::production(["127.0.0.1".into()].into());
    assert!(
        HttpRpc::connect("fixture", "fixture", &Secrets, production)
            .await
            .is_err()
    );
    let test_policy =
        EndpointPolicy::test_only_loopback("127.0.0.1:18545".parse().unwrap()).unwrap();
    assert!(
        HttpRpc::connect("fixture", "fixture", &Secrets, test_policy)
            .await
            .is_ok()
    );
    assert!(
        HttpRpc::connect_test_loopback("fixture", "fixture", &Secrets)
            .await
            .is_ok()
    );
    assert!(
        HttpSigningGateway::connect_test_loopback("fixture", "fixture", &Secrets)
            .await
            .is_ok()
    );
}

#[cfg(all(feature = "test-support", debug_assertions))]
#[tokio::test]
#[ignore = "requires explicitly authorized local Anvil fixture; never public RPC"]
async fn test_only_policy_reads_actual_local_anvil_chain_and_registry() {
    use crony_base::rpc::{BlockTag, EndpointPolicy, EndpointSecret, EndpointSecrets, HttpRpc};
    struct Anvil;
    #[async_trait::async_trait]
    impl EndpointSecrets for Anvil {
        async fn resolve(&self, _: &str) -> crony_base::Result<EndpointSecret> {
            Ok(EndpointSecret {
                url: "http://127.0.0.1:18545".into(),
                bearer: None,
            })
        }
    }
    let policy = EndpointPolicy::test_only_loopback("127.0.0.1:18545".parse().unwrap()).unwrap();
    let rpc = HttpRpc::connect("local-anvil", "local-anvil", &Anvil, policy)
        .await
        .unwrap();
    assert_eq!(rpc.chain_id().await.unwrap(), 84532);
    let latest = rpc.block(BlockTag::Latest).await.unwrap();
    let code = rpc
        .code(
            "0x5fbdb2315678afecb367f032d93f642f64180aa3"
                .parse()
                .unwrap(),
            latest.hash,
        )
        .await
        .unwrap();
    assert_eq!(
        alloy::primitives::keccak256(code),
        "0xe2e734ff4a294b7c36ad6ab657267015538e28b16fcb5a3dc2ea89654e24c3cc"
            .parse::<crony_base::B256>()
            .unwrap()
    );
}
