//! Native SDK wire fixtures only: no live AWS credentials, network, or customer KMS qualification.
use alloy::{
    consensus::SignableTransaction, signers::SignerSync, signers::local::PrivateKeySigner,
};
use aws_sdk_kms::config::{BehaviorVersion, Credentials, Region, retry::RetryConfig};
use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient, capture_request};
use aws_smithy_types::body::SdkBody;
use axum::http::{Request, Response};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use crony_base::{
    Address, B256,
    abi::AnchorCall,
    kms::AwsKmsSigner,
    signing::{FrozenTransaction, NonExportableSigner, SignRequest, SignedTransaction},
};
use k256::pkcs8::EncodePublicKey;
use serde_json::{Value, json};
use uuid::Uuid;

const KEY_ARN: &str = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111";
const BAD_REGIONS: &[&str] = &[
    "us-east-1.invalid/#",
    "us-east-1@attacker.invalid",
    "us-east-1/../../",
    "us-east-1?redirect=invalid",
];

#[allow(deprecated, reason = "Exercise the gateway's existing behavior pin")]
fn behavior() -> BehaviorVersion {
    BehaviorVersion::v2025_01_17()
}

fn credentials() -> Credentials {
    Credentials::new(
        "local-test-access-key",
        "local-test-secret-key",
        Some("local-test-session-token".into()),
        None,
        "synthetic-wire-fixture",
    )
}

#[tokio::test]
async fn kms_rejects_region_uri_injection_before_transport() {
    for region in BAD_REGIONS {
        for explicit_endpoint in [false, true] {
            let (transport, capture) = capture_request(None);
            let mut config = aws_sdk_kms::Config::builder()
                .behavior_version(behavior())
                .region(Region::new(*region))
                .credentials_provider(credentials())
                .retry_config(RetryConfig::standard().with_max_attempts(1))
                .http_client(transport);
            if explicit_endpoint {
                config = config.endpoint_url("https://kms.us-east-1.amazonaws.com");
            }
            let error = aws_sdk_kms::Client::from_conf(config.build())
                .describe_key()
                .key_id(KEY_ARN)
                .send()
                .await
                .unwrap_err();
            let diagnostic = aws_sdk_kms::error::DisplayErrorContext(&error).to_string();
            assert!(
                diagnostic.contains("must be a valid host label"),
                "{diagnostic}"
            );
            capture.expect_no_request();
        }
    }
}

#[tokio::test]
async fn sts_rejects_region_uri_injection_before_transport() {
    for region in BAD_REGIONS {
        let (transport, capture) = capture_request(None);
        let config = aws_sdk_sts::Config::builder()
            .behavior_version(behavior())
            .region(Region::new(*region))
            .credentials_provider(credentials())
            .retry_config(RetryConfig::standard().with_max_attempts(1))
            .http_client(transport)
            .build();
        let error = aws_sdk_sts::Client::from_conf(config)
            .assume_role()
            .role_arn("arn:aws:iam::123456789012:role/local-test")
            .role_session_name("local-test")
            .send()
            .await
            .unwrap_err();
        let diagnostic = aws_sdk_sts::error::DisplayErrorContext(&error).to_string();
        assert!(
            diagnostic.contains("must be a valid host label"),
            "{diagnostic}"
        );
        capture.expect_no_request();
    }
}

