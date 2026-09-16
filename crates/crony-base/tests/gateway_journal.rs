use alloy::{
    consensus::{SignableTransaction, TxEnvelope},
    eips::eip2718::Encodable2718,
    network::TxSigner,
    signers::local::PrivateKeySigner,
};
use crony_base::{
    Address, B256,
    abi::AnchorCall,
    signing::{
        FrozenTransaction, PostgresSigningJournal, SignRequest, SignedTransaction, SigningJournal,
    },
};
use uuid::Uuid;

fn request(sender: Address) -> SignRequest {
    SignRequest {
        attempt_id: Uuid::from_u128(1),
        intent_id: Uuid::from_u128(2),
        corp_id: Uuid::from_u128(3),
        manifest_digest: B256::repeat_byte(1),
        immutable_key_identity: "fixture-key".into(),
        transaction: FrozenTransaction {
            chain_id: 8453,
            sender,
            contract: Address::repeat_byte(1),
            nonce: 0,
            gas_limit: 80_000,
            max_fee_per_gas: 10,
            max_priority_fee_per_gas: 1,
            call: AnchorCall {
                stream_id: B256::repeat_byte(2),
                sequence: 1,
                checkpoint_digest: B256::repeat_byte(3),
                previous_anchor_digest: B256::ZERO,
            },
        },
    }
}

/// Opt in only with DATABASE_URL pointing to an explicitly owned local QA maintenance database.
#[sqlx::test]
#[ignore = "requires explicitly authorized isolated PostgreSQL fixture"]
async fn gateway_journal_is_immutable_and_recovers_after_process_loss(pool: sqlx::PgPool) {
    sqlx::raw_sql(include_str!("../gateway-journal.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let journal = PostgresSigningJournal::new(pool.clone());
    let signer: PrivateKeySigner =
        "1111111111111111111111111111111111111111111111111111111111111111"
            .parse()
            .unwrap();
    let request = request(signer.address());
    let empty = journal.snapshot(8453, signer.address()).await.unwrap();
    assert!(empty.complete && empty.requests.is_empty());
    journal.freeze(&request).await.unwrap();
    assert!(journal.lookup(&request).await.unwrap().is_none());
    let mut changed = request.clone();
    changed.transaction.nonce = 1;
    assert!(journal.freeze(&changed).await.is_err());
    let mut tx = request.transaction.unsigned().unwrap();
    let sig = signer.sign_transaction(&mut tx).await.unwrap();
    let raw = TxEnvelope::Eip1559(tx.into_signed(sig)).encoded_2718();
    let signed = SignedTransaction::validate(&request, &raw).unwrap();
    let (first, second) = tokio::join!(
        journal.commit(&request, &signed),
        journal.commit(&request, &signed)
    );
    assert_eq!(first.unwrap(), second.unwrap());
    drop(journal);
    let restored_gateway = PostgresSigningJournal::new(pool.clone());
    assert_eq!(
        restored_gateway.lookup(&request).await.unwrap().unwrap(),
        signed
    );
    let snapshot = restored_gateway
        .snapshot(8453, signer.address())
        .await
        .unwrap();
    assert!(snapshot.complete && snapshot.cursor > empty.cursor);
    assert_eq!(snapshot.epoch, empty.epoch);
    assert_eq!(snapshot.requests, vec![request]);
    assert!(
        sqlx::query("DELETE FROM base_gateway_results")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE base_gateway_attempts SET request='{}'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("TRUNCATE base_gateway_results")
            .execute(&pool)
            .await
            .is_err()
    );
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM base_gateway_results")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attempts, 1);
}
