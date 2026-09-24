//! Covered Factory Resume classification through real SQLx transactions.
//! Synthetic retained metadata only: no provider, workspace, or publication effects.
use super::*;

async fn fixture(pool: PgPool) -> Result<(PgStore, CreateMissionContractRevisionInput)> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    sqlx::query("UPDATE agents SET adapter='codex' WHERE id=$1")
        .bind(ids.worker_agent_id)
        .execute(&store.pool)
        .await?;
    let contract: TaskContract = serde_json::from_value(json!({
        "objective":"Write result.md","expected_output":"result.md","acceptance_tests":["exists"],
        "allowed_tools":["filesystem"],"prohibited_actions":["no external effects"],"references":[],
        "write_scope":["result.md"],"budget_tokens":1000,"budget_cost_microusd":100000,
        "deadline_at":null,"escalation":"ask owner","secret_refs":[],
        "source_repository":"fixture/repository","source_base_ref":"main",
        "source_base_commit":"a".repeat(40),"model":null,"reasoning_effort":null,
        "deliverable":null,"workspace_connection_id":null
    }))?;
    let policy = VerificationPolicy {
        checks: vec![
            VerifierCheck::File {
                path: "result.md".into(),
                min_bytes: 1,
            },
            VerifierCheck::Artifact { min_bytes: 1 },
        ],
        manual_gate: Some(ManualVerificationGate::HumanApproval {
            roles: vec!["owner".into()],
        }),
    };
    let plan: TaskGraphPlan = serde_json::from_value(json!({
        "strategy":"single","max_nodes":1,"max_depth":0,"budget_tokens":1000,
        "budget_cost_microusd":100000,"staffing":[],
        "tasks":[{"key":"deliver","title":"Resume refusal fixture",
            "assigned_agent_id":ids.worker_agent_id,"required_adapter":"codex",
            "depends_on":[],"depth":0,"max_attempts":2,
            "contract":contract,"verification_policy":policy}]
    }))?;
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Resume refusal fixture",
            "Initial specification",
            &plan,
        )
        .await?;
    let source = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
            workspace_run_id,provider_session_id,workspace_path,workspace_disposition,
            source_repository,source_base_ref,source_base_commit,verification_status)
         VALUES($1,$2,$3,$4,'b03-synthetic-runner',$6,'failed',$1,'b03-synthetic-session',
            'b03-synthetic-workspace','preserved','fixture/repository','main',$5,'failed')",
    )
    .bind(source)
    .bind(ids.corp_id)
    .bind(mission.task_ids[0])
    .bind(ids.worker_agent_id)
    .bind("a".repeat(40))
    .bind(Uuid::new_v4())
    .execute(&store.pool)
    .await?;
    sqlx::query("UPDATE missions SET status='failed' WHERE id=$1")
        .bind(mission.mission_id)
        .execute(&store.pool)
        .await?;
    sqlx::query(
        "UPDATE tasks SET status='verification_failed',verification_status='failed',
            attempt_count=1 WHERE id=$1",
    )
    .bind(mission.task_ids[0])
    .execute(&store.pool)
    .await?;
    sqlx::query(
        "INSERT INTO factory_work_items(
            id,corp_id,source_kind,source_project_owner,source_project_number,
            source_project_item_id,source_repository_owner,source_repository_name,
            source_issue_number,source_issue_node_id,source_issue_url,source_title,
            source_revision,state,policy,mission_id,claim_owner_id,claim_token,lease_expires_at)
         VALUES($1,$2,'github_project_issue','fixture',1,'b03-item','fixture','repository',
            283,'b03-issue','https://github.com/fixture/repository/issues/283',
            'Resume refusal fixture','revision','verification_failed',$3,$4,$5,$6,
            now()+interval '1 hour')",
    )
    .bind(Uuid::new_v4())
    .bind(ids.corp_id)
    .bind(json!({"source_base_ref":"main","source_base_commit":"a".repeat(40)}))
    .bind(mission.mission_id)
    .bind(ids.alice_actor_id)
    .bind(Uuid::new_v4())
    .execute(&store.pool)
    .await?;
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
        next_action: MissionContractRevisionAction::Resume,
        source_run_id: Some(source),
        reason: "Correct the retained result".into(),
        idempotency_key: Uuid::new_v4(),
        description: "Revised specification".into(),
        contract,
        verification_policy: policy,
    };
    // Prove admission reaches the policy guard, rather than an invalid source fixture.
    let mut tx = store.pool.begin().await?;
    ensure_resumable_contract_revision_source_tx(&mut tx, input.corp_id, input.task_id, source)
        .await?;
    tx.rollback().await?;
    Ok((store, input))
}

async fn snapshot(store: &PgStore, corp: Uuid) -> Result<Value> {
    let mut result = json!({"domain":{}, "audit":{}});
    for (group, tables) in [
        (
            "domain",
            &[
                "missions",
                "tasks",
                "runs",
                "factory_work_items",
                "mission_contract_revisions",
                "events",
                "state_audit_coverage",
            ][..],
        ),
        (
            "audit",
            &[
                "state_audit_ledgers",
                "state_audit_decisions",
                "state_audit_refs",
                "state_audit_objects",
                "state_audit_local_results",
            ][..],
        ),
    ] {
        for table in tables {
            result[group][*table] = sqlx::query_scalar(
                &format!("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {table} t WHERE corp_id=$1"),
            )
            .bind(corp)
            .fetch_one(&store.pool)
            .await?;
        }
    }
    Ok(result)
}