#[tokio::test]
async fn sts_native_query_signing_and_xml_response_remain_compatible() {
    let response = Response::builder().status(200).body(SdkBody::from(
        r#"<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
        <AssumeRoleResult><Credentials><AccessKeyId>synthetic-result-id</AccessKeyId>
        <SecretAccessKey>synthetic-result-secret</SecretAccessKey><SessionToken>synthetic-result-token</SessionToken>
        <Expiration>2035-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult>
        <ResponseMetadata><RequestId>synthetic-request</RequestId></ResponseMetadata></AssumeRoleResponse>"#,
    )).unwrap();
    let (transport, capture) = capture_request(Some(response));
    let config = aws_sdk_sts::Config::builder()
        .behavior_version(behavior())
        .region(Region::new("us-east-1"))
        .credentials_provider(credentials())
        .http_client(transport)
        .build();
    let result = aws_sdk_sts::Client::from_conf(config)
        .assume_role()
        .role_arn("arn:aws:iam::123456789012:role/local-test")
        .role_session_name("local-test")
        .send()
        .await
        .unwrap();
    assert_eq!(
        result.credentials.unwrap().access_key_id(),
        "synthetic-result-id"
    );
    let request = capture.expect_request();
    assert_eq!(request.method(), "POST");
    assert_eq!(request.uri(), "https://sts.us-east-1.amazonaws.com/");
    let authorization = request.headers().get("authorization").unwrap();
    assert!(authorization.contains("Credential=local-test-access-key/"));
    assert!(authorization.contains("/us-east-1/sts/aws4_request"));
    let form: std::collections::BTreeMap<_, _> =
        url::form_urlencoded::parse(request.body().bytes().unwrap()).collect();
    assert_eq!(form.len(), 4);
    assert_eq!(form["Action"], "AssumeRole");
    assert_eq!(form["Version"], "2011-06-15");
    assert_eq!(form["RoleArn"], "arn:aws:iam::123456789012:role/local-test");
    assert_eq!(form["RoleSessionName"], "local-test");
}

fn kms_event(operation: &str, request: Value, response: Value) -> ReplayEvent {
    ReplayEvent::new(
        Request::builder()
            .method("POST")
            .uri("https://kms.us-east-1.amazonaws.com/")
            .header("content-type", "application/x-amz-json-1.1")
            .header("x-amz-target", format!("TrentService.{operation}"))
            .body(SdkBody::from(request.to_string()))
            .unwrap(),
        Response::builder()
            .status(200)
            .header("content-type", "application/x-amz-json-1.1")
            .body(SdkBody::from(response.to_string()))
            .unwrap(),
    )
}

fn kms_client(transport: &StaticReplayClient) -> aws_sdk_kms::Client {
    aws_sdk_kms::Client::from_conf(
        aws_sdk_kms::Config::builder()
            .behavior_version(behavior())
            .region(Region::new("us-east-1"))
            .endpoint_url("https://kms.us-east-1.amazonaws.com")
            .credentials_provider(credentials())
            .retry_config(RetryConfig::standard().with_max_attempts(1))
            .http_client(transport.clone())
            .build(),
    )
}

fn metadata() -> Value {
    json!({"KeyMetadata": {
        "KeyId": "11111111-1111-4111-8111-111111111111", "Arn": KEY_ARN,
        "KeySpec": "ECC_SECG_P256K1", "KeyUsage": "SIGN_VERIFY",
        "Origin": "AWS_KMS", "KeyState": "Enabled"
    }})
}

fn public_key_event(signer: &PrivateKeySigner) -> ReplayEvent {
    let public_key = k256::PublicKey::from(signer.credential().verifying_key());
    let der = public_key.to_public_key_der().unwrap();
    kms_event(
        "GetPublicKey",
        json!({"KeyId": KEY_ARN}),
        json!({
            "KeyId": KEY_ARN, "PublicKey": STANDARD.encode(der.as_bytes()),
            "KeySpec": "ECC_SECG_P256K1", "KeyUsage": "SIGN_VERIFY",
            "SigningAlgorithms": ["ECDSA_SHA_256"]
        }),
    )
}

