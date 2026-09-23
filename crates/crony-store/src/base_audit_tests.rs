use super::*;
use anyhow::ensure;

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_finalized_incident_survives_observations_and_wallet_quarantine(
    pool: PgPool,
) -> Result<()> {
    check_terminal_incident(pool, "finalized_contradiction", false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_conflicting_incident_survives_observations_and_nonce_conflict(
    pool: PgPool,
) -> Result<()> {
    check_terminal_incident(pool, "conflicting_anchor", true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_invalid_evidence_survives_observations_and_wallet_quarantine(
    pool: PgPool,
) -> Result<()> {
    check_terminal_incident(pool, "invalid_evidence", false).await
}

async fn check_terminal_incident(pool: PgPool, incident: &str, nonce_conflict: bool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let first_claim = archived_claim(&store, &ids, &input).await?;
    let second = second_destination(&store, &ids, &input).await?;
    store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, second.id, Uuid::new_v4())
        .await?;
    let second_claim = store
        .claim_base_intent(ids.corp_id, second.id, Uuid::new_v4())
        .await?
        .context("second stream claim")?;
    let attempt = BaseAttempt {
        request: SignRequest {
            attempt_id: Uuid::new_v4(),
            intent_id: first_claim.intent.id,
            corp_id: ids.corp_id,
            manifest_digest: input.config.manifest_digest,
            immutable_key_identity: input.config.signer_key_identity.clone(),
            transaction: FrozenTransaction {
                chain_id: input.config.chain_id,
                sender: input.config.publisher,
                contract: input.config.contract_address,
                nonce: 0,
                gas_limit: 100_000,
                max_fee_per_gas: 5,
                max_priority_fee_per_gas: 1,
                call: crony_base::abi::AnchorCall {
                    stream_id: input.config.stream_id,
                    sequence: u64::try_from(first_claim.intent.sequence)?,
                    checkpoint_digest: first_claim.intent.checkpoint_digest.parse()?,
                    previous_anchor_digest: B256::ZERO,
                },
            },
        },
        ordinal: 0,
        created_at: Utc::now(),
        signed: None,
    };
    let (receipt, block) = receipt_fixture(
        &attempt,
        B256::repeat_byte(88),
        true,
        Some(U256::from(1000)),
    )?;
    let event = receipt.exact_event(
        input.config.contract_address,
        &attempt.request.transaction.call,
        input.config.publisher,
    )?;
    // Reproduce an already persisted integrity incident in the owned database.
    // A new valid checkpoint observation would otherwise advance the projection.
    sqlx::query("UPDATE base_audit_destinations SET status=$2,enabled=false,restore_required=true WHERE id=$1")
        .bind(input.id).bind(incident).execute(&store.pool).await?;
    assert_eq!(
        store
            .observe_base_event(ids.corp_id, input.id, &event, &receipt, &block)
            .await?,
        incident
    );
    let before = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(before.verified_sequence, 0);
    assert_eq!(before.observed_sequence, 0);
    let paused = store
        .control_base_destination(
            ids.corp_id,
            ids.alice_actor_id,
            input.id,
            before.version,
            false,
        )
        .await?;
    assert_eq!(paused.status, incident);
    assert!(
        store
            .control_base_destination(
                ids.corp_id,
                ids.alice_actor_id,
                input.id,
                paused.version,
                true
            )
            .await
            .is_err()
    );
    assert!(store.check_base_fence(&first_claim).await.is_err());
    assert!(
        store
            .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
            .await
            .is_err()
    );
    assert!(
        store
            .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
            .await?
            .is_none()
    );
    if nonce_conflict {
        let error = store
            .reserve_base_attempt(&second_claim, &quote(), U256::from(9_000_000), 9, false)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("unknown consumed nonce"));
    } else {
        store
            .quarantine_base_wallet(&second_claim, "nonce_conflict")
            .await?;
    }
    let replacement = SealedHeader {
        hash: B256::repeat_byte(99),
        ..block
    };
    store
        .record_base_reorg(ids.corp_id, input.id, event.block_hash, &replacement)
        .await?;
    assert!(
        store
            .complete_base_validation(
                ids.corp_id,
                input.id,
                BaseValidation {
                    epoch: "test-journal",
                    cursor: 0,
                    requests: &[],
                    pending_nonce: 0,
                    observation: &json!({}),
                }
            )
            .await
            .is_err()
    );
    let after = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(after.status, incident);
    assert_eq!(after.verified_sequence, before.verified_sequence);
    assert_eq!(after.verified_digest, before.verified_digest);
    assert_eq!(after.observed_sequence, before.observed_sequence);
    assert!(!after.enabled && after.restore_required);
    let retained: i64 = sqlx::query_scalar("SELECT count(*) FROM base_audit_evidence WHERE destination_id=$1 AND kind='observed_event'")
        .bind(input.id).fetch_one(&store.pool).await?;
    assert_eq!(retained, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_fee_enrichment_at_inclusion_is_monotonic(pool: PgPool) -> Result<()> {
    check_fee_enrichment(pool, false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_fee_enrichment_at_finality_is_atomic_and_replayable(pool: PgPool) -> Result<()> {
    check_fee_enrichment(pool, true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_terminal_fee_settlement_is_scoped_serialized_and_monotonic(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let signed = sign_fixture(&attempt).await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    let (missing, block) = receipt_fixture(&attempt, signed.hash(), false, None)?;
    let mut raw = missing.raw;
    raw["status"] = json!("0x0");
    let missing = ReceiptEvidence::parse(raw.clone())?;
    store
        .record_base_inclusion(&claim, &missing, &block)
        .await?;
    store
        .record_base_spend_finality(&claim, &missing, &block, &finality_fixture(&block))
        .await?;
    let evidence_id: i64 = sqlx::query_scalar(
        "SELECT id FROM base_audit_evidence WHERE intent_id=$1 AND kind='spend_finalized'",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(
        store
            .base_terminal_fee_receipts(ids.corp_id, input.id, &[evidence_id])
            .await?
            .len(),
        1
    );
    assert!(
        store
            .base_terminal_fee_receipts(Uuid::new_v4(), input.id, &[evidence_id])
            .await?
            .is_empty()
    );
    assert!(
        store
            .base_terminal_fee_receipts(ids.corp_id, input.id, &[evidence_id; 65])
            .await
            .is_err()
    );
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(i)-'settled'-'reservation'-'fee_warning' FROM base_audit_intents i WHERE id=$1")
        .bind(claim.intent.id).fetch_one(&store.pool).await?;
    let lane: Value = sqlx::query_scalar(
        "SELECT to_jsonb(l) FROM base_audit_sender_lanes l WHERE chain_id=$1 AND sender=$2",
    )
    .bind(i64::try_from(input.config.chain_id)?)
    .bind(input.config.publisher.as_slice())
    .fetch_one(&store.pool)
    .await?;
    raw["l1Fee"] = json!("0x3e8");
    let known = ReceiptEvidence::parse(raw.clone())?;
    assert!(
        store
            .reconcile_base_terminal_fee(Uuid::new_v4(), input.id, evidence_id, &known, &block)
            .await
            .is_err()
    );
    assert!(
        store
            .reconcile_base_terminal_fee(ids.corp_id, Uuid::new_v4(), evidence_id, &known, &block)
            .await
            .is_err()
    );
    assert!(
        store
            .reconcile_base_terminal_fee(ids.corp_id, input.id, -1, &known, &block)
            .await
            .is_err()
    );
    assert!(
        store
            .reconcile_base_terminal_fee(ids.corp_id, input.id, evidence_id, &missing, &block)
            .await
            .is_err()
    );
    // Accounting must serialize with signing/budget admission on the same wallet.
    let mut holder = store.pool.begin().await?;
    sqlx::query(
        "SELECT chain_id FROM base_audit_sender_lanes WHERE chain_id=$1 AND sender=$2 FOR UPDATE",
    )
    .bind(i64::try_from(input.config.chain_id)?)
    .bind(input.config.publisher.as_slice())
    .execute(&mut *holder)
    .await?;
    let writer = store.clone();
    let receipt = known.clone();
    let header = block.clone();
    let mut settlement = tokio::spawn(async move {
        writer
            .reconcile_base_terminal_fee(ids.corp_id, input.id, evidence_id, &receipt, &header)
            .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut settlement)
            .await
            .is_err()
    );
    holder.commit().await?;
    settlement.await??;
    let (first, second) = tokio::join!(
        store.reconcile_base_terminal_fee(ids.corp_id, input.id, evidence_id, &known, &block),
        store.reconcile_base_terminal_fee(ids.corp_id, input.id, evidence_id, &known, &block),
    );
    first?;
    second?;
    for (field, value) in [
        ("l1Fee", json!("0x3e9")),
        ("gasUsed", json!("0x2711")),
        ("status", json!("0x1")),
        ("transactionHash", json!(B256::repeat_byte(99))),
    ] {
        let mut changed = raw.clone();
        changed[field] = value;
        assert!(
            store
                .reconcile_base_terminal_fee(
                    ids.corp_id,
                    input.id,
                    evidence_id,
                    &ReceiptEvidence::parse(changed)?,
                    &block
                )
                .await
                .is_err(),
            "{field}"
        );
    }
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(i)-'settled'-'reservation'-'fee_warning' FROM base_audit_intents i WHERE id=$1")
        .bind(claim.intent.id).fetch_one(&store.pool).await?;
    assert_eq!(before, after, "only accounting columns may change");
    let after_lane: Value = sqlx::query_scalar(
        "SELECT to_jsonb(l) FROM base_audit_sender_lanes l WHERE chain_id=$1 AND sender=$2",
    )
    .bind(i64::try_from(input.config.chain_id)?)
    .bind(input.config.publisher.as_slice())
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(lane, after_lane);
    let account: (String, String, bool) = sqlx::query_as(
        "SELECT settled::text,reservation::text,fee_warning FROM base_audit_intents WHERE id=$1",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(account, ("51000".into(), "0".into(), false));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM base_audit_evidence WHERE intent_id=$1 AND kind='inclusion_fee_enriched'")
        .bind(claim.intent.id).fetch_one(&store.pool).await?;
    assert_eq!(count, 1);
    // Destination is still enabled/validated: rejection must come from terminal authority.
    assert!(
        store
            .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
            .await?
            .is_none()
    );
    assert!(store.check_base_fence(&claim).await.is_err());
    assert!(
        store
            .authorized_base_attempt(ids.corp_id, attempt.request.attempt_id)
            .await
            .is_err()
    );
    assert!(
        store
            .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 1, false)
            .await
            .is_err()
    );
    sqlx::query("UPDATE base_audit_destinations SET status='finalized_contradiction',enabled=false,restore_required=true WHERE id=$1")
        .bind(input.id).execute(&store.pool).await?;
    assert!(
        store
            .reconcile_base_terminal_fee(ids.corp_id, input.id, evidence_id, &known, &block)
            .await
            .is_err()
    );
    Ok(())
}

async fn check_fee_enrichment(pool: PgPool, at_finality: bool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let signed = sign_fixture(&attempt).await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    let (missing, block) = receipt_fixture(&attempt, signed.hash(), true, None)?;
    store
        .record_base_inclusion(&claim, &missing, &block)
        .await?;
    let initial: (String, String, bool) = sqlx::query_as(
        "SELECT settled::text,reservation::text,fee_warning FROM base_audit_intents WHERE id=$1",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(initial, ("50000".into(), "570000".into(), true));
    let original: Value = sqlx::query_scalar(
        "SELECT evidence FROM base_audit_evidence WHERE intent_id=$1 AND kind='inclusion'",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    let (known, _) = receipt_fixture(&attempt, signed.hash(), true, Some(U256::from(1000)))?;
    if at_finality {
        // A first finalized observation can still lack L1 metadata. A resumed
        // worker must accept enrichment without rewriting that original proof.
        store
            .record_base_spend_finality(&claim, &missing, &block, &finality_fixture(&block))
            .await?;
        store
            .record_base_spend_finality(&claim, &known, &block, &finality_fixture(&block))
            .await?;
    } else {
        store.record_base_inclusion(&claim, &known, &block).await?;
    }
    store.record_base_inclusion(&claim, &known, &block).await?;
    store
        .record_base_inclusion(&claim, &missing, &block)
        .await?;
    store
        .record_base_spend_finality(&claim, &known, &block, &finality_fixture(&block))
        .await?;
    store
        .record_base_spend_finality(&claim, &missing, &block, &finality_fixture(&block))
        .await?;
    let settled: (String, String, bool) = sqlx::query_as(
        "SELECT settled::text,reservation::text,fee_warning FROM base_audit_intents WHERE id=$1",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(settled, ("51000".into(), "0".into(), false));
    let replayed: Value = sqlx::query_scalar(
        "SELECT evidence FROM base_audit_evidence WHERE intent_id=$1 AND kind='inclusion'",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(original, replayed);
    let counts: (i64, i64) = sqlx::query_as("SELECT count(*) FILTER(WHERE kind='inclusion_fee_enriched'),count(*) FILTER(WHERE kind='spend_finalized') FROM base_audit_evidence WHERE intent_id=$1")
        .bind(claim.intent.id).fetch_one(&store.pool).await?;
    assert_eq!(counts, (1, 1));
    let (changed_fee, _) = receipt_fixture(&attempt, signed.hash(), true, Some(U256::from(1001)))?;
    assert!(
        store
            .record_base_inclusion(&claim, &changed_fee, &block)
            .await
            .is_err()
    );
    let mut raw = known.raw.clone();
    raw["gasUsed"] = json!("0x2711");
    assert!(
        store
            .record_base_inclusion(&claim, &ReceiptEvidence::parse(raw)?, &block)
            .await
            .is_err()
    );
    let event = missing.exact_event(
        input.config.contract_address,
        &attempt.request.transaction.call,
        input.config.publisher,
    )?;
    store
        .observe_base_event(ids.corp_id, input.id, &event, &missing, &block)
        .await?;
    store
        .observe_base_event(ids.corp_id, input.id, &event, &known, &block)
        .await?;
    store
        .observe_base_event(ids.corp_id, input.id, &event, &missing, &block)
        .await?;
    let observations: Vec<(String, Value)> = sqlx::query_as("SELECT kind,evidence->'receipt' FROM base_audit_evidence WHERE destination_id=$1 AND kind IN ('observed_event','observed_event_fee_enriched') ORDER BY id")
        .bind(input.id).fetch_all(&store.pool).await?;
    assert_eq!(
        observations,
        vec![
            ("observed_event".into(), serde_json::to_value(&missing)?),
            (
                "observed_event_fee_enriched".into(),
                serde_json::to_value(&known)?
            )
        ]
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_archive_witness_must_be_complete_and_bound_before_claim(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    enable_fixture(&store, &ids, &input).await?;
    let intent = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
        .await?;
    assert_eq!(intent.state, "archive_pending");
    let github = publish_fixture_archive(&store, &ids).await?;
    let valid: Value = sqlx::query_scalar("SELECT witness FROM state_audit_anchor_receipts WHERE destination_id=$1 AND checkpoint_digest=$2")
        .bind(github).bind(&intent.checkpoint_digest).fetch_one(&store.pool).await?;
    assert!(
        store
            .base_audit_preview(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .archive_ready
    );
    let mut invalid = vec![
        None,
        Some(json!({})),
        Some(json!({"provider":"github","archive_publication":null})),
    ];
    for (pointer, replacement) in [
        ("/archive_publication/archive/parts", json!([])),
        (
            "/archive_publication/archive/ledger_id",
            json!(Uuid::new_v4().to_string()),
        ),
        (
            "/archive_publication/archive/checkpoint_digest",
            json!("a".repeat(64)),
        ),
        ("/archive_publication/archive/byte_count", json!(0)),
        (
            "/archive_publication/archive/parts/0/path",
            json!("elsewhere/archive.json"),
        ),
        (
            "/archive_publication/archive/parts/0/sha256",
            json!("short"),
        ),
        ("/archive_publication/index_sha256", json!("0".repeat(64))),
        (
            "/archive_publication/index_path",
            json!("other/archive.json"),
        ),
        ("/commit", json!("different-commit")),
        ("/repository", json!("different/repository")),
    ] {
        let mut witness = valid.clone();
        *witness
            .pointer_mut(pointer)
            .context("native fixture witness field missing")? = replacement;
        invalid.push(Some(witness));
    }
    for witness in invalid {
        // These are historical/corrupt receipts in the SQLx-owned fixture only.
        sqlx::query("UPDATE state_audit_anchor_receipts SET witness=$3 WHERE destination_id=$1 AND checkpoint_digest=$2")
            .bind(github).bind(&intent.checkpoint_digest).bind(witness).execute(&store.pool).await?;
        assert!(
            !store
                .base_audit_preview(ids.corp_id, ids.alice_actor_id, input.id)
                .await?
                .archive_ready
        );
        sqlx::query("UPDATE base_audit_intents SET state='ready' WHERE id=$1")
            .bind(intent.id)
            .execute(&store.pool)
            .await?;
        assert!(
            store
                .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
                .await?
                .is_none()
        );
        let current = store
            .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
            .await?;
        assert_eq!(current.id, intent.id);
        assert_eq!(current.state, "archive_pending");
        let state: (Option<i64>, Option<Uuid>) =
            sqlx::query_as("SELECT nonce,worker_id FROM base_audit_intents WHERE id=$1")
                .bind(intent.id)
                .fetch_one(&store.pool)
                .await?;
        assert_eq!(state, (None, None));
    }
    sqlx::query("UPDATE state_audit_anchor_receipts SET witness=$3 WHERE destination_id=$1 AND checkpoint_digest=$2")
        .bind(github).bind(&intent.checkpoint_digest).bind(valid).execute(&store.pool).await?;
    assert!(
        store
            .base_audit_preview(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .archive_ready
    );
    assert!(
        store
            .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
            .await?
            .is_some()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_configured_destination_is_not_starved_by_unrelated_rows(
    pool: PgPool,
) -> Result<()> {
    let (store, _, input) = base_fixture(pool).await?;
    sqlx::query("INSERT INTO base_audit_destinations(id,corp_id,customer_id,config,manifest_digest,chain_id,sender,registry,stream_id,next_due,created_at) SELECT gen_random_uuid(),corp_id,customer_id,'{}','unconfigured-'||g,chain_id,sender,registry,stream_id,next_due,created_at-interval '1 day' FROM base_audit_destinations CROSS JOIN generate_series(1,1025) g WHERE id=$1")
        .bind(input.id).execute(&store.pool).await?;
    let selected = store.base_worker_destinations(&[input.id]).await?;
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].input, input);
    assert!(store.base_worker_destinations(&[]).await?.is_empty());
    assert!(
        store
            .base_worker_destinations(&vec![input.id; 1025])
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_wallet_operations_wait_for_lane_before_locking_destinations(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let second = second_destination(&store, &ids, &input).await?;
    for operation in ["reserve", "validation", "reorg", "quarantine", "configure"] {
        let mut holder = store.pool.begin().await?;
        let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *holder)
            .await?;
        sqlx::query(
            "SELECT sender FROM base_audit_sender_lanes WHERE chain_id=$1 AND sender=$2 FOR UPDATE",
        )
        .bind(i64::try_from(input.config.chain_id)?)
        .bind(input.config.publisher.as_slice())
        .fetch_one(&mut *holder)
        .await?;
        let worker_store = store.clone();
        let worker_claim = claim.clone();
        let worker_input = input.clone();
        let corp = ids.corp_id;
        let actor = ids.alice_actor_id;
        let waiter = tokio::spawn(async move {
            match operation {
                "reserve" => {
                    worker_store
                        .reserve_base_attempt(
                            &worker_claim,
                            &quote(),
                            U256::from(9_000_000),
                            0,
                            false,
                        )
                        .await?;
                }
                "validation" => {
                    worker_store
                        .complete_base_validation(
                            corp,
                            worker_input.id,
                            BaseValidation {
                                epoch: "test-journal",
                                cursor: 0,
                                requests: &[],
                                pending_nonce: 0,
                                observation: &json!({}),
                            },
                        )
                        .await?
                }
                "reorg" => {
                    worker_store
                        .record_base_reorg(
                            corp,
                            worker_input.id,
                            B256::repeat_byte(6),
                            &SealedHeader {
                                number: 10,
                                hash: B256::repeat_byte(7),
                                parent_hash: B256::repeat_byte(5),
                                timestamp: 1_788_220_800,
                            },
                        )
                        .await?
                }
                "quarantine" => {
                    worker_store
                        .quarantine_base_wallet(&worker_claim, "nonce_conflict")
                        .await?
                }
                "configure" => {
                    worker_store
                        .configure_base_destination(corp, actor, &worker_input)
                        .await?;
                }
                _ => unreachable!(),
            }
            Ok::<_, anyhow::Error>(())
        });
        let waited = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))")
                    .bind(holder_pid).fetch_one(&store.pool).await?;
                if blocked { return Ok::<_, anyhow::Error>(()); }
                ensure!(!waiter.is_finished(), "{operation} completed before waiting on its lane");
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await;
        // The blocked operation must hold neither destination. This deterministically
        // fails the old destination-before-lane order without relying on a deadlock timeout.
        let unlocked = sqlx::query(
            "SELECT id FROM base_audit_destinations WHERE id=ANY($1) ORDER BY id FOR UPDATE NOWAIT",
        )
        .bind(vec![input.id, second.id])
        .fetch_all(&mut *holder)
        .await;
        waiter.abort();
        let _ = waiter.await;
        holder.rollback().await?;
        waited.with_context(|| format!("{operation} did not wait for its lane"))??;
        assert_eq!(
            unlocked
                .with_context(|| format!("{operation} locked a destination before its lane"))?
                .len(),
            2
        );
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_observation_paging_reorg_and_admin_fences(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) SELECT $1,$2,'inclusion','paging-'||g,jsonb_build_object('block',jsonb_build_object('number',g,'hash','0x'||lpad(to_hex(g),64,'0'),'parent_hash','0x'||lpad(to_hex(g-1),64,'0'),'timestamp',g)) FROM generate_series(1,65) g")
        .bind(ids.corp_id).bind(input.id).execute(&store.pool).await?;
    let tip = SealedHeader {
        number: 100,
        hash: B256::repeat_byte(42),
        parent_hash: B256::repeat_byte(41),
        timestamp: 100,
    };
    let first = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert!(
        store
            .acknowledge_base_observation_page(&first, &tip)
            .await?
            .is_none()
    );
    let boundary = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(boundary.headers[0].number, 65);
    let replacement = SealedHeader {
        hash: B256::repeat_byte(99),
        ..boundary.headers[0].clone()
    };
    store
        .record_base_reorg(
            ids.corp_id,
            input.id,
            boundary.headers[0].hash,
            &replacement,
        )
        .await?;
    assert!(
        store
            .acknowledge_base_observation_page(&boundary, &tip)
            .await
            .is_err()
    );
    let restarted = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(restarted.evidence_ids, first.evidence_ids);
    assert!(
        store
            .acknowledge_base_observation_page(&restarted, &tip)
            .await?
            .is_none()
    );
    let orphaned = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(orphaned.evidence_ids, boundary.evidence_ids);
    assert!(
        orphaned.headers.is_empty(),
        "orphan exclusion is bounded to this page"
    );
    let fence = store
        .acknowledge_base_observation_page(&orphaned, &tip)
        .await?
        .unwrap();
    assert!(store.finish_base_observation_sweep(&fence).await?);
    let stale = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 1, false)
        .await?;
    assert!(
        store
            .acknowledge_base_observation_page(&stale, &tip)
            .await
            .is_err()
    );
    let page = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) VALUES($1,$2,'spend_finalized','finalized-boundary',$3)")
        .bind(ids.corp_id).bind(input.id).bind(json!({"block":boundary.headers[0]})).execute(&store.pool).await?;
    assert!(
        store
            .acknowledge_base_observation_page(&page, &tip)
            .await?
            .is_none()
    );
    let orphan_page = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert!(
        store
            .acknowledge_base_observation_page(&orphan_page, &tip)
            .await?
            .is_none()
    );
    let finalized_page = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(
        finalized_page.headers, boundary.headers,
        "finalized evidence must not be hidden by an earlier tentative orphan record"
    );
    let conflicting = SealedHeader {
        hash: B256::repeat_byte(98),
        ..boundary.headers[0].clone()
    };
    store
        .record_base_reorg(
            ids.corp_id,
            input.id,
            boundary.headers[0].hash,
            &conflicting,
        )
        .await?;
    assert!(
        store
            .acknowledge_base_observation_page(&finalized_page, &tip)
            .await
            .is_err()
    );
    assert!(
        store
            .base_observation_page(ids.corp_id, input.id, &tip)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .status,
        "finalized_contradiction"
    );
    let retained:i64=sqlx::query_scalar("SELECT count(*) FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='inclusion'")
        .bind(ids.corp_id).bind(input.id).fetch_one(&store.pool).await?;
    assert_eq!(retained, 65, "reorgs do not delete immutable observations");
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_observation_paging_covers_large_history(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) SELECT $1,$2,'inclusion','paging-'||g,jsonb_build_object('block',jsonb_build_object('number',g,'hash','0x'||lpad(to_hex(g),64,'0'),'parent_hash','0x'||lpad(to_hex(g-1),64,'0'),'timestamp',g)) FROM generate_series(1,1057) g")
        .bind(ids.corp_id).bind(input.id).execute(&store.pool).await?;
    let tip = SealedHeader {
        number: 2000,
        hash: B256::repeat_byte(42),
        parent_hash: B256::repeat_byte(41),
        timestamp: 2000,
    };
    assert!(
        store
            .base_observation_page(Uuid::new_v4(), input.id, &tip)
            .await
            .is_err()
    );
    assert!(
        store
            .base_observation_page(ids.corp_id, Uuid::new_v4(), &tip)
            .await
            .is_err()
    );
    let page = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(page.evidence_ids.len(), 64);
    let replay = store
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(
        page.evidence_ids, replay.evidence_ids,
        "unacknowledged page survives restart"
    );
    let mut ids_seen = page.evidence_ids.clone();
    let mut numbers: Vec<_> = page.headers.iter().map(|header| header.number).collect();
    assert!(
        store
            .acknowledge_base_observation_page(&page, &tip)
            .await?
            .is_none()
    );
    assert!(
        store
            .acknowledge_base_observation_page(&replay, &tip)
            .await
            .is_err(),
        "stale acknowledgements cannot skip a page"
    );
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) VALUES($1,$2,'inclusion','inserted-during-sweep',$3)")
        .bind(ids.corp_id).bind(input.id).bind(json!({"block":tip})).execute(&store.pool).await?;
    use sqlx::ConnectOptions;
    let restarted = PgStore::connect(store.pool.connect_options().to_url_lossy().as_str()).await?;
    let mut pages = 1;
    let fence = loop {
        let page = restarted
            .base_observation_page(ids.corp_id, input.id, &tip)
            .await?;
        assert!(page.evidence_ids.len() <= 64);
        assert!(page.evidence_ids.windows(2).all(|pair| pair[0] < pair[1]));
        ids_seen.extend(&page.evidence_ids);
        numbers.extend(page.headers.iter().map(|header| header.number));
        pages += 1;
        if let Some(fence) = restarted
            .acknowledge_base_observation_page(&page, &tip)
            .await?
        {
            break fence;
        }
        assert!(
            pages < 20,
            "keyset cursor must make bounded forward progress"
        );
    };
    assert_eq!(
        pages, 18,
        "last-page concurrent insert requires a further bounded tail page"
    );
    let expected:Vec<i64>=sqlx::query_scalar("SELECT id FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='inclusion' ORDER BY id")
        .bind(ids.corp_id).bind(input.id).fetch_all(&store.pool).await?;
    assert_eq!(ids_seen, expected);
    assert_eq!(
        numbers.iter().filter(|number| **number <= 1057).count(),
        1057
    );
    assert!(numbers.contains(&1025) && numbers.contains(&1057));
    // Event rescanning can append evidence after the retained-header phase completed.
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,kind,identity,evidence) VALUES($1,$2,'inclusion','inserted-during-event-rescan',$3)")
        .bind(ids.corp_id).bind(input.id).bind(json!({"block":tip})).execute(&store.pool).await?;
    assert!(!restarted.finish_base_observation_sweep(&fence).await?);
    let tail = restarted
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(tail.evidence_ids.len(), 1);
    let fence = restarted
        .acknowledge_base_observation_page(&tail, &tip)
        .await?
        .unwrap();
    let paused_page = restarted
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert!(
        paused_page.evidence_ids.is_empty(),
        "completed retained phase persists during log rescan"
    );
    assert!(restarted.finish_base_observation_sweep(&fence).await?);
    assert!(
        restarted
            .finish_base_observation_sweep(&fence)
            .await
            .is_err(),
        "completion fence is single-use"
    );
    let next = restarted
        .base_observation_page(ids.corp_id, input.id, &tip)
        .await?;
    assert_eq!(
        next.evidence_ids,
        ids_seen[..64],
        "next complete sweep starts deterministically at the beginning"
    );
    restarted.pool.close().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_gateway_authorizer_works_with_select_only_readonly_role(
    pool: PgPool,
) -> Result<()> {
    use sqlx::{ConnectOptions, Connection, PgConnection};
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let role = format!("base_readonly_{}", Uuid::new_v4().simple());
    let password = Uuid::new_v4().simple().to_string();
    // Use an ephemeral login under SCRAM too. PostgreSQL role DDL cannot bind
    // parameters, so prevent the generated credential from entering SQL logs.
    let admin_options = store
        .pool
        .connect_options()
        .as_ref()
        .clone()
        .disable_statement_logging();
    let mut admin = PgConnection::connect_with(&admin_options).await?;
    sqlx::query(&format!("CREATE ROLE {role} LOGIN PASSWORD '{password}'"))
        .execute(&mut admin)
        .await?;
    admin.close().await?;
    sqlx::query(&format!(
        "ALTER ROLE {role} SET default_transaction_read_only=on"
    ))
    .execute(&store.pool)
    .await?;
    sqlx::query(&format!("GRANT USAGE ON SCHEMA public TO {role}"))
        .execute(&store.pool)
        .await?;
    sqlx::query(&format!(
        "GRANT SELECT ON ALL TABLES IN SCHEMA public TO {role}"
    ))
    .execute(&store.pool)
    .await?;
    let options = store
        .pool
        .connect_options()
        .as_ref()
        .clone()
        .username(&role)
        .password(&password);
    let readonly = PgStore::connect(options.to_url_lossy().as_str()).await?;
    let authorized = readonly
        .authorized_base_attempt(ids.corp_id, attempt.request.attempt_id)
        .await;
    readonly.pool.close().await;
    sqlx::query(&format!("DROP OWNED BY {role}"))
        .execute(&store.pool)
        .await?;
    sqlx::query(&format!("DROP ROLE {role}"))
        .execute(&store.pool)
        .await?;
    assert_eq!(authorized?.request, attempt.request);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_retained_ancestry_restarts_cas_and_rejects_tampering(pool: PgPool) -> Result<()> {
    use crony_base::ancestry::{
        AncestryBinding, AncestrySegment, AncestryStore, ConsensusHeader, sealed_header,
    };
    let (store, ids, input) = base_fixture(pool).await?;
    let installed: bool =
        sqlx::query_scalar("SELECT to_regclass('base_audit_ancestry_segments') IS NOT NULL")
            .fetch_one(&store.pool)
            .await?;
    assert!(
        installed,
        "append-only ancestry migration must be installed"
    );
    let first = ConsensusHeader {
        number: 1,
        timestamp: 1,
        gas_limit: 1,
        ..Default::default()
    };
    let second = ConsensusHeader {
        number: 2,
        timestamp: 2,
        gas_limit: 1,
        parent_hash: first.hash_slow(),
        ..Default::default()
    };
    let binding = AncestryBinding {
        manifest_digest: input.config.manifest_digest,
        chain_id: input.config.chain_id,
        transaction_hash: B256::repeat_byte(42),
        provider_identity: input.config.primary_operator.clone(),
        included: sealed_header(&first),
        finalized: sealed_header(&second),
        observed_at: Utc::now(),
    };
    let key = binding.key();
    let segment = AncestrySegment {
        binding: binding.clone(),
        headers: vec![second],
    };
    let adapter = store.base_ancestry(ids.corp_id, input.id);
    adapter.append(key, 0, &segment).await?;
    adapter.append(key, 0, &segment).await?;
    let state = adapter.load(key).await?.context("retained progress")?;
    assert!(!state.complete);
    assert_eq!(state.header_count, 1);
    drop(adapter);
    let restored = store.base_ancestry(ids.corp_id, input.id);
    let mut tampered = segment.clone();
    tampered.headers[0].timestamp = 99;
    assert!(restored.append(key, 0, &tampered).await.is_err());
    restored
        .append(
            key,
            1,
            &AncestrySegment {
                binding,
                headers: vec![first.clone()],
            },
        )
        .await?;
    let complete = restored.load(key).await?.unwrap();
    assert!(complete.complete);
    assert_eq!(restored.header(key, 1).await?, Some(first));
    assert!(
        store
            .base_ancestry(Uuid::new_v4(), input.id)
            .load(key)
            .await?
            .is_none()
    );
    assert!(
        sqlx::query("DELETE FROM base_audit_ancestry_segments WHERE destination_id=$1")
            .bind(input.id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_prefreeze_coalescing_and_alternate_archive_rejection(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let mut unsupported = input.clone();
    unsupported.id = Uuid::new_v4();
    unsupported.config.require_github_archive = false;
    assert!(unsupported.trusted_manifest().is_err());
    assert!(
        store
            .configure_base_destination(ids.corp_id, ids.alice_actor_id, &unsupported)
            .await
            .is_err()
    );
    let claim = archived_claim(&store, &ids, &input).await?;
    let row = sqlx::query("SELECT m.id AS mission_id,t.id AS task_id,t.contract,t.verification_policy FROM missions m JOIN tasks t ON t.mission_id=m.id AND t.corp_id=m.corp_id WHERE m.corp_id=$1 LIMIT 1")
        .bind(ids.corp_id).fetch_one(&store.pool).await?;
    store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: row.get("mission_id"),
            task_id: row.get("task_id"),
            expected_contract_version: 2,
            next_action: MissionContractRevisionAction::Redispatch,
            source_run_id: None,
            reason: "new checkpoint while queued".into(),
            idempotency_key: Uuid::new_v4(),
            description: "newest eligible checkpoint".into(),
            contract: serde_json::from_value(row.get("contract"))?,
            verification_policy: serde_json::from_value(row.get("verification_policy"))?,
        })
        .await?;
    store
        .audit_checkpoint(
            ids.corp_id,
            "test-checkpoint",
            &crony_audit::SigningKey::from_bytes(&[7; 32]),
        )
        .await?;
    let newest = store
        .schedule_base_anchor(ids.corp_id, input.id)
        .await?
        .context("coalesced intent")?;
    assert_ne!(newest.id, claim.intent.id);
    assert!(newest.sequence > claim.intent.sequence);
    assert!(store.check_base_fence(&claim).await.is_err());
    let terminal: bool = sqlx::query_scalar("SELECT terminal FROM base_audit_intents WHERE id=$1")
        .bind(claim.intent.id)
        .fetch_one(&store.pool)
        .await?;
    assert!(terminal);
    assert_eq!(newest.state, "archive_pending");
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_manifest_successor_preserves_history_and_prevents_reenable(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let authority = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let successor = crony_audit::SigningKey::from_bytes(&[19; 32]);
    let mut manifest = input.manifests[0].manifest.clone();
    manifest.manifest_version = 2;
    manifest.previous_manifest_digest = Some(input.config.manifest_digest);
    manifest.next_manifest_authority = Some(successor.verifying_key().to_bytes());
    let next = SignedManifest::sign(manifest, &authority, Some(&successor))?;
    let mut revision = input.clone();
    revision.id = Uuid::new_v4();
    revision.config.manifest_digest = next.digest;
    revision.manifests.push(next);
    let configured = store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &revision)
        .await?;
    assert!(!configured.enabled);
    assert_eq!(
        store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .input,
        input
    );
    assert!(
        enable_fixture(&store, &ids, &input).await.is_err(),
        "superseded trust cannot be reenabled"
    );
    let mut third = revision.clone();
    third.id = Uuid::new_v4();
    let mut manifest = third.manifests.last().unwrap().manifest.clone();
    manifest.manifest_version = 3;
    manifest.previous_manifest_digest = Some(third.config.manifest_digest);
    manifest.next_manifest_authority = None;
    let next = SignedManifest::sign(manifest, &successor, None)?;
    third.config.manifest_digest = next.digest;
    third.manifests.push(next);
    store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &third)
        .await?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_recovery_requires_retained_last_verified_anchor(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let mut recovery = input.clone();
    recovery.id = Uuid::new_v4();
    let mut manifest = input.manifests[0].manifest.clone();
    manifest.manifest_version = 2;
    manifest.previous_manifest_digest = Some(input.config.manifest_digest);
    let old_destination = manifest.identity();
    manifest.local_stream_key = B256::repeat_byte(51);
    manifest.stream_id =
        crony_base::abi::stream_id(manifest.registering_owner, manifest.local_stream_key);
    manifest.migration = Some(crony_base::manifest::Migration {
        old_destination,
        last_verified_anchor: crony_base::manifest::AnchorIdentity {
            sequence: 1,
            checkpoint_digest: B256::repeat_byte(21),
            transaction_hash: B256::repeat_byte(22),
            log_index: 0,
        },
        incident_event: None,
        first_new_checkpoint: B256::repeat_byte(23),
    });
    let next = SignedManifest::sign(
        manifest,
        &crony_audit::SigningKey::from_bytes(&[8; 32]),
        None,
    )?;
    recovery.config.stream_id = next.manifest.stream_id;
    recovery.config.manifest_digest = next.digest;
    recovery.manifests.push(next);
    assert!(
        store
            .configure_base_destination(ids.corp_id, ids.alice_actor_id, &recovery)
            .await
            .is_err()
    );
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let signed = sign_fixture(&attempt).await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    let public = json!({
        "destination":store.base_destination(ids.corp_id,ids.alice_actor_id,input.id).await?,
        "intent":claim.intent,
        "status":store.base_status(ids.corp_id,ids.alice_actor_id).await?,
        "history":store.base_history(ids.corp_id,ids.alice_actor_id,input.id,None,100).await?,
    })
    .to_string();
    assert!(!public.contains(&hex::encode(signed.raw())));
    for private_field in ["raw_tx", "raw_transaction", "bearer", "private_key"] {
        assert!(
            !public.contains(private_field),
            "public response leaked {private_field}"
        );
    }
    let (receipt, block) = receipt_fixture(&attempt, signed.hash(), true, Some(U256::from(1000)))?;
    let event = receipt.exact_event(
        input.config.contract_address,
        &attempt.request.transaction.call,
        input.config.publisher,
    )?;
    let finalized = FinalizedAnchor {
        receipt: receipt.clone(),
        included: block.clone(),
        event: event.clone(),
        observations: finality_fixture(&block),
        assurance: Assurance::ProviderObservedFinalized,
    };
    store
        .record_base_inclusion(&claim, &receipt, &block)
        .await?;
    store
        .record_base_spend_finality(&claim, &receipt, &block, &finality_fixture(&block))
        .await?;
    store.finalize_base_anchor(&claim, &finalized).await?;
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 2, false)
        .await?;
    let mut manifest = recovery.manifests.pop().unwrap().manifest;
    let migration = manifest.migration.as_mut().unwrap();
    migration.last_verified_anchor = crony_base::manifest::AnchorIdentity {
        sequence: event.call.sequence,
        checkpoint_digest: event.call.checkpoint_digest,
        transaction_hash: event.transaction_hash,
        log_index: event.log_index,
    };
    migration.first_new_checkpoint = event.call.checkpoint_digest;
    let next = SignedManifest::sign(
        manifest,
        &crony_audit::SigningKey::from_bytes(&[8; 32]),
        None,
    )?;
    recovery.config.manifest_digest = next.digest;
    recovery.manifests.push(next);
    store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &recovery)
        .await?;
    store
        .complete_base_validation(
            ids.corp_id,
            recovery.id,
            BaseValidation {
                epoch: "test-journal",
                cursor: 1,
                requests: &[attempt.request],
                pending_nonce: 1,
                observation: &json!({"fixture":true}),
            },
        )
        .await?;
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, recovery.id, 1, true)
        .await?;
    let first = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, recovery.id, Uuid::new_v4())
        .await?;
    assert_eq!(
        first.checkpoint_digest,
        hex::encode(event.call.checkpoint_digest)
    );
    assert_eq!(first.previous_digest, "0".repeat(64));
    assert!(
        store
            .base_history(ids.corp_id, ids.alice_actor_id, input.id, None, 100)
            .await?
            .to_string()
            .contains("superseded")
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_operator_pause_keeps_receipt_reconciliation_without_publication(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let signed = sign_fixture(&attempt).await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 2, false)
        .await?;
    assert!(store.check_base_fence(&claim).await.is_err());
    store.release_base_claim(&claim, "broadcast").await?;
    let recovered = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("paused signed transaction must still be reconciled")?;
    assert!(store.check_base_fence(&recovered).await.is_err());
    assert_eq!(store.base_attempts(&recovered).await?.len(), 1);
    let (receipt, block) = receipt_fixture(&attempt, signed.hash(), true, Some(U256::from(1000)))?;
    store
        .record_base_inclusion(&recovered, &receipt, &block)
        .await?;
    store
        .record_base_spend_finality(&recovered, &receipt, &block, &finality_fixture(&block))
        .await?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_recovery_rejects_unknown_pending_nonce_beyond_active_lane(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    store.begin_base_recovery(ids.corp_id, input.id).await?;
    assert!(
        store
            .complete_base_validation(
                ids.corp_id,
                input.id,
                BaseValidation {
                    epoch: "test-journal",
                    cursor: 1,
                    requests: &[attempt.request],
                    pending_nonce: 2,
                    observation: &json!({"fixture":true}),
                },
            )
            .await
            .is_err()
    );
    assert!(store.check_base_fence(&claim).await.is_err());
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_wallet_pause_fences_existing_claim_before_broadcast(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    sqlx::query("UPDATE base_audit_sender_lanes SET paused=true WHERE chain_id=$1 AND sender=$2")
        .bind(i64::try_from(input.config.chain_id)?)
        .bind(input.config.publisher.as_slice())
        .execute(&store.pool)
        .await?;
    assert!(store.check_base_fence(&claim).await.is_err());
    Ok(())
}
use crate::base_audit::*;
use alloy::{
    consensus::SignableTransaction, eips::eip2718::Encodable2718, network::TxSigner,
    signers::local::PrivateKeySigner, sol_types::SolEvent,
};
use crony_base::{
    Address, B256, U256,
    config::{Assurance, BaseDestinationConfig},
    fees::{FeeQuote, SpendingPolicy},
    manifest::{CheckpointKey, DestinationManifestV1, NetworkIdentity, SignedManifest, TrustPin},
    schedule::Schedule,
};
use crony_base::{
    rpc::{FinalityObservation, FinalizedAnchor, ReceiptEvidence, SealedHeader},
    signing::{FrozenTransaction, SignRequest, SignedTransaction},
};

async fn base_request_counts(store: &PgStore, corp: Uuid) -> Result<(i64, i64, i64, i64, i64)> {
    sqlx::query_as(
        "SELECT
         (SELECT count(*) FROM base_audit_intents WHERE corp_id=$1),
         (SELECT count(*) FROM base_audit_operations WHERE corp_id=$1),
         (SELECT count(*) FROM base_audit_evidence WHERE corp_id=$1 AND kind='requested'),
         (SELECT count(*) FROM base_audit_attempts WHERE corp_id=$1),
         (SELECT count(*) FROM base_audit_signed_results WHERE corp_id=$1)",
    )
    .bind(corp)
    .fetch_one(&store.pool)
    .await
    .map_err(Into::into)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires owned disposable PostgreSQL; synthetic store fixture, not runtime acceptance"]
async fn base_v2_phase3_same_key_request_replays_once(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    enable_fixture(&store, &ids, &input).await?;
    let key = Uuid::new_v4();
    let (first, concurrent) = futures_util::future::join(
        store.request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key),
        store.request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key),
    )
    .await;
    let first = first?;
    assert_eq!(first.id, concurrent?.id);
    let replay = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key)
        .await?;
    assert_eq!(first.id, replay.id);
    assert_eq!(first.checkpoint_digest, replay.checkpoint_digest);
    assert_eq!(replay.state, "archive_pending");
    assert_eq!(
        base_request_counts(&store, ids.corp_id).await?,
        (1, 1, 1, 0, 0),
        "concurrent and later replay must retain one intent, operation and requested evidence"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires owned disposable PostgreSQL; synthetic store fixture, not runtime acceptance"]
async fn base_v2_phase3_changed_destination_reused_key_rejected(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    enable_fixture(&store, &ids, &input).await?;
    let second = second_destination(&store, &ids, &input).await?;
    let key = Uuid::new_v4();
    let first = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key)
        .await?;
    let error = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, second.id, key)
        .await
        .expect_err("changed destination must not reuse the first request key");
    assert_eq!(
        error.to_string(),
        "publication key reused for another destination"
    );
    assert_eq!(
        base_request_counts(&store, ids.corp_id).await?,
        (1, 1, 1, 0, 0)
    );
    assert_eq!(
        store
            .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key)
            .await?
            .id,
        first.id,
        "a rejected changed request cannot corrupt the original replay"
    );
    let second_intent = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, second.id, Uuid::new_v4())
        .await?;
    assert_ne!(second_intent.id, first.id);
    assert_eq!(
        base_request_counts(&store, ids.corp_id).await?,
        (2, 2, 2, 0, 0)
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires owned disposable PostgreSQL; synthetic store fixture, not runtime acceptance"]
async fn base_v2_phase3_incomplete_room_coverage_rejects_reads_and_requests(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    enable_fixture(&store, &ids, &input).await?;
    let key = Uuid::new_v4();
    let first = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key)
        .await?;
    let covered_room: Uuid = sqlx::query_scalar(
        "SELECT m.room_id FROM state_audit_coverage c
         JOIN missions m ON m.corp_id=c.corp_id AND m.id=c.mission_id
         WHERE c.corp_id=$1 LIMIT 1",
    )
    .bind(ids.corp_id)
    .fetch_one(&store.pool)
    .await?;
    let unrelated_room = Uuid::new_v4();
    sqlx::query("INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'Other room','Store coverage fixture')")
        .bind(unrelated_room).bind(ids.corp_id).execute(&store.pool).await?;
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(unrelated_room)
        .bind(ids.alice_actor_id)
        .execute(&store.pool)
        .await?;
    let removed = sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(covered_room)
        .bind(ids.alice_actor_id)
        .execute(&store.pool)
        .await?;
    assert_eq!(removed.rows_affected(), 1);
    for request_key in [key, Uuid::new_v4()] {
        let error = store
            .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, request_key)
            .await
            .expect_err("owner with incomplete covered-room membership cannot request or replay");
        assert_eq!(
            error.to_string(),
            "forbidden: actor is not a member of this room"
        );
    }
    let status_error = store
        .base_status(ids.corp_id, ids.alice_actor_id)
        .await
        .expect_err("partial room membership cannot read complete-Corp status");
    let history_error = store
        .base_history(ids.corp_id, ids.alice_actor_id, input.id, None, 100)
        .await
        .expect_err("partial room membership cannot read complete-Corp history");
    for error in [status_error, history_error] {
        assert_eq!(
            error.to_string(),
            "forbidden: actor is not a member of this room"
        );
    }
    assert_eq!(
        base_request_counts(&store, ids.corp_id).await?,
        (1, 1, 1, 0, 0)
    );
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(covered_room)
        .bind(ids.alice_actor_id)
        .execute(&store.pool)
        .await?;
    assert_eq!(
        store
            .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, key)
            .await?
            .id,
        first.id
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires owned disposable PostgreSQL; synthetic store fixture, not runtime acceptance"]
async fn base_v2_phase3_missing_archive_cannot_claim_freeze_or_authorize_signing(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    enable_fixture(&store, &ids, &input).await?;
    let intent = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
        .await?;
    let receipts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM state_audit_anchor_receipts WHERE corp_id=$1")
            .bind(ids.corp_id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(receipts, 0);
    let worker = Uuid::new_v4();
    for worker_id in [worker, Uuid::new_v4()] {
        assert!(
            store
                .claim_base_intent(ids.corp_id, input.id, worker_id)
                .await?
                .is_none(),
            "missing archive must not issue any worker claim"
        );
    }
    // No issued BaseClaim means the caller has no capability to reserve/freeze an attempt.
    let error = store
        .authorized_base_attempt(ids.corp_id, Uuid::new_v4())
        .await
        .err()
        .expect("no frozen attempt means no gateway signing authority");
    assert!(matches!(
        error.downcast_ref::<sqlx::Error>(),
        Some(sqlx::Error::RowNotFound)
    ));
    assert_eq!(
        base_request_counts(&store, ids.corp_id).await?,
        (1, 1, 1, 0, 0)
    );
    let pending: (String, Option<i64>, Option<Uuid>) = sqlx::query_as(
        "SELECT state,nonce,worker_id FROM base_audit_intents WHERE corp_id=$1 AND id=$2",
    )
    .bind(ids.corp_id)
    .bind(intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(pending, ("archive_pending".into(), None, None));
    Ok(())
}

async fn base_fixture(pool: PgPool) -> Result<(PgStore, DemoIds, BaseDestinationInput)> {
    let (store, ids, mission, contract, verification_policy) =
        state_audit_tests::fixture(pool).await?;
    let ledger = Uuid::new_v4();
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: mission.mission_id,
            task_id: mission.task_ids[0],
            expected_contract_version: 1,
            next_action: MissionContractRevisionAction::Redispatch,
            source_run_id: None,
            reason: "Base test".into(),
            idempotency_key: Uuid::new_v4(),
            description: "Base retained source".into(),
            contract,
            verification_policy,
        })
        .await?;
    let checkpoint_key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "test-checkpoint", &checkpoint_key)
        .await?;
    let authority = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let owner = Address::from([1; 20]);
    let local_stream_key = B256::from([2; 32]);
    let stream_id = crony_base::abi::stream_id(owner, local_stream_key);
    let manifest = DestinationManifestV1 {
        schema_version: 1,
        customer_trust_id: B256::from([9; 32]),
        manifest_version: 1,
        previous_manifest_digest: None,
        ledger_id: ledger.to_string(),
        chain_id: 84532,
        network_identity: NetworkIdentity {
            genesis_hash: B256::from([3; 32]),
            checkpoint: None,
        },
        contract_address: Address::from([2; 20]),
        contract_version: 1,
        runtime_code_hash: B256::from([4; 32]),
        deployment_block_hash: B256::from([5; 32]),
        deployment_block_number: 1,
        stream_id,
        registering_owner: owner,
        local_stream_key,
        checkpoint_keys: vec![CheckpointKey {
            key_id: "test-checkpoint".into(),
            public_key: checkpoint_key.verifying_key().to_bytes(),
            first_sequence: 1,
            last_sequence: None,
        }],
        assurance_policy: Assurance::ProviderObservedFinalized,
        evidence_retention_policy: "ten-year".into(),
        migration: None,
        next_manifest_authority: None,
    };
    let signed = SignedManifest::sign(manifest, &authority, None)?;
    let config = BaseDestinationConfig {
        chain_id: 84532,
        manifest_digest: signed.digest,
        contract_address: Address::from([2; 20]),
        stream_id,
        publisher: fixture_signer()?.address(),
        primary_rpc_secret: "customer/primary".into(),
        secondary_rpc_secret: "customer/secondary".into(),
        primary_operator: "one".into(),
        secondary_operator: "two".into(),
        signer_gateway_identity: "customer/gateway".into(),
        signer_key_identity: "immutable-key".into(),
        schedule: Schedule::Monthly {
            day: 1,
            hour: 0,
            minute: 0,
        },
        customer_accepted_network_risk: true,
        customer_accepted_public_metadata: true,
        spending_policy: Some(SpendingPolicy {
            max_gas: 100_000,
            max_fee_per_gas: 10,
            max_priority_fee_per_gas: 2,
            max_attempt_fee: U256::from(2_000_000),
            monthly_budget: U256::from(3_000_000),
            safety_margin_bps: 2000,
            max_replacements: 2,
            quote_max_age_seconds: 60,
            max_deferral_seconds: 3600,
            low_balance_threshold: U256::from(100),
        }),
        ..Default::default()
    };
    let input = BaseDestinationInput {
        id: Uuid::new_v4(),
        config,
        trust_pin: TrustPin {
            authority: authority.verifying_key().to_bytes(),
            initial_manifest_digest: signed.digest,
        },
        manifests: vec![signed],
        retention_days: 3650,
    };
    store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &input)
        .await?;
    Ok((store, ids, input))
}

async fn enable_fixture(
    store: &PgStore,
    ids: &DemoIds,
    input: &BaseDestinationInput,
) -> Result<()> {
    // Deliberately synthetic trusted-worker observation; not a live provider qualification claim.
    store
        .complete_base_validation(
            ids.corp_id,
            input.id,
            BaseValidation {
                epoch: "test-journal",
                cursor: 0,
                requests: &[],
                pending_nonce: 0,
                observation: &json!({"fixture":true}),
            },
        )
        .await?;
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 1, true)
        .await?;
    Ok(())
}

async fn archived_claim(
    store: &PgStore,
    ids: &DemoIds,
    input: &BaseDestinationInput,
) -> Result<BaseClaim> {
    enable_fixture(store, ids, input).await?;
    let intent = store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
        .await?;
    assert_eq!(intent.state, "archive_pending");
    publish_fixture_archive(store, ids).await?;
    store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("missing claim")
}

async fn publish_fixture_archive(store: &PgStore, ids: &DemoIds) -> Result<Uuid> {
    let github = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/base-audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &github)
        .await?;
    let remote = state_audit_tests::PublicationFixture::default();
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    assert!(
        store
            .publish_audit_destination(github.id, &remote, &key.verifying_key(), None)
            .await?
    );
    Ok(github.id)
}

fn quote() -> FeeQuote {
    FeeQuote {
        gas_limit: 100_000,
        max_fee_per_gas: 5,
        max_priority_fee_per_gas: 1,
        l1_data_fee: U256::from(100_000),
        observed_at: Utc::now(),
        fee_model_qualified: true,
    }
}

fn fixture_signer() -> Result<PrivateKeySigner> {
    Ok(PrivateKeySigner::from_bytes(&B256::from([17; 32]))?)
}

async fn sign_fixture(attempt: &BaseAttempt) -> Result<SignedTransaction> {
    let signer = fixture_signer()?;
    let mut tx = attempt.request.transaction.unsigned()?;
    let sig = signer.sign_transaction(&mut tx).await?;
    let raw = alloy::consensus::TxEnvelope::Eip1559(tx.into_signed(sig)).encoded_2718();
    Ok(SignedTransaction::validate(&attempt.request, &raw)?)
}

fn receipt_fixture(
    attempt: &BaseAttempt,
    hash: B256,
    with_event: bool,
    l1: Option<U256>,
) -> Result<(ReceiptEvidence, SealedHeader)> {
    let block = SealedHeader {
        number: 10,
        hash: B256::from([6; 32]),
        parent_hash: B256::from([5; 32]),
        timestamp: 1_788_220_800,
    };
    let mut logs = Vec::new();
    if with_event {
        let call = &attempt.request.transaction.call;
        let data = crony_base::abi::ECorpCheckpointRegistryV1::Anchored {
            streamId: call.stream_id,
            sequence: call.sequence,
            checkpointDigest: call.checkpoint_digest,
            previousAnchorDigest: call.previous_anchor_digest,
            anchorOrdinal: 1,
            publisher: attempt.request.transaction.sender,
        }
        .encode_log_data();
        logs.push(json!({"address":attempt.request.transaction.contract,"topics":data.topics(),"data":data.data,
            "blockHash":block.hash,"blockNumber":"0xa","transactionHash":hash,"transactionIndex":"0x0","logIndex":"0x0","removed":false}));
    }
    let mut raw = json!({"type":"0x2","status":"0x1","transactionHash":hash,"transactionIndex":"0x0",
        "blockHash":block.hash,"blockNumber":"0xa","from":attempt.request.transaction.sender,"to":attempt.request.transaction.contract,
        "cumulativeGasUsed":"0x2710","gasUsed":"0x2710","effectiveGasPrice":"0x5",
        "logsBloom":format!("0x{}","00".repeat(256)),"logs":logs,"contractAddress":null});
    if let Some(l1) = l1 {
        raw["l1Fee"] = json!(l1);
    }
    Ok((ReceiptEvidence::parse(raw)?, block))
}

fn finality_fixture(block: &SealedHeader) -> Vec<FinalityObservation> {
    ["one", "two"]
        .iter()
        .map(|p| FinalityObservation {
            provider_identity: (*p).into(),
            observed_at: Utc::now(),
            finalized: block.clone(),
            ancestry: vec![],
            retained_ancestry: None,
        })
        .collect()
}

async fn second_destination(
    store: &PgStore,
    ids: &DemoIds,
    first: &BaseDestinationInput,
) -> Result<BaseDestinationInput> {
    let mut input = first.clone();
    input.id = Uuid::new_v4();
    let mut manifest = input.manifests[0].manifest.clone();
    manifest.local_stream_key = B256::from([55; 32]);
    manifest.stream_id =
        crony_base::abi::stream_id(manifest.registering_owner, manifest.local_stream_key);
    let authority = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let signed = SignedManifest::sign(manifest, &authority, None)?;
    input.config.stream_id = signed.manifest.stream_id;
    input.config.manifest_digest = signed.digest;
    input.trust_pin.initial_manifest_digest = signed.digest;
    input.manifests = vec![signed];
    store
        .configure_base_destination(ids.corp_id, ids.alice_actor_id, &input)
        .await?;
    enable_fixture(store, ids, &input).await?;
    Ok(input)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_durable_schema_defaults_disabled(pool: PgPool) -> Result<()> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO base_audit_destinations(id,corp_id,customer_id,config,manifest_digest,chain_id,sender,registry,stream_id,next_due) VALUES($1,$2,$3,'{}','manifest',84532,$4,$5,$6,now())")
        .bind(id).bind(ids.corp_id).bind(vec![4_u8;32]).bind(vec![1_u8;20])
        .bind(vec![2_u8;20]).bind(vec![3_u8;32]).execute(&store.pool).await?;
    let row =
        sqlx::query("SELECT enabled,restore_required FROM base_audit_destinations WHERE id=$1")
            .bind(id)
            .fetch_one(&store.pool)
            .await?;
    assert!(!row.get::<bool, _>("enabled"));
    assert!(row.get::<bool, _>("restore_required"));
    assert!(
        sqlx::query("UPDATE base_audit_destinations SET config='{\"changed\":true}' WHERE id=$1")
            .bind(id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_authority_immutable_trust_and_enable_ticket(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    assert!(
        store
            .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 1, true)
            .await
            .is_err()
    );
    assert!(
        store
            .base_destination(Uuid::new_v4(), ids.alice_actor_id, input.id)
            .await
            .is_err()
    );
    assert!(
        store
            .configure_base_destination(ids.corp_id, ids.eve_actor_id, &input)
            .await
            .is_err()
    );
    let mut changed = input.clone();
    changed.retention_days += 1;
    assert!(
        store
            .configure_base_destination(ids.corp_id, ids.alice_actor_id, &changed)
            .await
            .is_err()
    );
    enable_fixture(&store, &ids, &input).await?;
    assert!(
        store
            .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 1, false)
            .await
            .is_err()
    );
    store
        .control_base_destination(ids.corp_id, ids.alice_actor_id, input.id, 2, false)
        .await?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_archive_retention_and_concurrent_claim_fences(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let (one, two) = futures_util::future::join(
        store.claim_base_intent(ids.corp_id, input.id, Uuid::new_v4()),
        store.claim_base_intent(ids.corp_id, input.id, Uuid::new_v4()),
    )
    .await;
    assert!(one?.is_none() && two?.is_none());
    sqlx::query("UPDATE base_audit_intents SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(claim.intent.id)
        .execute(&store.pool)
        .await?;
    let newer = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("reclaim")?;
    assert!(store.check_base_fence(&claim).await.is_err());
    store.check_base_fence(&newer).await?;
    let retained: i64 =
        sqlx::query_scalar("SELECT count(*) FROM base_audit_retained_history WHERE corp_id=$1")
            .bind(ids.corp_id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(retained, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_atomic_budget_nonce_freeze_and_replacement_max(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    assert!(
        store
            .reserve_base_attempt(&claim, &quote(), U256::from(1), 0, false)
            .await
            .is_err()
    );
    assert!(store.base_attempts(&claim).await?.is_empty());
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    assert_eq!(attempt.request.transaction.nonce, 0);
    let mut raised = quote();
    raised.max_fee_per_gas = 6;
    raised.max_priority_fee_per_gas = 2;
    store
        .reserve_base_attempt(&claim, &raised, U256::from(9_000_000), 0, true)
        .await?;
    let reserved: String =
        sqlx::query_scalar("SELECT reservation::text FROM base_audit_intents WHERE id=$1")
            .bind(claim.intent.id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(reserved, "720000");
    assert!(
        sqlx::query("UPDATE base_audit_attempts SET frozen='{}' WHERE id=$1")
            .bind(attempt.request.attempt_id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE base_audit_intents SET nonce=1 WHERE id=$1")
            .bind(claim.intent.id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    assert!(
        store
            .reserve_base_attempt(&claim, &raised, U256::from(9_000_000), 0, false)
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_restart_and_rollback_behind_gateway_fail_closed(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    store.begin_base_recovery(ids.corp_id, input.id).await?;
    assert!(store.check_base_fence(&claim).await.is_err());
    let mut unknown = attempt.request.clone();
    unknown.attempt_id = Uuid::new_v4();
    assert!(
        store
            .complete_base_validation(
                ids.corp_id,
                input.id,
                BaseValidation {
                    epoch: "test-journal",
                    cursor: 2,
                    requests: &[unknown],
                    pending_nonce: 0,
                    observation: &json!({})
                }
            )
            .await
            .is_err()
    );
    assert!(
        store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .restore_required
    );
    store
        .complete_base_validation(
            ids.corp_id,
            input.id,
            BaseValidation {
                epoch: "test-journal",
                cursor: 1,
                requests: &[attempt.request],
                pending_nonce: 0,
                observation: &json!({}),
            },
        )
        .await?;
    assert!(
        store
            .complete_base_validation(
                ids.corp_id,
                input.id,
                BaseValidation {
                    epoch: "test-journal",
                    cursor: 0,
                    requests: &[],
                    pending_nonce: 0,
                    observation: &json!({})
                }
            )
            .await
            .is_err()
    );
    assert!(
        store
            .complete_base_validation(
                ids.corp_id,
                input.id,
                BaseValidation {
                    epoch: "different-journal",
                    cursor: 1,
                    requests: &[],
                    pending_nonce: 0,
                    observation: &json!({})
                }
            )
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_same_wallet_concurrent_nonce_reservations_are_atomic(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let first = archived_claim(&store, &ids, &input).await?;
    let second = second_destination(&store, &ids, &input).await?;
    store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, second.id, Uuid::new_v4())
        .await?;
    let second = store
        .claim_base_intent(ids.corp_id, second.id, Uuid::new_v4())
        .await?
        .context("second claim")?;
    let q = quote();
    let (a, b) = futures_util::future::join(
        store.reserve_base_attempt(&first, &q, U256::from(9_000_000), 0, false),
        store.reserve_base_attempt(&second, &q, U256::from(9_000_000), 0, false),
    )
    .await;
    assert_ne!(a.is_ok(), b.is_ok());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM base_audit_attempts")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(count, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_signed_retry_unknown_l1_replay_and_reorg_accounting(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let signed = sign_fixture(&attempt).await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    assert_eq!(
        store.base_attempts(&claim).await?[0].signed.as_ref(),
        Some(&signed)
    );
    let (receipt, block) = receipt_fixture(&attempt, signed.hash(), true, None)?;
    store
        .record_base_inclusion(&claim, &receipt, &block)
        .await?;
    store
        .record_base_inclusion(&claim, &receipt, &block)
        .await?;
    let r = sqlx::query(
        "SELECT reservation::text,settled::text,fee_warning FROM base_audit_intents WHERE id=$1",
    )
    .bind(claim.intent.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(r.get::<String, _>("reservation"), "570000");
    assert_eq!(r.get::<String, _>("settled"), "50000");
    assert!(r.get::<bool, _>("fee_warning"));
    let replacement = SealedHeader {
        hash: B256::from([99; 32]),
        ..block.clone()
    };
    store
        .record_base_reorg(ids.corp_id, input.id, block.hash, &replacement)
        .await?;
    let r =
        sqlx::query("SELECT reservation::text,settled::text FROM base_audit_intents WHERE id=$1")
            .bind(claim.intent.id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(r.get::<String, _>("reservation"), "620000");
    assert_eq!(r.get::<Option<String>, _>("settled"), None);
    assert!(store.check_base_fence(&claim).await.is_err());
    let reorged = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(
        reorged.enabled,
        "tentative reorg retains explicit enable authorization"
    );
    assert!(reorged.restore_required);
    assert!(
        store
            .base_observation_page(ids.corp_id, input.id, &replacement)
            .await?
            .headers
            .is_empty()
    );
    store
        .complete_base_validation(
            ids.corp_id,
            input.id,
            BaseValidation {
                epoch: "test-journal",
                cursor: 1,
                requests: &[attempt.request],
                pending_nonce: 0,
                observation: &json!({"rescanned":true}),
            },
        )
        .await?;
    let recovered = store
        .claim_base_intent(ids.corp_id, input.id, Uuid::new_v4())
        .await?
        .context("tentative reorg permits a fresh fenced reconciliation claim")?;
    assert_eq!(
        store.base_attempts(&recovered).await?[0].signed.as_ref(),
        Some(&signed)
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_noop_receipt_cannot_release_nonce_without_own_finality(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let attempt = store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    let signed = sign_fixture(&attempt).await?;
    store
        .persist_base_signed(&claim, &attempt.request, &signed, 1)
        .await?;
    let (noop, block) = receipt_fixture(&attempt, signed.hash(), false, Some(U256::from(1000)))?;
    store.record_base_inclusion(&claim, &noop, &block).await?;
    assert!(
        noop.exact_event(
            input.config.contract_address,
            &attempt.request.transaction.call,
            input.config.publisher
        )
        .is_err()
    );
    let (original, original_block) =
        receipt_fixture(&attempt, B256::from([88; 32]), true, Some(U256::from(1000)))?;
    let event = original.exact_event(
        input.config.contract_address,
        &attempt.request.transaction.call,
        input.config.publisher,
    )?;
    store
        .observe_base_event(ids.corp_id, input.id, &event, &original, &original_block)
        .await?;
    let finality = FinalizedAnchor {
        receipt: original,
        event,
        included: original_block.clone(),
        observations: finality_fixture(&original_block),
        assurance: Assurance::ProviderObservedFinalized,
    };
    assert!(store.finalize_base_anchor(&claim, &finality).await.is_err());
    store
        .record_base_spend_finality(&claim, &noop, &block, &finality_fixture(&block))
        .await?;
    store.finalize_base_anchor(&claim, &finality).await?;
    let status = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert_eq!(status.verified_sequence, claim.intent.sequence);
    let replacement = SealedHeader {
        hash: B256::from([99; 32]),
        ..original_block
    };
    store
        .record_base_reorg(
            ids.corp_id,
            input.id,
            finality.event.block_hash,
            &replacement,
        )
        .await?;
    assert_eq!(
        store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .status,
        "finalized_contradiction"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_uncertain_nonce_pauses_all_shared_wallet_streams(pool: PgPool) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    let second = second_destination(&store, &ids, &input).await?;
    store
        .quarantine_base_wallet(&claim, "nonce_conflict")
        .await?;
    for id in [input.id, second.id] {
        let d = store
            .base_destination(ids.corp_id, ids.alice_actor_id, id)
            .await?;
        assert!(!d.enabled && d.restore_required);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_previous_month_unresolved_liability_does_not_free_budget(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, input) = base_fixture(pool).await?;
    let claim = archived_claim(&store, &ids, &input).await?;
    store
        .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
        .await?;
    // Synthetic finalized nonce with unresolved fee accounting from the previous UTC month.
    sqlx::query("UPDATE base_audit_intents SET terminal=true,reservation=2900000,settled=1000,inclusion_month=(date_trunc('month',now() AT TIME ZONE 'UTC')-interval '1 month')::date WHERE id=$1")
        .bind(claim.intent.id).execute(&store.pool).await?;
    sqlx::query(
        "UPDATE base_audit_sender_lanes SET active_intent=NULL,active_corp_id=NULL,next_nonce=0",
    )
    .execute(&store.pool)
    .await?;
    let second = second_destination(&store, &ids, &input).await?;
    store
        .request_base_anchor(ids.corp_id, ids.alice_actor_id, second.id, Uuid::new_v4())
        .await?;
    let claim = store
        .claim_base_intent(ids.corp_id, second.id, Uuid::new_v4())
        .await?
        .context("claim")?;
    assert!(
        store
            .reserve_base_attempt(&claim, &quote(), U256::from(9_000_000), 0, false)
            .await
            .is_err()
    );
    assert!(store.base_attempts(&claim).await?.is_empty());
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL; run base_v2_ with --ignored"]
async fn base_v2_unsolicited_unavailable_event_resolves_only_after_private_evidence_restored(
    pool: PgPool,
) -> Result<()> {
    use std::str::FromStr;
    let (store, ids, input) = base_fixture(pool).await?;
    enable_fixture(&store, &ids, &input).await?;
    let record: Value =
        sqlx::query_scalar("SELECT record FROM state_audit_checkpoints WHERE corp_id=$1")
            .bind(ids.corp_id)
            .fetch_one(&store.pool)
            .await?;
    let checkpoint: crony_audit::SignedCheckpoint = serde_json::from_value(record.clone())?;
    let request = SignRequest {
        attempt_id: Uuid::new_v4(),
        intent_id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        manifest_digest: input.config.manifest_digest,
        immutable_key_identity: input.config.signer_key_identity.clone(),
        transaction: FrozenTransaction {
            chain_id: 84532,
            sender: input.config.publisher,
            contract: input.config.contract_address,
            nonce: 0,
            gas_limit: 100_000,
            max_fee_per_gas: 5,
            max_priority_fee_per_gas: 1,
            call: crony_base::abi::AnchorCall {
                stream_id: input.config.stream_id,
                sequence: checkpoint.checkpoint.last_sequence,
                checkpoint_digest: B256::from_str(&checkpoint.digest)?,
                previous_anchor_digest: B256::ZERO,
            },
        },
    };
    let attempt = BaseAttempt {
        request,
        ordinal: 0,
        created_at: Utc::now(),
        signed: None,
    };
    let (receipt, block) =
        receipt_fixture(&attempt, B256::from([88; 32]), true, Some(U256::from(1000)))?;
    let event = receipt.exact_event(
        input.config.contract_address,
        &attempt.request.transaction.call,
        input.config.publisher,
    )?;
    // Simulate missing local checkpoint bytes in this SQLx-owned database only.
    sqlx::query(
        "ALTER TABLE state_audit_checkpoints DISABLE TRIGGER state_audit_checkpoints_immutable",
    )
    .execute(&store.pool)
    .await?;
    sqlx::query("DELETE FROM state_audit_checkpoints WHERE corp_id=$1")
        .bind(ids.corp_id)
        .execute(&store.pool)
        .await?;
    sqlx::query(
        "ALTER TABLE state_audit_checkpoints ENABLE TRIGGER state_audit_checkpoints_immutable",
    )
    .execute(&store.pool)
    .await?;
    assert_eq!(
        store
            .observe_base_event(ids.corp_id, input.id, &event, &receipt, &block)
            .await?,
        "evidence_unavailable"
    );
    let d = store
        .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
        .await?;
    assert!(d.observed_sequence > 0 && d.verified_sequence == 0);
    assert!(
        store
            .request_base_anchor(ids.corp_id, ids.alice_actor_id, input.id, Uuid::new_v4())
            .await
            .is_err()
    );
    sqlx::query(
        "INSERT INTO state_audit_checkpoints(corp_id,sequence,digest,record) VALUES($1,$2,$3,$4)",
    )
    .bind(ids.corp_id)
    .bind(i64::try_from(checkpoint.checkpoint.last_sequence)?)
    .bind(&checkpoint.digest)
    .bind(record)
    .execute(&store.pool)
    .await?;
    assert_eq!(
        store
            .observe_base_event(ids.corp_id, input.id, &event, &receipt, &block)
            .await?,
        "verified_included"
    );
    assert_eq!(
        store
            .base_destination(ids.corp_id, ids.alice_actor_id, input.id)
            .await?
            .verified_sequence,
        i64::try_from(checkpoint.checkpoint.last_sequence)?
    );
    Ok(())
}
