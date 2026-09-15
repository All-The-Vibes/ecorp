use crony_base::{
    Address,
    signing::{GatewayIdentity, JournalSnapshot},
};

#[test]
fn identity_and_snapshot_require_immutable_scope_and_honest_completeness() {
    let identity = GatewayIdentity {
        chain_id: 8453,
        publisher: Address::repeat_byte(1),
        immutable_key_identity: "fixture-key".into(),
    };
    identity.validate().unwrap();
    let snapshot = JournalSnapshot {
        epoch: "11111111-1111-4111-8111-111111111111".into(),
        cursor: 0,
        requests: vec![],
        complete: true,
    };
    snapshot.validate(8453, identity.publisher).unwrap();
    let mut invalid = snapshot.clone();
    invalid.cursor = -1;
    assert!(invalid.validate(8453, identity.publisher).is_err());
    let mut invalid = snapshot.clone();
    invalid.epoch = String::new();
    assert!(invalid.validate(8453, identity.publisher).is_err());
    let mut invalid = identity;
    invalid.publisher = Address::ZERO;
    assert!(invalid.validate().is_err());
}