async fn assert_refusal(
    pool: PgPool,
    change: fn(&mut VerificationPolicy),
    message: &str,
) -> Result<()> {
    let (store, valid) = fixture(pool).await?;
    let mut input = valid.clone();
    change(&mut input.verification_policy);
    validate_revised_contract(&input.contract, &input.verification_policy)?;
    let before = snapshot(&store, input.corp_id).await?;
    let first = store
        .create_mission_contract_revision(input.clone())
        .await
        .unwrap_err()
        .to_string();
    assert!(first.contains(message), "unexpected refusal: {first}");
    let receipt = store
        .audit_receipt(input.corp_id, input.actor_id, input.idempotency_key)
        .await?
        .expect("valid covered Factory Resume policy denial must have a durable refusal receipt");
    assert_eq!(receipt.decision, "refused");
    assert_eq!(receipt.reason_code, "native_policy_refused");
    assert!(receipt.resource_results.is_empty());
    assert!(first.contains(&receipt.row_hash));
    let after = snapshot(&store, input.corp_id).await?;
    assert_eq!(before["domain"], after["domain"]);
    assert_eq!(
        before["audit"]["state_audit_refs"],
        after["audit"]["state_audit_refs"]
    );
    assert_eq!(
        after["audit"]["state_audit_decisions"]
            .as_array()
            .unwrap()
            .len(),
        before["audit"]["state_audit_decisions"]
            .as_array()
            .unwrap()
            .len()
            + 1
    );
    assert_eq!(
        first,
        store
            .create_mission_contract_revision(input.clone())
            .await
            .unwrap_err()
            .to_string()
    );
    assert_eq!(
        Some(receipt),
        store
            .audit_receipt(input.corp_id, input.actor_id, input.idempotency_key)
            .await?
    );
    // Same UUID with otherwise admissible policy semantics cannot replace the refusal.
    assert!(
        store
            .create_mission_contract_revision(valid.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("different semantic inputs")
    );
    assert_eq!(after, snapshot(&store, input.corp_id).await?);
    // The identical source and contract do succeed with a fresh UUID and preserved policy.
    let accepted = store
        .create_mission_contract_revision(CreateMissionContractRevisionInput {
            idempotency_key: Uuid::new_v4(),
            ..valid
        })
        .await?;
    assert!(!accepted.replayed);
    assert!(accepted.event.is_some());
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_factory_resume_removed_gate_refusal(pool: PgPool) -> Result<()> {
    assert_refusal(
        pool,
        |policy| policy.manual_gate = None,
        "cannot remove or change the persisted manual verification gate",
    )
    .await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_factory_resume_changed_gate_refusal(pool: PgPool) -> Result<()> {
    assert_refusal(
        pool,
        |policy| {
            policy.manual_gate = Some(ManualVerificationGate::HumanApproval {
                roles: vec!["manager".into()],
            });
        },
        "cannot remove or change the persisted manual verification gate",
    )
    .await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_factory_resume_check_count_refusal(pool: PgPool) -> Result<()> {
    assert_refusal(
        pool,
        |policy| {
            policy.checks.pop();
        },
        "must preserve check count and kinds",
    )
    .await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_factory_resume_check_kind_refusal(pool: PgPool) -> Result<()> {
    assert_refusal(
        pool,
        |policy| policy.checks[0] = VerifierCheck::Artifact { min_bytes: 1 },
        "must preserve check count and kinds",
    )
    .await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_factory_resume_internal_error_rolls_back(pool: PgPool) -> Result<()> {
    let (store, input) = fixture(pool).await?;
    // Fail after mission/task updates, before the native revision and its event persist.
    sqlx::raw_sql(
        "CREATE FUNCTION b03_fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'b03 injected internal insert failure'; END $$;
         CREATE TRIGGER b03_fail_revision BEFORE INSERT ON mission_contract_revisions
         FOR EACH ROW EXECUTE FUNCTION b03_fail_revision();",
    )
    .execute(&store.pool)
    .await?;
    let before = snapshot(&store, input.corp_id).await?;
    let error = store
        .create_mission_contract_revision(input.clone())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("b03 injected internal insert failure")
    );
    assert!(error.chain().any(|cause| cause.is::<sqlx::Error>()));
    assert!(
        !error
            .chain()
            .any(|cause| cause.is::<state_audit::NativePolicyRefusal>())
    );
    assert!(
        store
            .audit_receipt(input.corp_id, input.actor_id, input.idempotency_key)
            .await?
            .is_none()
    );
    assert_eq!(before, snapshot(&store, input.corp_id).await?);
    sqlx::raw_sql("DROP TRIGGER b03_fail_revision ON mission_contract_revisions")
        .execute(&store.pool)
        .await?;
    // The rolled-back internal error did not reserve the idempotency key.
    assert!(
        !store
            .create_mission_contract_revision(input)
            .await?
            .replayed
    );
    Ok(())
}
