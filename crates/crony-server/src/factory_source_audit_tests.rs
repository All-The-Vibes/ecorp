//! Actual source-upgrade handler with SQLx-owned metadata; no runner or remote effects.
use super::*;
use anyhow::Result;
use crony_store::state_audit::AuditReceipt;
use sqlx::{ConnectOptions, PgPool};

async fn counts(pool: &PgPool, corp: Uuid) -> Result<(i64, i64, i64, i64)> {
    Ok(sqlx::query_as(
        "SELECT (SELECT count(*) FROM events WHERE corp_id=$1),
                (SELECT count(*) FROM state_audit_decisions WHERE corp_id=$1),
                (SELECT count(*) FROM state_audit_local_results WHERE corp_id=$1),
                (SELECT count(*) FROM factory_operations WHERE corp_id=$1)",
    )
    .bind(corp)
    .fetch_one(pool)
    .await?)
}

async fn source_upgrade_conflict(pool: PgPool, covered: bool) -> Result<()> {
    // Follow the native handler fixture: connect only to SQLx's disposable pool.
    let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let (ids, _) = store.bootstrap_demo().await?;
    let plan: TaskGraphPlan = serde_json::from_value(json!({
        "strategy":"single","max_nodes":1,"max_depth":0,"budget_tokens":1000,
        "budget_cost_microusd":100000,"staffing":[],
        "tasks":[{"key":"deliver","title":"source upgrade fixture",
            "assigned_agent_id":ids.worker_agent_id,"required_adapter":"fake-process",
            "depends_on":[],"depth":0,"max_attempts":1,
            "contract":{
                "objective":"Write result.md","expected_output":"result.md","acceptance_tests":["exists"],
                "allowed_tools":["filesystem"],"prohibited_actions":["no external effects"],"references":[],
                "write_scope":["result.md"],"budget_tokens":1000,"budget_cost_microusd":100000,
                "deadline_at":null,"escalation":"ask owner","secret_refs":[],
                "source_repository":"fixture/repository","source_base_ref":"HEAD","source_base_commit":null,
                "model":null,"reasoning_effort":null,"deliverable":null,"workspace_connection_id":null
            },
            "verification_policy":{"checks":[{"type":"file","path":"result.md","min_bytes":1}],"manual_gate":null}
        }]
    }))?;
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Source fixture",
            "Synthetic",
            &plan,
        )
        .await?;
    let work_item_id = Uuid::new_v4();
    let claim_token = Uuid::new_v4();
    // Same legacy work-item shape as the store's source-upgrade regression.
    sqlx::query(
        "INSERT INTO factory_work_items(
            id,corp_id,source_kind,source_project_owner,source_project_number,
            source_project_item_id,source_repository_owner,source_repository_name,
            source_issue_number,source_issue_node_id,source_issue_url,source_title,
            source_revision,state,claim_owner_id,claim_token,lease_expires_at,policy,mission_id
        ) VALUES(
            $1,$2,'github_project_issue','fixture',1,'item','fixture','repository',
            283,'issue','https://github.com/fixture/repository/issues/283','audit',
            'revision','claimed',$3,$4,now()+interval '1 hour',$5,$6
        )",
    )
    .bind(work_item_id)
    .bind(ids.corp_id)
    .bind(ids.alice_actor_id)
    .bind(claim_token)
    .bind(json!({"source_base_ref":"HEAD","source_commit_upgrade_required":true}))
    .bind(mission.mission_id)
    .execute(&pool)
    .await?;
    if covered {
        store
            .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
            .await?;
        store
            .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
            .await?;
    }
    let (event_tx, mut events) = broadcast::channel(64);
    let state = AppState {
        audit: None, // Coverage is persisted; this handler needs no publication service.
        store,
        event_tx,
        runners: Arc::new(DashMap::new()),
        strategies: StrategyRegistry::new(),
        runner_grace_secs: 10,
        runner_credential_ttl_secs: 300,
        publication_publisher_credential_ttl_secs: 300,
        auth: AuthService::initialize(ServerMode::Development, None, false).await?,
        secret_cipher: SecretCipher::initialize(ServerMode::Development, None)?,
        // No artifacts are read or written; use the existing temp directory.
        artifacts: ArtifactStore::initialize(
            "local",
            std::env::temp_dir(),
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            1024,
            false,
        )?,
        artifact_retention_days: 1,
        workspace_sign_in: Arc::new(DashMap::new()),
    };
    let request = |key: &str, version| UpgradeFactorySourceCommitRequest {
        actor_id: ids.alice_actor_id,
        claim_token,
        expected_version: version,
        idempotency_key: key.into(),
        source_base_commit: "ab".repeat(20),
    };
    let accepted = upgrade_factory_source_commit(
        State(state.clone()),
        Extension(Principal::Development),
        Path((ids.corp_id, work_item_id)),
        Json(request("b05-accepted", 1)),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert_eq!(accepted.work_item.version, 2);
    assert!(!accepted.replayed);
    assert!(events.try_recv().is_ok());
    let before = counts(&pool, ids.corp_id).await?;
    let snapshot = serde_json::to_value(
        state
            .store
            .snapshot(ids.corp_id, ids.alice_actor_id)
            .await?,
    )?;
    let mut errors = Vec::new();
    let mut receipts = Vec::new();
    for _ in 0..2 {
        let error = upgrade_factory_source_commit(
            State(state.clone()),
            Extension(Principal::Development),
            Path((ids.corp_id, work_item_id)),
            Json(request("b05-stale", 1)),
        )
        .await
        .unwrap_err();
        errors.push(error);
        receipts.push(
            sqlx::query_scalar::<_, serde_json::Value>(
                "SELECT receipt FROM state_audit_decisions
             WHERE corp_id=$1 AND receipt->>'decision'='refused' ORDER BY sequence",
            )
            .bind(ids.corp_id)
            .fetch_all(&pool)
            .await?,
        );
        assert_eq!(
            counts(&pool, ids.corp_id).await?,
            (
                before.0,
                before.1 + i64::from(covered),
                before.2 + i64::from(covered),
                before.3
            ),
            "refusal/replay must not add governance events or duplicate decisions/results",
        );
        assert_eq!(
            serde_json::to_value(
                state
                    .store
                    .snapshot(ids.corp_id, ids.alice_actor_id)
                    .await?
            )?,
            snapshot,
            "refusal/replay must preserve operational state",
        );
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }
    assert_eq!(
        receipts[0], receipts[1],
        "replay must retain the exact receipt"
    );
    assert_eq!(
        errors[0].message, errors[1].message,
        "replay must retain the exact error"
    );
    if covered {
        assert_eq!(receipts[0].len(), 1);
        let receipt: AuditReceipt = serde_json::from_value(receipts[0][0].clone())?;
        assert_eq!(receipt.decision, "refused");
        assert_eq!(receipt.sequence, 3);
        assert!(errors[0].message.contains(&format!(
            "audit refusal receipt {}:{}:{}",
            receipt.ledger_id, receipt.sequence, receipt.row_hash,
        )));
    } else {
        assert!(receipts[0].is_empty());
        assert!(!errors[0].message.contains("audit refusal receipt"));
    }
    // Close the separately connected store before SQLx cleans its owned database,
    // including the deliberately failing RED assertion below.
    state.store.pool().close().await;
    for error in errors {
        assert!(
            error
                .message
                .contains("factory work item version is 2, not 1")
        );
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT, "covered={covered}");
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_b05_uncovered_source_upgrade_conflict(pool: PgPool) -> Result<()> {
    source_upgrade_conflict(pool, false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_b05_covered_source_upgrade_conflict_and_replay(pool: PgPool) -> Result<()> {
    source_upgrade_conflict(pool, true).await
}
