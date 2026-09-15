use super::*;
use crony_domain::MissionContractRevisionAction;

pub(super) async fn fixture(
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
    writes: std::sync::Mutex<usize>,
    fail: std::sync::Mutex<Option<usize>>,
    rewritten: std::sync::Mutex<bool>,
}
impl crony_audit::PublicationTransport for PublicationFixture {
    fn head(&self) -> futures_util::future::BoxFuture<'_, Result<String>> {
        Box::pin(async { Ok("fixture-head".into()) })
    }
    fn descends_from<'a>(
        &'a self,
        _old: &'a str,
        _new: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<bool>> {
        Box::pin(async { Ok(!*self.rewritten.lock().unwrap()) })
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
            .publish_audit_destination(destination.id, &remote, &key.verifying_key())
            .await
            .is_err()
    );
    let status = store.audit_status(ids.corp_id, ids.alice_actor_id).await?;
    assert_eq!(status["destinations"][0]["failures"], 1);
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
        .publish_audit_destination(destination.id, &remote, &key.verifying_key())
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
        .publish_audit_destination(destination.id, &remote, &key.verifying_key())
        .await?;
    let writes = *remote.writes.lock().unwrap();
    sqlx::query("UPDATE state_audit_destinations SET next_due=now() WHERE id=$1")
        .bind(destination.id)
        .execute(&store.pool)
        .await?;
    store
        .publish_audit_destination(destination.id, &remote, &key.verifying_key())
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
