use super::*;
use crony_domain::MissionContractRevisionAction;

#[path = "state_audit_factory_replay_tests.rs"]
mod factory_replay;

async fn fixture(
    pool: PgPool,
) -> Result<(
    PgStore,
    DemoIds,
    MissionPlanIds,
    TaskContract,
    VerificationPolicy,
)> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    let contract: TaskContract = serde_json::from_value(json!({
        "objective":"Write result.md","expected_output":"result.md","acceptance_tests":["exists"],
        "allowed_tools":["filesystem"],"prohibited_actions":["no deployment"],"references":[],
        "write_scope":["result.md"],"budget_tokens":1000,"budget_cost_microusd":100000,
        "deadline_at":null,"escalation":"ask owner","secret_refs":[],
        "source_repository":null,"source_base_ref":null,"source_base_commit":null,
        "model":null,"reasoning_effort":null,"deliverable":null,"workspace_connection_id":null
    }))?;
    let policy = VerificationPolicy {
        checks: vec![VerifierCheck::File {
            path: "result.md".into(),
            min_bytes: 1,
        }],
        manual_gate: None,
    };
    let plan: TaskGraphPlan = serde_json::from_value(json!({
        "strategy":"single","max_nodes":1,"max_depth":0,"budget_tokens":1000,
        "budget_cost_microusd":100000,"staffing":[],
        "tasks":[{"key":"deliver","title":"audit fixture","assigned_agent_id":ids.worker_agent_id,
            "required_adapter":"fake-process","depends_on":[],"depth":0,"max_attempts":1,
            "contract":contract,"verification_policy":policy}]
    }))?;
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Audit fixture",
            "Initial specification",
            &plan,
        )
        .await?;
    Ok((store, ids, mission, contract, policy))
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_coverage_identity_survives_governance_mutations(pool: PgPool) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let fingerprint: String =
        sqlx::query_scalar("SELECT fingerprint FROM state_audit_coverage WHERE mission_id=$1")
            .bind(mission.mission_id)
            .fetch_one(&store.pool)
            .await?;
    for statement in [
        "DELETE FROM state_audit_coverage WHERE mission_id=$1",
        "UPDATE state_audit_coverage SET mission_id=gen_random_uuid() WHERE mission_id=$1",
        "UPDATE state_audit_coverage SET corp_id=gen_random_uuid() WHERE mission_id=$1",
    ] {
        let mut tx = store.pool.begin().await?;
        sqlx::query("UPDATE missions SET budget_tokens=budget_tokens+1 WHERE id=$1")
            .bind(mission.mission_id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query(statement)
            .bind(mission.mission_id)
            .execute(&mut *tx)
            .await;
        tx.rollback().await?;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("audit coverage identity"),
            "coverage cannot be removed or reassigned to bypass the deferred guard"
        );
    }
    store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: mission.mission_id,
            task_id: mission.task_ids[0],
            expected_contract_version: 1,
            next_action: MissionContractRevisionAction::Redispatch,
            source_run_id: None,
            reason: "authorized refresh".into(),
            idempotency_key: Uuid::new_v4(),
            description: "Revised covered specification".into(),
            contract,
            verification_policy: policy,
        })
        .await?;
    let row = sqlx::query(
        "SELECT corp_id,fingerprint,state_audit_fingerprint(mission_id) AS actual FROM state_audit_coverage WHERE mission_id=$1",
    )
    .bind(mission.mission_id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(row.get::<Uuid, _>("corp_id"), ids.corp_id);
    assert_ne!(row.get::<String, _>("fingerprint"), fingerprint);
    assert_eq!(
        row.get::<String, _>("fingerprint"),
        row.get::<String, _>("actual")
    );
    let error = sqlx::query("UPDATE missions SET budget_tokens=budget_tokens+1 WHERE id=$1")
        .bind(mission.mission_id)
        .execute(&store.pool)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("without an atomic state audit decision")
    );
    Ok(())
}

