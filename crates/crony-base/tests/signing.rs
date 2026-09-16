use alloy::{consensus::SignableTransaction, network::TxSigner, signers::local::PrivateKeySigner};
use crony_base::{Address, B256, abi::AnchorCall, signing::*};
use uuid::Uuid;

fn request(sender: Address) -> SignRequest {
    SignRequest {
        attempt_id: Uuid::from_u128(1),
        intent_id: Uuid::from_u128(2),
        corp_id: Uuid::from_u128(3),
        manifest_digest: B256::repeat_byte(8),
        immutable_key_identity:
            "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111".into(),
        transaction: FrozenTransaction {
            chain_id: 8453,
            sender,
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
    }
}

#[tokio::test]
async fn signed_bytes_are_locally_hashed_and_semantically_bound() {
    let signer: PrivateKeySigner =
        "1111111111111111111111111111111111111111111111111111111111111111"
            .parse()
            .unwrap();
    let req = request(signer.address());
    let mut tx = req.transaction.unsigned().unwrap();
    let sig = signer.sign_transaction(&mut tx).await.unwrap();
    let signed = tx.into_signed(sig);
    use alloy::eips::eip2718::Encodable2718;
    let raw = alloy::consensus::TxEnvelope::Eip1559(signed).encoded_2718();
    let valid = SignedTransaction::validate(&req, &raw).unwrap();
    assert_eq!(valid.hash(), alloy::primitives::keccak256(&raw));
    let mut altered = req.clone();
    altered.transaction.nonce += 1;
    assert!(SignedTransaction::validate(&altered, &raw).is_err());
    let mut trailing = raw;
    trailing.push(0);
    assert!(SignedTransaction::validate(&req, &trailing).is_err());
}

#[test]
fn exact_wei_wire_never_uses_floating_point_or_truncates_u128() {
    let mut request = request(Address::repeat_byte(1));
    request.transaction.max_fee_per_gas = u128::MAX;
    let value = serde_json::to_value(&request).expect("all legal wei fields serialize exactly");
    assert_eq!(
        value["transaction"]["max_fee_per_gas"],
        u128::MAX.to_string()
    );
    let restored: SignRequest = serde_json::from_value(value).unwrap();
    assert_eq!(restored, request);
}