#[tokio::test]
async fn native_kms_signer_preserves_frozen_digest_and_transaction_binding() {
    // Synthetic local key is used only to construct a KMS wire response; never a production fallback.
    let fixture_signer = PrivateKeySigner::from_bytes(&B256::repeat_byte(0x11)).unwrap();
    let request = SignRequest {
        attempt_id: Uuid::from_u128(1),
        intent_id: Uuid::from_u128(2),
        corp_id: Uuid::from_u128(3),
        manifest_digest: B256::repeat_byte(8),
        immutable_key_identity: KEY_ARN.into(),
        transaction: FrozenTransaction {
            chain_id: 84532,
            sender: fixture_signer.address(),
            contract: Address::repeat_byte(1),
            nonce: 3,
            gas_limit: 80_000,
            max_fee_per_gas: 10,
            max_priority_fee_per_gas: 1,
            call: AnchorCall {
                stream_id: B256::repeat_byte(2),
                sequence: 19,
                checkpoint_digest: B256::repeat_byte(3),
                previous_anchor_digest: B256::ZERO,
            },
        },
    };
    let unsigned = request.transaction.unsigned().unwrap();
    let digest = unsigned.signature_hash();
    let signature = fixture_signer
        .sign_hash_sync(&digest)
        .unwrap()
        .to_k256()
        .unwrap()
        .to_der();
    let transport = StaticReplayClient::new(vec![
        kms_event("DescribeKey", json!({"KeyId": KEY_ARN}), metadata()),
        public_key_event(&fixture_signer),
        kms_event(
            "Sign",
            json!({"KeyId": KEY_ARN, "Message": STANDARD.encode(digest),
            "MessageType": "DIGEST", "SigningAlgorithm": "ECDSA_SHA_256"}),
            json!({"KeyId": KEY_ARN, "Signature": STANDARD.encode(signature.as_bytes()),
                "SigningAlgorithm": "ECDSA_SHA_256"}),
        ),
    ]);
    let signer = AwsKmsSigner::connect(
        kms_client(&transport),
        KEY_ARN.into(),
        84532,
        fixture_signer.address(),
    )
    .await
    .unwrap();
    let raw = signer.sign_transaction(unsigned).await.unwrap();
    SignedTransaction::validate(&request, &raw).unwrap();
    let mut changed = request.clone();
    changed.transaction.nonce += 1;
    assert!(SignedTransaction::validate(&changed, &raw).is_err());
    changed = request.clone();
    changed.transaction.sender = Address::repeat_byte(0x22);
    assert!(SignedTransaction::validate(&changed, &raw).is_err());
    transport.assert_requests_match(&[]);
    assert_eq!(transport.actual_requests().count(), 3);
    for sent in transport.actual_requests() {
        assert_eq!(sent.method(), "POST");
        assert!(
            sent.headers()
                .get("authorization")
                .unwrap()
                .contains("/us-east-1/kms/aws4_request")
        );
    }
}

#[tokio::test]
async fn kms_identity_or_publisher_mismatch_stops_before_signing() {
    let fixture_signer = PrivateKeySigner::from_bytes(&B256::repeat_byte(0x11)).unwrap();
    for (field, value) in [
        ("Arn", "arn:aws:kms:us-east-1:123456789012:key/other"),
        ("KeySpec", "ECC_NIST_P256"),
        ("KeyUsage", "ENCRYPT_DECRYPT"),
        ("Origin", "EXTERNAL"),
        ("KeyState", "Disabled"),
    ] {
        let mut response = metadata();
        response["KeyMetadata"][field] = json!(value);
        let transport = StaticReplayClient::new(vec![kms_event(
            "DescribeKey",
            json!({"KeyId": KEY_ARN}),
            response,
        )]);
        let result = AwsKmsSigner::connect(
            kms_client(&transport),
            KEY_ARN.into(),
            84532,
            fixture_signer.address(),
        )
        .await;
        assert!(matches!(
            result,
            Err(crony_base::Error::Signing(
                "KMS key must be enabled non-exportable secp256k1 signing key"
            ))
        ));
        transport.assert_requests_match(&[]);
        assert_eq!(transport.actual_requests().count(), 1);
    }
    let transport = StaticReplayClient::new(vec![
        kms_event("DescribeKey", json!({"KeyId": KEY_ARN}), metadata()),
        public_key_event(&fixture_signer),
    ]);
    let result = AwsKmsSigner::connect(
        kms_client(&transport),
        KEY_ARN.into(),
        84532,
        Address::repeat_byte(0x22),
    )
    .await;
    assert!(matches!(
        result,
        Err(crony_base::Error::Signing("KMS publisher address mismatch"))
    ));
    transport.assert_requests_match(&[]);
    assert_eq!(transport.actual_requests().count(), 2);
}