#[sqlx::test(migrations = false)]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_additive_guard_upgrades_existing_foundation(pool: PgPool) -> Result<()> {
    let source = sqlx::migrate!("../../db/migrations");
    let previous = sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(
            source.iter().filter(|m| m.version <= 46).cloned().collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    let foundation = sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(
            source
                .iter()
                .filter(|m| m.version <= 46 || m.version == 50)
                .cloned()
                .collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    previous.run(&pool).await?;
    let before: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await?;
    assert_eq!(before.len(), 46);
    foundation.run(&pool).await?;
    foundation.run(&pool).await?;
    let after: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await?;
    assert_eq!(after.len(), 47);
    assert_eq!(&after[..46], before.as_slice());
    assert_eq!(after[46].0, 50);
    assert!(matches!(
        previous.run(&pool).await,
        Err(sqlx::migrate::MigrateError::VersionMissing(50))
    ));
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_nonmonotonic_budget_refusal_is_audited_and_replayed(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    for (tokens, cost) in [(1000, 100000), (999, 100001), (1001, 99999)] {
        let input = ProposeMissionBudgetRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: mission.mission_id,
            expected_budget_tokens: 1000,
            expected_budget_cost_microusd: 100000,
            proposed_budget_tokens: tokens,
            proposed_budget_cost_microusd: cost,
            rationale: "  Review this bounded proposal  ".into(),
            idempotency_key: Uuid::new_v4(),
            finish_scope: None,
        };
        let first = store
            .propose_mission_budget_revision(input.clone())
            .await
            .unwrap_err();
        let receipt = store
            .audit_receipt(ids.corp_id, ids.alice_actor_id, input.idempotency_key)
            .await?
            .context("structurally valid monotonicity refusal must have a receipt")?;
        assert_eq!(receipt.decision, "refused");
        assert!(receipt.resource_results.is_empty());
        assert!(first.to_string().contains("must increase"));
        assert!(first.to_string().contains(&receipt.row_hash));
        let mut retry = input.clone();
        retry.rationale = retry.rationale.trim().into();
        assert_eq!(
            first.to_string(),
            store
                .propose_mission_budget_revision(retry)
                .await
                .unwrap_err()
                .to_string()
        );
        assert_eq!(
            Some(receipt),
            store
                .audit_receipt(ids.corp_id, ids.alice_actor_id, input.idempotency_key)
                .await?
        );
        let mut changed = input.clone();
        changed.proposed_budget_tokens += 1;
        assert!(
            store
                .propose_mission_budget_revision(changed)
                .await
                .unwrap_err()
                .to_string()
                .contains("different semantic inputs")
        );
        for invalid in [
            ProposeMissionBudgetRevisionInput {
                actor_id: ids.eve_actor_id,
                ..input.clone()
            },
            ProposeMissionBudgetRevisionInput {
                rationale: String::new(),
                idempotency_key: Uuid::new_v4(),
                ..input.clone()
            },
        ] {
            assert!(
                store
                    .propose_mission_budget_revision(invalid.clone())
                    .await
                    .is_err()
            );
            assert_eq!(
                0,
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM state_audit_decisions WHERE actor_id=$1 AND request_id=$2",
                )
                .bind(invalid.actor_id).bind(invalid.idempotency_key)
                .fetch_one(&store.pool).await?
            );
        }
    }
    assert_eq!(
        4,
        sqlx::query_scalar::<_, i64>(
            "SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1"
        )
        .bind(ids.corp_id)
        .fetch_one(&store.pool)
        .await?
    );
    assert_eq!(
        0,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM mission_budget_revisions")
            .fetch_one(&store.pool)
            .await?
    );
    assert_eq!(
        (1000_i64, 100000_i64),
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT budget_tokens,budget_cost_microusd FROM missions WHERE id=$1"
        )
        .bind(mission.mission_id)
        .fetch_one(&store.pool)
        .await?
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_atomic_revision_retry_refusal_and_rollback(pool: PgPool) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let first = CreateMissionContractRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        task_id: mission.task_ids[0],
        expected_contract_version: 1,
        next_action: MissionContractRevisionAction::Redispatch,
        source_run_id: None,
        reason: "approved correction".into(),
        idempotency_key: Uuid::new_v4(),
        description: "Revised specification".into(),
        contract,
        verification_policy: policy,
    };
    store
        .create_mission_contract_revision(first.clone())
        .await?;
    let mut foreign = first.clone();
    foreign.corp_id = Uuid::new_v4();
    foreign.idempotency_key = Uuid::new_v4();
    assert!(
        store
            .create_mission_contract_revision(foreign)
            .await
            .is_err()
    );
    assert!(
        store
            .audit_export(Uuid::new_v4(), ids.alice_actor_id)
            .await
            .is_err()
    );
    let mut outsider = first.clone();
    outsider.actor_id = ids.eve_actor_id;
    outsider.idempotency_key = Uuid::new_v4();
    assert!(
        store
            .create_mission_contract_revision(outsider)
            .await
            .is_err()
    );
    let receipt = store
        .audit_receipt(ids.corp_id, ids.alice_actor_id, first.idempotency_key)
        .await?
        .unwrap();
    let mut second = first.clone();
    second.idempotency_key = Uuid::new_v4();
    second.expected_contract_version = 2;
    second.description = "Later specification".into();
    store.create_mission_contract_revision(second).await?;
    store
        .create_mission_contract_revision(first.clone())
        .await?;
    assert_eq!(
        Some(receipt),
        store
            .audit_receipt(ids.corp_id, ids.alice_actor_id, first.idempotency_key)
            .await?
    );
    let mut stale = first.clone();
    stale.idempotency_key = Uuid::new_v4();
    let first_refusal = store
        .create_mission_contract_revision(stale.clone())
        .await
        .unwrap_err()
        .to_string();
    let refused = store
        .audit_receipt(ids.corp_id, ids.alice_actor_id, stale.idempotency_key)
        .await?
        .unwrap();
    assert_eq!(refused.decision, "refused");
    assert!(refused.resource_results.is_empty());
    let replayed_refusal = store
        .create_mission_contract_revision(stale.clone())
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(first_refusal, replayed_refusal);
    assert!(first_refusal.contains(&refused.row_hash));
    assert!(
        store
            .audit_receipt(ids.corp_id, ids.eve_actor_id, first.idempotency_key)
            .await?
            .is_none()
    );
    let before: i64 =
        sqlx::query_scalar("SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1")
            .bind(ids.corp_id)
            .fetch_one(&store.pool)
            .await?;
    // A missed mutation path must fail at commit, rather than leave stale audit refs.
    assert!(
        sqlx::query("UPDATE missions SET budget_tokens=budget_tokens+1 WHERE id=$1")
            .bind(mission.mission_id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    let after: i64 =
        sqlx::query_scalar("SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1")
            .bind(ids.corp_id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(before, after);
    assert!(
        store
            .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_precoverage_native_retry_is_not_retroactively_audited(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    let input = CreateMissionContractRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        task_id: mission.task_ids[0],
        expected_contract_version: 1,
        next_action: MissionContractRevisionAction::Redispatch,
        source_run_id: None,
        reason: "completed before audit adoption".into(),
        idempotency_key: Uuid::new_v4(),
        description: "Pre-coverage specification".into(),
        contract,
        verification_policy: policy,
    };
    store
        .create_mission_contract_revision(input.clone())
        .await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let error = store
        .create_mission_contract_revision(input.clone())
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("predates audit coverage"));
    assert_eq!(
        1,
        sqlx::query_scalar::<_, i64>(
            "SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1"
        )
        .bind(ids.corp_id)
        .fetch_one(&store.pool)
        .await?
    );
    assert!(
        store
            .audit_receipt(ids.corp_id, ids.alice_actor_id, input.idempotency_key)
            .await?
            .is_none()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_checkpoint_export_is_complete_and_replays_exactly(pool: PgPool) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    let ledger = Uuid::new_v4();
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let first = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    assert_eq!(
        first,
        store
            .audit_checkpoint(ids.corp_id, "fixture-key", &key)
            .await?
    );
    store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: mission.mission_id,
            task_id: mission.task_ids[0],
            expected_contract_version: 1,
            next_action: MissionContractRevisionAction::Redispatch,
            source_run_id: None,
            reason: "rotate checkpoint signer".into(),
            idempotency_key: Uuid::new_v4(),
            description: "Second signed prefix".into(),
            contract,
            verification_policy: policy,
        })
        .await?;
    let rotated_key = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let cp = store
        .audit_checkpoint(ids.corp_id, "rotated-key", &rotated_key)
        .await?;
    let archive = store.audit_export(ids.corp_id, ids.alice_actor_id).await?;
    assert!(
        archive
            .verify(&key.verifying_key(), Some(&cp.digest))
            .is_err()
    );
    archive.verify_with_key_history(&archive.signing_keys, Some(&cp.digest))?;
    assert_eq!(archive.signing_keys.len(), 2);
    assert_eq!(archive.signing_keys[0].retired_sequence, Some(1));
    assert_eq!(archive.signing_keys[1].activated_sequence, 2);
    store
        .validate_audit_witness(
            ids.corp_id,
            ledger,
            &first.digest,
            &rotated_key.verifying_key(),
        )
        .await?;
    assert!(
        store
            .validate_audit_witness(ids.corp_id, ledger, &"00".repeat(32), &key.verifying_key())
            .await
            .is_err()
    );
    assert!(
        store
            .validate_audit_witness(
                ids.corp_id,
                Uuid::new_v4(),
                &cp.digest,
                &rotated_key.verifying_key()
            )
            .await
            .is_err()
    );
    let mut tampered = archive.clone();
    tampered.refs.clear();
    assert!(
        tampered
            .verify_with_key_history(&tampered.signing_keys.clone(), None)
            .is_err()
    );
    let mut tampered = archive.clone();
    tampered.rows.clear();
    assert!(
        tampered
            .verify_with_key_history(&tampered.signing_keys.clone(), None)
            .is_err()
    );
    let mut tampered = archive;
    tampered.rows[0].objects.pop();
    assert!(
        tampered
            .verify_with_key_history(&tampered.signing_keys.clone(), None)
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_existing_checkpoint_key_is_adopted_after_schema_upgrade(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    sqlx::query(
        "ALTER TABLE state_audit_signing_keys DISABLE TRIGGER state_audit_signing_keys_delete_guard",
    )
    .execute(&store.pool)
    .await?;
    sqlx::query("DELETE FROM state_audit_signing_keys WHERE corp_id=$1")
        .bind(ids.corp_id)
        .execute(&store.pool)
        .await?;
    sqlx::query(
        "ALTER TABLE state_audit_signing_keys ENABLE TRIGGER state_audit_signing_keys_delete_guard",
    )
    .execute(&store.pool)
    .await?;
    let adopted = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    let original_digest: String = sqlx::query_scalar(
        "SELECT digest FROM state_audit_checkpoints WHERE corp_id=$1 AND sequence=1",
    )
    .bind(ids.corp_id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(adopted.digest, original_digest);
    store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            corp_id: ids.corp_id,
            actor_id: ids.alice_actor_id,
            mission_id: mission.mission_id,
            task_id: mission.task_ids[0],
            expected_contract_version: 1,
            next_action: MissionContractRevisionAction::Redispatch,
            source_run_id: None,
            reason: "legacy key adoption".into(),
            idempotency_key: Uuid::new_v4(),
            description: "Adopt legacy checkpoint key".into(),
            contract,
            verification_policy: policy,
        })
        .await?;
    let rotated = crony_audit::SigningKey::from_bytes(&[8; 32]);
    store
        .audit_checkpoint(ids.corp_id, "rotated-key", &rotated)
        .await?;
    let archive = store.audit_export(ids.corp_id, ids.alice_actor_id).await?;
    assert_eq!(archive.signing_keys.len(), 2);
    assert_eq!(archive.signing_keys[0].activated_sequence, 1);
    assert_eq!(archive.signing_keys[0].retired_sequence, Some(1));
    assert_eq!(archive.signing_keys[1].activated_sequence, 2);
    archive.verify_with_key_history(&archive.signing_keys, None)?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_capacity_and_sql_index_corruption_fail_closed(pool: PgPool) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    // Simulate database-owner corruption, bypassing the immutable trigger in
    // this disposable database only. The signing path must still detect it.
    sqlx::query(
        "ALTER TABLE state_audit_decisions DISABLE TRIGGER state_audit_decisions_immutable",
    )
    .execute(&store.pool)
    .await?;
    sqlx::query("UPDATE state_audit_decisions SET receipt=jsonb_set(receipt,'{sequence}','99') WHERE corp_id=$1").bind(ids.corp_id).execute(&store.pool).await?;
    assert!(
        store
            .audit_checkpoint(ids.corp_id, "fixture-key", &key)
            .await
            .is_err(),
        "SQL receipt/index corruption must not be accepted"
    );
    sqlx::query("UPDATE state_audit_decisions SET receipt=jsonb_set(receipt,'{sequence}','1') WHERE corp_id=$1").bind(ids.corp_id).execute(&store.pool).await?;
    sqlx::query("ALTER TABLE state_audit_decisions ENABLE TRIGGER state_audit_decisions_immutable")
        .execute(&store.pool)
        .await?;
    // Exercise the actual admission bound without thousands of native runs.
    sqlx::query("INSERT INTO state_audit_decisions(corp_id,sequence,mission_id,actor_id,request_id,request_digest,row_hash,bytes,decision,object_hashes,receipt) SELECT corp_id,s,mission_id,actor_id,gen_random_uuid(),request_digest,md5(s::text)||md5(s::text),bytes,decision,object_hashes,receipt FROM state_audit_decisions CROSS JOIN generate_series(2,4096) s WHERE corp_id=$1 AND sequence=1").bind(ids.corp_id).execute(&store.pool).await?;
    sqlx::query("UPDATE state_audit_ledgers SET last_sequence=4096 WHERE corp_id=$1")
        .bind(ids.corp_id)
        .execute(&store.pool)
        .await?;
    let input = CreateMissionContractRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        task_id: mission.task_ids[0],
        expected_contract_version: 1,
        next_action: MissionContractRevisionAction::Redispatch,
        source_run_id: None,
        reason: "capacity fixture".into(),
        idempotency_key: Uuid::new_v4(),
        description: "Must roll back".into(),
        contract,
        verification_policy: policy,
    };
    assert!(
        store.create_mission_contract_revision(input).await.is_err(),
        "capacity overflow must roll back native mutation"
    );
    let version: i64 = sqlx::query_scalar("SELECT specification_version FROM missions WHERE id=$1")
        .bind(mission.mission_id)
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(version, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_durable_independent_anchor_schedules(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    let github = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    let ethereum = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "ethereum".into(),
        interval_seconds: 31_536_000,
        calendar_schedule: Some(state_audit::AuditCalendarSchedule {
            day_of_month: 1,
            hour_utc: 0,
            minute_utc: 0,
        }),
        overdue_after_seconds: 2_678_400,
        workflow_gate: "finalized".into(),
        config: json!({"chain_id":1,"contract":"future-v2"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &github)
        .await?;
    store
        .configure_audit_destination(ids.alice_actor_id, &ethereum)
        .await?;
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT scheduled_due > now() FROM state_audit_destinations WHERE id=$1"
        )
        .bind(ethereum.id)
        .fetch_one(&store.pool)
        .await?
    );
    assert!(
        !store
            .audit_workflow_gate_satisfied(ids.corp_id, github.id, 1)
            .await?
    );
    assert!(
        !store
            .audit_workflow_gate_satisfied(ids.corp_id, ethereum.id, 1)
            .await?
    );
    let mut gated = store.pool.begin().await?;
    assert!(
        PgStore::ensure_audit_workflow_gates_tx(&mut gated, ids.corp_id)
            .await
            .is_err()
    );
    gated.rollback().await?;
    let due = store.due_audit_destinations().await?;
    assert!(due.iter().any(|d| d.id == github.id));
    assert!(!due.iter().any(|d| d.id == ethereum.id));
    let status = store.audit_status(ids.corp_id, ids.alice_actor_id).await?;
    assert_eq!(status["destinations"].as_array().unwrap().len(), 2);
    assert_eq!(status["receipts"][0]["status"], "pending");
    assert_eq!(status["assurance"]["latest_committed_sequence"], 1);
    assert_eq!(status["assurance"]["latest_github_published_sequence"], 0);
    assert_eq!(status["assurance"]["latest_ethereum_finalized_sequence"], 0);
    assert_eq!(
        status["destinations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|destination| destination["id"] == ethereum.id.to_string())
            .unwrap()["calendar_schedule"]["day_of_month"],
        1
    );
    sqlx::query("UPDATE state_audit_destinations SET next_due=now()+interval '1 year' WHERE id=$1")
        .bind(github.id)
        .execute(&store.pool)
        .await?;
    assert!(
        !store
            .due_audit_destinations()
            .await?
            .iter()
            .any(|d| d.id == github.id)
    );
    store
        .request_audit_publication(ids.corp_id, ids.alice_actor_id, github.id)
        .await?;
    assert!(
        store
            .due_audit_destinations()
            .await?
            .iter()
            .any(|d| d.id == github.id)
    );
    assert!(
        store
            .request_audit_publication(ids.corp_id, ids.alice_actor_id, ethereum.id)
            .await
            .is_err()
    );
    for _ in 2..64 {
        let mut extra = github.clone();
        extra.id = Uuid::new_v4();
        store
            .configure_audit_destination(ids.alice_actor_id, &extra)
            .await?;
    }
    let mut extra = github.clone();
    extra.id = Uuid::new_v4();
    assert!(
        store
            .configure_audit_destination(ids.alice_actor_id, &extra)
            .await
            .is_err()
    );
    store
        .configure_audit_destination(ids.alice_actor_id, &github)
        .await?;
    assert_eq!(
        store.audit_status(ids.corp_id, ids.alice_actor_id).await?["destinations"]
            .as_array()
            .unwrap()
            .len(),
        64
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_authority_checks_lock_actor_role_against_demotion(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    let mut authorized = store.pool.begin().await?;
    super::budget_revision::ensure_budget_manager_tx(
        &mut authorized,
        ids.corp_id,
        ids.alice_actor_id,
    )
    .await?;
    super::contract_revision::ensure_contract_revision_operator_tx(
        &mut authorized,
        ids.corp_id,
        ids.alice_actor_id,
        ids.alice_actor_id,
    )
    .await?;
    let mut demotion = store.pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '100ms'")
        .execute(&mut *demotion)
        .await?;
    assert!(
        sqlx::query("UPDATE actors SET role='member' WHERE id=$1 AND corp_id=$2")
            .bind(ids.alice_actor_id)
            .bind(ids.corp_id)
            .execute(&mut *demotion)
            .await
            .is_err(),
        "authorized mutation must retain its actor-role lock through commit"
    );
    demotion.rollback().await?;
    authorized.rollback().await?;
    let updated = sqlx::query("UPDATE actors SET role='member' WHERE id=$1 AND corp_id=$2")
        .bind(ids.alice_actor_id)
        .bind(ids.corp_id)
        .execute(&store.pool)
        .await?;
    assert_eq!(updated.rows_affected(), 1);
    let _ = mission;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_budget_proposal_retry_returns_original_after_approval(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,status,breaker_stage,workspace_disposition,provider_session_id,assignment_token,workspace_run_id) VALUES($1,$2,$3,$4,'audit-fixture','failed','suspend','preserved','local-fixture',gen_random_uuid(),$1)")
        .bind(Uuid::new_v4()).bind(ids.corp_id).bind(mission.task_ids[0]).bind(ids.worker_agent_id).execute(&store.pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let proposal = ProposeMissionBudgetRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        expected_budget_tokens: 1000,
        expected_budget_cost_microusd: 100000,
        proposed_budget_tokens: 2000,
        proposed_budget_cost_microusd: 200000,
        rationale: "finish within reviewed ceilings".into(),
        idempotency_key: Uuid::new_v4(),
        finish_scope: None,
    };
    let original = store
        .propose_mission_budget_revision(proposal.clone())
        .await?;
    let content:Value=sqlx::query_scalar("SELECT o.value FROM state_audit_refs r JOIN state_audit_objects v ON v.corp_id=r.corp_id AND v.hash=r.version_hash JOIN state_audit_objects o ON o.corp_id=v.corp_id AND o.hash=v.value->>'content_hash' WHERE r.corp_id=$1")
        .bind(ids.corp_id).fetch_one(&store.pool).await?;
    let pending = &content["pending_budget_proposals"][0];
    assert!(
        pending.get("replacement_contract_digest").is_some(),
        "pending contract commitment is missing"
    );
    assert!(
        pending.get("replacement_verification_digest").is_some(),
        "pending verifier commitment is missing"
    );
    let decision = DecideMissionBudgetRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        revision_id: original.revision.id,
        expected_version: 1,
        approved: true,
        note: "approved".into(),
        decision_key: Uuid::new_v4(),
    };
    store.decide_mission_budget_revision(decision).await?;
    let replay = store.propose_mission_budget_revision(proposal).await?;
    assert_eq!(original.revision.status, replay.revision.status);
    assert_eq!(original.revision.version, replay.revision.version);
    assert!(replay.replayed && replay.event.is_none());
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let cp = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    assert_eq!(cp.checkpoint.last_sequence, 3);
    store
        .audit_export(ids.corp_id, ids.alice_actor_id)
        .await?
        .verify(&key.verifying_key(), Some(&cp.digest))?;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_ledger_identity_is_immutable(pool: PgPool) -> Result<()> {
    let (store, ids, _, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    assert!(
        sqlx::query("UPDATE state_audit_ledgers SET ledger_id=$2 WHERE corp_id=$1")
            .bind(ids.corp_id)
            .bind(Uuid::new_v4())
            .execute(&store.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM state_audit_ledgers WHERE corp_id=$1")
            .bind(ids.corp_id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_covered_task_cannot_escape_by_reparenting(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO missions(id,corp_id,room_id,requested_by,title,description,status,budget_tokens,budget_cost_microusd,original_budget_tokens,original_budget_cost_microusd) SELECT $2,corp_id,room_id,requested_by,'other','other',status,budget_tokens,budget_cost_microusd,original_budget_tokens,original_budget_cost_microusd FROM missions WHERE id=$1")
        .bind(mission.mission_id).bind(other).execute(&store.pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    assert!(
        sqlx::query("UPDATE tasks SET mission_id=$2 WHERE id=$1")
            .bind(mission.task_ids[0])
            .bind(other)
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_legacy_source_commit_upgrade_is_audited_atomically(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    let work_item_id = Uuid::new_v4();
    let claim_token = Uuid::new_v4();
    sqlx::query(
        r#"
        UPDATE tasks
        SET contract = jsonb_set(
            jsonb_set(contract,'{source_repository}',to_jsonb('fixture/repository'::text),true),
            '{source_base_ref}',to_jsonb('HEAD'::text),true
        )
        WHERE id=$1
        "#,
    )
    .bind(mission.task_ids[0])
    .execute(&store.pool)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO factory_work_items(
            id,corp_id,source_kind,source_project_owner,source_project_number,
            source_project_item_id,source_repository_owner,source_repository_name,
            source_issue_number,source_issue_node_id,source_issue_url,source_title,
            source_revision,state,claim_owner_id,claim_token,lease_expires_at,policy,mission_id
        ) VALUES(
            $1,$2,'github_project_issue','fixture',1,'item','fixture','repository',
            281,'issue','https://github.com/fixture/repository/issues/281','audit',
            'revision','claimed',$3,$4,now()+interval '1 hour',$5,$6
        )
        "#,
    )
    .bind(work_item_id)
    .bind(ids.corp_id)
    .bind(ids.alice_actor_id)
    .bind(claim_token)
    .bind(json!({
        "source_base_ref":"HEAD",
        "source_commit_upgrade_required":true
    }))
    .bind(mission.mission_id)
    .execute(&store.pool)
    .await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let input = UpgradeFactorySourceCommitInput {
        corp_id: ids.corp_id,
        work_item_id,
        actor_id: ids.alice_actor_id,
        claim_token,
        expected_version: 1,
        idempotency_key: "source-upgrade".into(),
        source_base_commit: "ab".repeat(20),
    };
    let accepted = store.upgrade_factory_source_commit(input.clone()).await?;
    assert!(!accepted.replayed);
    let mut wrong_token = input.clone();
    wrong_token.claim_token = Uuid::new_v4();
    assert!(
        store
            .upgrade_factory_source_commit(wrong_token)
            .await
            .is_err()
    );
    let replayed = store.upgrade_factory_source_commit(input.clone()).await?;
    assert!(replayed.replayed);
    assert_eq!(replayed.claim_token, Some(claim_token));
    sqlx::query(
        "UPDATE factory_work_items SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(work_item_id)
    .execute(&store.pool)
    .await?;
    let expired_replay = store.upgrade_factory_source_commit(input.clone()).await?;
    assert!(expired_replay.replayed);
    assert_eq!(expired_replay.claim_token, None);
    let request_id = state_audit::derived_request_id(
        "factory-source-commit-upgrade",
        ids.corp_id,
        ids.alice_actor_id,
        &input.idempotency_key,
    )?;
    let receipt = store
        .audit_receipt(ids.corp_id, ids.alice_actor_id, request_id)
        .await?
        .context("missing source-upgrade audit receipt")?;
    assert_eq!(receipt.decision, "accepted");
    assert_eq!(receipt.sequence, 2);
    let commit: Option<String> =
        sqlx::query_scalar("SELECT contract->>'source_base_commit' FROM tasks WHERE id=$1")
            .bind(mission.task_ids[0])
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(
        commit.as_deref(),
        Some("abababababababababababababababababababab")
    );

    sqlx::query(
        "UPDATE factory_work_items SET lease_expires_at=now()+interval '1 hour' WHERE id=$1",
    )
    .bind(work_item_id)
    .execute(&store.pool)
    .await?;
    let stale_input = UpgradeFactorySourceCommitInput {
        corp_id: ids.corp_id,
        work_item_id,
        actor_id: ids.alice_actor_id,
        claim_token,
        expected_version: 1,
        idempotency_key: "source-upgrade-stale".into(),
        source_base_commit: "cd".repeat(20),
    };
    assert!(
        store
            .upgrade_factory_source_commit(stale_input.clone())
            .await
            .is_err()
    );
    let stale_request_id = state_audit::derived_request_id(
        "factory-source-commit-upgrade",
        ids.corp_id,
        ids.alice_actor_id,
        &stale_input.idempotency_key,
    )?;
    let stale_receipt = store
        .audit_receipt(ids.corp_id, ids.alice_actor_id, stale_request_id)
        .await?
        .context("missing stale source-upgrade refusal receipt")?;
    assert_eq!(stale_receipt.decision, "refused");
    assert!(
        store
            .upgrade_factory_source_commit(stale_input)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .audit_receipt(ids.corp_id, ids.alice_actor_id, stale_request_id)
            .await?
            .context("missing replayed stale source-upgrade refusal receipt")?,
        stale_receipt
    );
    let refused_input = UpgradeFactorySourceCommitInput {
        corp_id: ids.corp_id,
        work_item_id,
        actor_id: ids.alice_actor_id,
        claim_token,
        expected_version: 2,
        idempotency_key: "source-upgrade-refused".into(),
        source_base_commit: "cd".repeat(20),
    };
    assert!(
        store
            .upgrade_factory_source_commit(refused_input.clone())
            .await
            .is_err()
    );
    let refused_request_id = state_audit::derived_request_id(
        "factory-source-commit-upgrade",
        ids.corp_id,
        ids.alice_actor_id,
        &refused_input.idempotency_key,
    )?;
    let first_refusal = store
        .audit_receipt(ids.corp_id, ids.alice_actor_id, refused_request_id)
        .await?
        .context("missing source-upgrade refusal receipt")?;
    assert_eq!(first_refusal.decision, "refused");
    assert!(
        store
            .upgrade_factory_source_commit(refused_input)
            .await
            .is_err()
    );
    let replayed_refusal = store
        .audit_receipt(ids.corp_id, ids.alice_actor_id, refused_request_id)
        .await?
        .context("missing replayed source-upgrade refusal receipt")?;
    assert_eq!(replayed_refusal, first_refusal);
    Ok(())
}

#[derive(Default)]
struct PublicationFixture {
    files: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
    heads: std::sync::Mutex<usize>,
    writes: std::sync::Mutex<usize>,
    fail: std::sync::Mutex<Option<usize>>,
    rewritten: std::sync::Mutex<bool>,
    rewrite_after_writes: Option<usize>,
}
impl crony_audit::PublicationTransport for PublicationFixture {
    fn head(&self) -> futures_util::future::BoxFuture<'_, Result<String>> {
        Box::pin(async {
            *self.heads.lock().unwrap() += 1;
            Ok("fixture-head".into())
        })
    }
    fn descends_from<'a>(
        &'a self,
        _old: &'a str,
        _new: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<bool>> {
        Box::pin(async {
            Ok(!*self.rewritten.lock().unwrap()
                && !self
                    .rewrite_after_writes
                    .is_some_and(|threshold| *self.writes.lock().unwrap() >= threshold))
        })
    }
    fn read<'a>(
        &'a self,
        path: &'a str,
        _head: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<Option<Vec<u8>>>> {
        Box::pin(async move { Ok(self.files.lock().unwrap().get(path).cloned()) })
    }
    fn create<'a>(
        &'a self,
        path: &'a str,
        body: &'a [u8],
    ) -> futures_util::future::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut writes = self.writes.lock().unwrap();
            *writes += 1;
            anyhow::ensure!(
                *self.fail.lock().unwrap() != Some(*writes),
                "fixture transport interruption"
            );
            let mut files = self.files.lock().unwrap();
            anyhow::ensure!(!files.contains_key(path), "fixture conflict");
            files.insert(path.into(), body.into());
            Ok(())
        })
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_empty_checkpoint_destinations_do_not_starve_ready_corp(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "ready-key", &key)
        .await?;

    let empty_corp = Uuid::new_v4();
    let empty_owner = Uuid::new_v4();
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,$2,'Empty audit fixture')")
        .bind(empty_corp)
        .bind(format!("empty-audit-{empty_corp}"))
        .execute(&store.pool)
        .await?;
    sqlx::query("INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Empty audit owner','human','owner')")
        .bind(empty_owner).bind(empty_corp).execute(&store.pool).await?;
    store
        .initialize_state_audit(empty_corp, empty_owner, Uuid::new_v4())
        .await?;

    let mut empty_destinations = Vec::new();
    for _ in 0..16 {
        let destination = state_audit::AuditDestination {
            id: Uuid::new_v4(),
            corp_id: empty_corp,
            kind: "github".into(),
            interval_seconds: 60,
            calendar_schedule: None,
            overdue_after_seconds: 3600,
            workflow_gate: "published".into(),
            config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
        };
        store
            .configure_audit_destination(empty_owner, &destination)
            .await?;
        empty_destinations.push(destination.id);
    }
    sqlx::query("UPDATE state_audit_destinations SET next_due=now()-interval '2 hours',scheduled_due=now()-interval '2 hours' WHERE corp_id=$1")
        .bind(empty_corp).execute(&store.pool).await?;
    let ready_destination = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &ready_destination)
        .await?;
    let first_page = store.due_audit_destinations().await?;
    assert_eq!(first_page.len(), 16);
    let remote = PublicationFixture::default();
    for destination in first_page {
        assert!(empty_destinations.contains(&destination.id));
        assert!(
            !store
                .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
                .await?
        );
    }
    assert_eq!(*remote.heads.lock().unwrap(), 0);
    assert_eq!(*remote.writes.lock().unwrap(), 0);
    let bounded_retries: bool = sqlx::query_scalar(
        "SELECT bool_and(next_due > now() AND next_due <= now()+interval '60 seconds') FROM state_audit_destinations WHERE corp_id=$1",
    )
    .bind(empty_corp)
    .fetch_one(&store.pool)
    .await?;
    assert!(bounded_retries, "checkpoint absence must remain retryable");
    let second_page = store.due_audit_destinations().await?;
    assert_eq!(
        second_page.len(),
        1,
        "empty destinations must leave the next due page"
    );
    assert_eq!(second_page[0].id, ready_destination.id);
    assert!(
        store
            .publish_audit_destination(ready_destination.id, &remote, &key.verifying_key(), None)
            .await?
    );
    assert!(*remote.writes.lock().unwrap() > 0);
    let status = store.audit_status(empty_corp, empty_owner).await?;
    assert_eq!(status["assurance"]["overdue_destinations"], 16);
    for destination in status["destinations"].as_array().unwrap() {
        assert_eq!(destination["publication_disabled"], false);
        assert_eq!(destination["failures"], 0);
        assert_eq!(destination["last_published_sequence"], Value::Null);
        assert_eq!(destination["last_attempted_publication"], Value::Null);
        assert_eq!(destination["last_successful_publication"], Value::Null);
    }
    Ok(())
}

async fn publication_state(store: &PgStore, destination: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar(
        "SELECT jsonb_build_object('destination',to_jsonb(d),'receipts',(
            SELECT jsonb_agg(to_jsonb(r) ORDER BY r.checkpoint_digest)
            FROM state_audit_anchor_receipts r WHERE r.destination_id=d.id
        )) FROM state_audit_destinations d WHERE d.id=$1",
    )
    .bind(destination)
    .fetch_one(&store.pool)
    .await?)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_publication_rejects_partial_key_history_before_remote_effects(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let old_key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "old-key", &old_key)
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
            reason: "rotate publication signer".into(),
            idempotency_key: Uuid::new_v4(),
            description: "Second signed prefix".into(),
            contract,
            verification_policy: policy,
        })
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[8; 32]);
    let checkpoint = store
        .audit_checkpoint(ids.corp_id, "current-key", &key)
        .await?;
    let destination = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    // Corrupt only this disposable SQLx database; production history stays immutable.
    sqlx::query(
        "ALTER TABLE state_audit_signing_keys DISABLE TRIGGER state_audit_signing_keys_delete_guard",
    )
    .execute(&store.pool)
    .await?;
    sqlx::query("DELETE FROM state_audit_signing_keys WHERE corp_id=$1 AND key_id='current-key'")
        .bind(ids.corp_id)
        .execute(&store.pool)
        .await?;
    sqlx::query(
        "ALTER TABLE state_audit_signing_keys ENABLE TRIGGER state_audit_signing_keys_delete_guard",
    )
    .execute(&store.pool)
    .await?;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM state_audit_signing_keys WHERE corp_id=$1",
        )
        .bind(ids.corp_id)
        .fetch_one(&store.pool)
        .await?,
        1
    );
    let before = publication_state(&store, destination.id).await?;
    let remote = PublicationFixture::default();
    let error = store
        .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("missing from retained key history")
    );
    assert_eq!(publication_state(&store, destination.id).await?, before);
    assert_eq!(*remote.heads.lock().unwrap(), 0);
    assert_eq!(*remote.writes.lock().unwrap(), 0);
    assert!(remote.files.lock().unwrap().is_empty());

    // Restoring the retained row permits publication using its key, even when
    // the configured runtime key is the retired signer.
    sqlx::query("INSERT INTO state_audit_signing_keys(corp_id,key_id,public_key,activated_sequence) VALUES($1,'current-key',$2,$3)")
        .bind(ids.corp_id)
        .bind(key.verifying_key().to_bytes().as_slice())
        .bind(i64::try_from(checkpoint.checkpoint.last_sequence)?)
        .execute(&store.pool)
        .await?;
    assert!(
        store
            .publish_audit_destination(destination.id, &remote, &old_key.verifying_key(), None)
            .await?
    );
    assert!(*remote.writes.lock().unwrap() > 0);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_legacy_publication_requires_valid_runtime_key(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "legacy-key", &key)
        .await?;
    sqlx::query(
        "ALTER TABLE state_audit_signing_keys DISABLE TRIGGER state_audit_signing_keys_delete_guard",
    )
    .execute(&store.pool)
    .await?;
    sqlx::query("DELETE FROM state_audit_signing_keys WHERE corp_id=$1")
        .bind(ids.corp_id)
        .execute(&store.pool)
        .await?;
    sqlx::query(
        "ALTER TABLE state_audit_signing_keys ENABLE TRIGGER state_audit_signing_keys_delete_guard",
    )
    .execute(&store.pool)
    .await?;
    let destination = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    let before = publication_state(&store, destination.id).await?;
    let remote = PublicationFixture::default();
    let wrong_key = crony_audit::SigningKey::from_bytes(&[8; 32]);
    assert!(
        store
            .publish_audit_destination(destination.id, &remote, &wrong_key.verifying_key(), None)
            .await
            .is_err()
    );
    assert_eq!(publication_state(&store, destination.id).await?, before);
    assert_eq!(*remote.heads.lock().unwrap(), 0);
    assert_eq!(*remote.writes.lock().unwrap(), 0);
    assert!(
        store
            .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
            .await?
    );
    assert!(*remote.writes.lock().unwrap() > 0);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_midpublication_ancestry_rewrite_disables_destination(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    for threshold in [1, 4] {
        let destination = state_audit::AuditDestination {
            id: Uuid::new_v4(),
            corp_id: ids.corp_id,
            kind: "github".into(),
            interval_seconds: 60,
            calendar_schedule: None,
            overdue_after_seconds: 3600,
            workflow_gate: "published".into(),
            config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
        };
        store
            .configure_audit_destination(ids.alice_actor_id, &destination)
            .await?;
        let remote = PublicationFixture {
            rewrite_after_writes: Some(threshold),
            ..Default::default()
        };
        let error = store
            .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("GitHub branch changed ancestry"));
        let row = sqlx::query(
            "SELECT publication_disabled,last_error,reconciliation_error,failures FROM state_audit_destinations WHERE id=$1",
        ).bind(destination.id).fetch_one(&store.pool).await?;
        assert!(row.get::<bool, _>("publication_disabled"));
        assert_eq!(
            row.get::<String, _>("last_error"),
            "external_history_divergence"
        );
        assert_eq!(
            row.get::<String, _>("reconciliation_error"),
            "external_history_divergence"
        );
        assert_eq!(row.get::<i64, _>("failures"), 1);
        store
            .request_audit_publication(ids.corp_id, ids.alice_actor_id, destination.id)
            .await?;
        assert!(
            !store
                .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
                .await?
        );
        assert_eq!(*remote.writes.lock().unwrap(), threshold);
        assert!(
            !store
                .due_audit_destinations()
                .await?
                .iter()
                .any(|d| d.id == destination.id)
        );
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_durable_publisher_interruption_and_covering_catchup(pool: PgPool) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let old = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    let destination = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    sqlx::query(
        "UPDATE state_audit_destinations SET scheduled_due=now()-interval '2 hours' WHERE id=$1",
    )
    .bind(destination.id)
    .execute(&store.pool)
    .await?;
    let remote = PublicationFixture::default();
    *remote.fail.lock().unwrap() = Some(2);
    assert!(
        store
            .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
            .await
            .is_err()
    );
    let status = store.audit_status(ids.corp_id, ids.alice_actor_id).await?;
    assert_eq!(status["destinations"][0]["failures"], 1);
    assert_eq!(status["destinations"][0]["publication_disabled"], false);
    assert_eq!(status["receipts"][0]["status"], "pending");
    assert_eq!(status["assurance"]["overdue_destinations"], 1);
    let input = CreateMissionContractRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        task_id: mission.task_ids[0],
        expected_contract_version: 1,
        next_action: MissionContractRevisionAction::Redispatch,
        source_run_id: None,
        reason: "reviewed".into(),
        idempotency_key: Uuid::new_v4(),
        description: "New specification".into(),
        contract,
        verification_policy: policy,
    };
    store.create_mission_contract_revision(input).await?;
    sqlx::query("UPDATE state_audit_destinations SET next_due=now() WHERE id=$1")
        .bind(destination.id)
        .execute(&store.pool)
        .await?;
    let uncovered = store
        .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
        .await
        .unwrap_err()
        .to_string();
    assert!(uncovered.contains("does not cover the committed ledger head"));
    let new = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    assert_eq!(
        new.checkpoint.previous_checkpoint_digest.as_deref(),
        Some(old.digest.as_str())
    );
    *remote.fail.lock().unwrap() = None;
    sqlx::query("UPDATE state_audit_destinations SET next_due=now() WHERE id=$1")
        .bind(destination.id)
        .execute(&store.pool)
        .await?;
    store
        .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
        .await?;
    let writes = *remote.writes.lock().unwrap();
    sqlx::query("UPDATE state_audit_destinations SET next_due=now() WHERE id=$1")
        .bind(destination.id)
        .execute(&store.pool)
        .await?;
    store
        .publish_audit_destination(destination.id, &remote, &key.verifying_key(), None)
        .await?;
    assert_eq!(writes, *remote.writes.lock().unwrap());
    let receipts = store.audit_status(ids.corp_id, ids.alice_actor_id).await?["receipts"]
        .as_array()
        .unwrap()
        .clone();
    let older = receipts
        .iter()
        .find(|r| r["checkpoint_digest"] == old.digest)
        .unwrap();
    let newer = receipts
        .iter()
        .find(|r| r["checkpoint_digest"] == new.digest)
        .unwrap();
    assert_eq!(older["status"], "superseded");
    assert_eq!(older["witness"]["covered_by"], new.digest);
    assert_eq!(newer["witness"]["repository"], "fixture/audit");
    assert_eq!(newer["witness"]["path"], "audit");
    assert_eq!(newer["witness"]["finalized"], false);
    assert!(
        store
            .audit_workflow_gate_satisfied(
                ids.corp_id,
                destination.id,
                new.checkpoint.last_sequence
            )
            .await?
    );
    let mut gated = store.pool.begin().await?;
    PgStore::ensure_audit_workflow_gates_tx(&mut gated, ids.corp_id).await?;
    gated.rollback().await?;
    let status = store.audit_status(ids.corp_id, ids.alice_actor_id).await?;
    assert_eq!(
        status["assurance"]["latest_github_published_sequence"],
        new.checkpoint.last_sequence
    );
    assert_eq!(status["assurance"]["publication_errors"], 0);
    assert_eq!(status["assurance"]["overdue_destinations"], 0);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_reconciliation_and_configuration_lock_ledger_first(pool: PgPool) -> Result<()> {
    async fn waiting(pool: &PgPool, exclude_pid: i32) -> Result<(i32, String)> {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if let Some(waiter) = sqlx::query_as(
                    "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database()
                     AND wait_event_type='Lock' AND pid<>$1",
                )
                .bind(exclude_pid)
                .fetch_optional(pool)
                .await?
                {
                    return Ok(waiter);
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("expected database lock wait not observed")?
    }

    let (store, ids, mission, _, _) = fixture(pool).await?;
    let ledger = Uuid::new_v4();
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let checkpoint = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    let mut destination = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    store
        .disable_audit_destination_for_divergence(destination.id)
        .await?;
    let mut gate = store.pool.begin().await?;
    let gate_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await?;
    sqlx::query("SELECT id FROM state_audit_destinations WHERE id=$1 FOR UPDATE")
        .bind(destination.id)
        .execute(&mut *gate)
        .await?;
    destination.interval_seconds = 120;
    let configure = {
        let store = store.clone();
        let destination = destination.clone();
        tokio::spawn(async move {
            store
                .configure_audit_destination(ids.alice_actor_id, &destination)
                .await
        })
    };
    let (configure_pid, configure_query) = waiting(&store.pool, gate_pid).await?;
    assert!(configure_query.contains("FROM state_audit_destinations"));
    let reconcile = {
        let store = store.clone();
        tokio::spawn(async move {
            store
                .reconcile_audit_destination(
                    ids.corp_id,
                    ids.alice_actor_id,
                    destination.id,
                    state_audit::AuditReconciliation {
                        ledger_id: ledger,
                        checkpoint_digest: &checkpoint.digest,
                        github_commit: &"aa".repeat(20),
                    },
                    &PublicationFixture::default(),
                    &key.verifying_key(),
                )
                .await
        })
    };
    let (reconcile_pid, reconcile_query) = waiting(&store.pool, configure_pid).await?;
    let blocked_by_configure: bool = sqlx::query_scalar("SELECT $1=ANY(pg_blocking_pids($2))")
        .bind(configure_pid)
        .bind(reconcile_pid)
        .fetch_one(&store.pool)
        .await?;
    eprintln!(
        "Observed configure PID {configure_pid} waiting behind destination gate {gate_pid}; reconciliation PID {reconcile_pid}: {reconcile_query}"
    );
    gate.rollback().await?;
    let (configured, reconciled) =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(configure, reconcile)
        })
        .await?;
    configured??;
    reconciled??;
    assert!(
        reconcile_query.contains("FROM state_audit_ledgers") && blocked_by_configure,
        "reconciliation must wait on configuration's ledger before locking the destination: {reconcile_query}"
    );
    let row = sqlx::query(
        "SELECT interval_seconds,publication_disabled,reconciliation_error,last_commit
         FROM state_audit_destinations WHERE id=$1",
    )
    .bind(destination.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(row.get::<i64, _>("interval_seconds"), 120);
    assert!(!row.get::<bool, _>("publication_disabled"));
    assert!(
        row.get::<Option<String>, _>("reconciliation_error")
            .is_none()
    );
    assert_eq!(row.get::<String, _>("last_commit"), "aa".repeat(20));
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_restore_divergence_disables_until_explicit_reconciliation(
    pool: PgPool,
) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    let ledger = Uuid::new_v4();
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let checkpoint = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    let destination = state_audit::AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    store
        .disable_audit_destination_for_divergence(destination.id)
        .await?;
    assert!(
        !store
            .due_audit_destinations()
            .await?
            .iter()
            .any(|due| due.id == destination.id)
    );
    let publication = PublicationFixture::default();
    let retained_commit = "aa".repeat(20);
    assert!(
        store
            .reconcile_audit_destination(
                ids.corp_id,
                ids.alice_actor_id,
                destination.id,
                state_audit::AuditReconciliation {
                    ledger_id: ledger,
                    checkpoint_digest: &"00".repeat(32),
                    github_commit: &retained_commit,
                },
                &publication,
                &key.verifying_key(),
            )
            .await
            .is_err()
    );
    *publication.rewritten.lock().unwrap() = true;
    assert!(
        store
            .reconcile_audit_destination(
                ids.corp_id,
                ids.alice_actor_id,
                destination.id,
                state_audit::AuditReconciliation {
                    ledger_id: ledger,
                    checkpoint_digest: &checkpoint.digest,
                    github_commit: &retained_commit,
                },
                &publication,
                &key.verifying_key(),
            )
            .await
            .is_err()
    );
    *publication.rewritten.lock().unwrap() = false;
    store
        .reconcile_audit_destination(
            ids.corp_id,
            ids.alice_actor_id,
            destination.id,
            state_audit::AuditReconciliation {
                ledger_id: ledger,
                checkpoint_digest: &checkpoint.digest,
                github_commit: &retained_commit,
            },
            &publication,
            &key.verifying_key(),
        )
        .await?;
    let last_commit: Option<String> =
        sqlx::query_scalar("SELECT last_commit FROM state_audit_destinations WHERE id=$1")
            .bind(destination.id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(last_commit.as_deref(), Some(retained_commit.as_str()));
    assert!(
        store
            .due_audit_destinations()
            .await?
            .iter()
            .any(|due| due.id == destination.id)
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_concurrency_and_failed_audit_insert_rollback(pool: PgPool) -> Result<()> {
    let (store, ids, mission, contract, policy) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let input = CreateMissionContractRevisionInput {
        corp_id: ids.corp_id,
        actor_id: ids.alice_actor_id,
        mission_id: mission.mission_id,
        task_id: mission.task_ids[0],
        expected_contract_version: 1,
        next_action: MissionContractRevisionAction::Redispatch,
        source_run_id: None,
        reason: "reviewed".into(),
        idempotency_key: Uuid::new_v4(),
        description: "Concurrent revision".into(),
        contract,
        verification_policy: policy,
    };
    let (a, b) = futures_util::join!(
        store.create_mission_contract_revision(input.clone()),
        store.create_mission_contract_revision(input.clone())
    );
    assert_ne!(a?.replayed, b?.replayed);
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(m) FROM missions m WHERE id=$1")
        .bind(mission.mission_id)
        .fetch_one(&store.pool)
        .await?;
    let event_count: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE corp_id=$1")
        .bind(ids.corp_id)
        .fetch_one(&store.pool)
        .await?;
    sqlx::query("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON state_audit_decisions FOR EACH ROW EXECUTE FUNCTION state_audit_immutable()").execute(&store.pool).await?;
    let mut second = input;
    second.idempotency_key = Uuid::new_v4();
    second.expected_contract_version = 2;
    second.description = "Must rollback".into();
    assert!(
        store
            .create_mission_contract_revision(second)
            .await
            .is_err()
    );
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(m) FROM missions m WHERE id=$1")
        .bind(mission.mission_id)
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(before, after);
    assert_eq!(
        event_count,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM events WHERE corp_id=$1")
            .bind(ids.corp_id)
            .fetch_one(&store.pool)
            .await?
    );
    assert_eq!(
        2,
        sqlx::query_scalar::<_, i64>(
            "SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1"
        )
        .bind(ids.corp_id)
        .fetch_one(&store.pool)
        .await?
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue281_nonpolicy_error_is_not_fabricated_as_refusal(pool: PgPool) -> Result<()> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let op = state_audit::Operation {
        corp: ids.corp_id,
        actor: ids.alice_actor_id,
        mission: mission.mission_id,
        request_id: Uuid::new_v4(),
        name: "contract_revision",
        request: json!({}),
    };
    assert!(
        store
            .audited::<MissionContractRevisionOutcome, _>(op, |_| Box::pin(async {
                Err(anyhow!("unexpected decoder/integrity failure"))
            }))
            .await
            .is_err()
    );
    assert_eq!(
        1,
        sqlx::query_scalar::<_, i64>(
            "SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1"
        )
        .bind(ids.corp_id)
        .fetch_one(&store.pool)
        .await?
    );
    Ok(())
}
