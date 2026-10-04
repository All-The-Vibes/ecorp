//! Native transactions in fresh SQLx-owned databases with the real migrations.
//! Artifact metadata, signatures and remote proofs here are synthetic test inputs;
//! these tests are not signed-object, provider, browser or hosted acceptance evidence.
use super::*;
use crony_domain::ActiveCheckpointFailureReason;

const ROOM: Uuid = Uuid::from_u128(79);
const AGENT: Uuid = Uuid::from_u128(80);
const AGENT_ACTOR: Uuid = Uuid::from_u128(81);
const TOKEN: Uuid = Uuid::from_u128(82);
const EPOCH: Uuid = Uuid::from_u128(83);
const RUNNER: &str = "issue72-native-runner";
const PUBLISHER: &str = "issue72-native-publisher";

fn credential() -> String {
    "7".repeat(64)
}

async fn fixture(pool: PgPool, ready_artifact: bool) -> PgStore {
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,'issue72','Owned checkpoint fixture')")
        .bind(CORP)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Owner','human','owner'),($3,$2,'Worker','agent','worker')")
        .bind(OWNER).bind(CORP).bind(AGENT_ACTOR).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'QA','Checkpoint transactions')",
    )
    .bind(ROOM)
    .bind(CORP)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(ROOM)
        .bind(OWNER)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agents(id,corp_id,actor_id,name,role,adapter,status,current_run_id,accent) VALUES($1,$2,$3,'Worker','worker','openai-codex','working',$4,'#123456')")
        .bind(AGENT).bind(CORP).bind(AGENT_ACTOR).bind(RUN).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,original_budget_tokens,original_budget_cost_microusd) VALUES($1,$2,$3,$4,'Checkpoint','running',1000000,1000000,5000000)")
        .bind(MISSION).bind(CORP).bind(ROOM).bind(OWNER).execute(&pool).await.unwrap();
    let contract = json!({
        "objective":"preserve result.md", "expected_output":"result.md",
        "source_repository":"fixture/source", "source_base_ref":"main",
        "source_base_commit":"a".repeat(40), "acceptance_tests":["result.md exists"],
        "allowed_tools":["filesystem"], "prohibited_actions":["outside worktree"],
        "references":[], "write_scope":["result.md"], "budget_tokens":100000,
        "budget_cost_microusd":1000000, "deadline_at":null, "escalation":"ask owner",
        "deliverable":{"form":"commit_branch"}
    });
    sqlx::query("INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,plan_key,contract,verification_policy,attempt_count,max_attempts) VALUES($1,$2,$3,'Checkpoint','preserve result.md','running',$4,'delivery',$5,$6,1,4)")
        .bind(TASK).bind(CORP).bind(MISSION).bind(AGENT).bind(contract)
        .bind(serde_json::to_value(full_policy()).unwrap()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,workspace_run_id,workspace_path,workspace_branch,workspace_base_ref,workspace_base_commit,workspace_disposition,source_repository,source_base_ref,source_base_commit) VALUES($1,$2,$3,$4,$5,$6,'running',$1,'owned-worktree','crony/fixture72','main',$7,'preserved','fixture/source','main',$7)")
        .bind(RUN).bind(CORP).bind(TASK).bind(AGENT).bind(RUNNER).bind(TOKEN)
        .bind("a".repeat(40)).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO factory_work_items(id,corp_id,source_kind,source_project_owner,source_project_number,source_project_item_id,source_repository_owner,source_repository_name,source_issue_number,source_issue_node_id,source_issue_url,source_title,source_revision,state,version,claim_owner_id,claim_token,lease_expires_at,mission_id,policy) VALUES($1,$2,'github_project_issue','fixture',72,'PVTI_fixture72','fixture','source',72,'I_fixture72','https://github.com/fixture/source/issues/72','Preserve active work','revision-1','running',3,$3,$4,now()+interval '1 hour',$5,$6)")
        .bind(ITEM).bind(CORP).bind(OWNER).bind(Uuid::new_v4()).bind(MISSION)
        .bind(item().policy).execute(&pool).await.unwrap();
    let store = PgStore { pool };
    store
        .runner_connected(RunnerConnectInput {
            id: RUNNER.into(),
            corp_id: CORP,
            hostname: "owned-fixture".into(),
            os: "windows".into(),
            capabilities: json!({}),
            connection_epoch: EPOCH,
        })
        .await
        .unwrap();
    store
        .create_publication_publisher_credential(
            CORP,
            OWNER,
            PUBLISHER,
            &credential(),
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();
    if ready_artifact {
        upload(&store, artifact(ARTIFACT, metadata(), "f")).await;
    }
    store
}

fn runner_input(id: Uuid) -> RunnerEventInput {
    RunnerEventInput {
        event_id: id,
        runner_id: RUNNER.into(),
        corp_id: CORP,
        connection_epoch: EPOCH,
        run_id: RUN,
        agent_id: AGENT,
        assignment_token: TOKEN,
        event_type: "run.checkpoint_upload".into(),
        payload: json!({}),
    }
}

fn artifact(id: Uuid, metadata: Value, digest: &str) -> StoredArtifact {
    StoredArtifact {
        id,
        corp_id: CORP,
        task_id: TASK,
        run_id: RUN,
        producer_agent_id: AGENT,
        producer_runner_id: RUNNER.into(),
        verifier: "checkpoint-native-fixture".into(),
        object_key: format!("corps/{CORP}/{id}"),
        uri: format!("artifact://{CORP}/{id}"),
        sha256: digest.repeat(64),
        media_type: "application/vnd.crony.source+json".into(),
        bytes: 100,
        artifact_role: "source_checkpoint".into(),
        file_name: "source.json".into(),
        metadata,
        // Shape-valid synthetic metadata; cryptographic validation belongs to the server lane.
        provenance_signature: "0".repeat(64),
        retention_until: Utc::now() + Duration::hours(1),
    }
}

async fn upload(store: &PgStore, artifact: StoredArtifact) {
    let id = artifact.id;
    let staged = store
        .prepare_artifact_upload(
            runner_input(id),
            artifact,
            &format!("staging/corps/{CORP}/{id}"),
        )
        .await
        .unwrap();
    assert_eq!(staged.status, "staged");
    let stored = store
        .finalize_artifact_upload(CORP, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.event_type, "run.checkpoint_stored");
    assert!(
        store
            .finalize_artifact_upload(CORP, id)
            .await
            .unwrap()
            .is_none()
    );
}

fn acquire(id: Uuid) -> ActiveCheckpointRequest {
    ActiveCheckpointRequest {
        actor_id: OWNER,
        artifact_id: id,
        publisher_id: PUBLISHER.into(),
        idempotency_key: Uuid::new_v4(),
        expected_version: None,
        publisher_token: None,
        action: ActiveCheckpointAction::Acquire,
    }
}

fn next(
    previous: &ActiveCheckpointOutcome,
    action: ActiveCheckpointAction,
) -> ActiveCheckpointRequest {
    ActiveCheckpointRequest {
        actor_id: previous.publication.actor_id,
        artifact_id: previous.publication.artifact_id,
        publisher_id: previous.publication.publisher_id.clone(),
        idempotency_key: Uuid::new_v4(),
        expected_version: Some(previous.publication.version),
        publisher_token: previous.publisher_token,
        action,
    }
}

async fn mutate(
    store: &PgStore,
    request: ActiveCheckpointRequest,
) -> Result<ActiveCheckpointMutationOutcome> {
    store
        .mutate_active_checkpoint(ActiveCheckpointMutation {
            corp_id: CORP,
            work_item_id: ITEM,
            publisher_credential_hash: credential(),
            request,
        })
        .await
}

async fn advance(
    store: &PgStore,
    previous: &ActiveCheckpointOutcome,
    action: ActiveCheckpointAction,
) -> ActiveCheckpointOutcome {
    let outcome = mutate(store, next(previous, action)).await.unwrap();
    assert_eq!(outcome.events.len(), 1);
    assert_eq!(
        outcome.events[0].event_type,
        "factory.checkpoint_publication"
    );
    assert_eq!(outcome.events[0].room_id, Some(ROOM));
    assert_eq!(
        outcome.response.publication.version,
        previous.publication.version + 1
    );
    outcome.response
}

async fn branch(store: &PgStore, previous: &ActiveCheckpointOutcome) -> ActiveCheckpointOutcome {
    advance(
        store,
        previous,
        ActiveCheckpointAction::BranchPushed {
            commit_sha: previous.publication.commit_sha.clone(),
            base_ref: "main".into(),
        },
    )
    .await
}

async fn draft(store: &PgStore, previous: &ActiveCheckpointOutcome) -> ActiveCheckpointOutcome {
    advance(store, previous, draft_action(&previous.publication)).await
}

async fn synchronized(store: &PgStore) -> ActiveCheckpointOutcome {
    let acquired = mutate(store, acquire(ARTIFACT)).await.unwrap().response;
    let pushed = branch(store, &acquired).await;
    let published = draft(store, &pushed).await;
    advance(store, &published, project_action()).await
}

async fn expire(store: &PgStore) {
    sqlx::query("UPDATE active_checkpoint_publications SET snapshot=jsonb_set(snapshot,'{lease_expires_at}',to_jsonb(now()-interval '1 second')) WHERE corp_id=$1 AND work_item_id=$2")
        .bind(CORP).bind(ITEM).execute(&store.pool).await.unwrap();
}

async fn state(store: &PgStore) -> Value {
    // Compare rows, not allocated sequence values: rolled-back events may leave sequence gaps.
    sqlx::query_scalar("SELECT jsonb_build_object(
        'publications',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY generation),'[]') FROM active_checkpoint_publications p),
        'operations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY idempotency_key),'[]') FROM active_checkpoint_operations o),
        'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY seq),'[]') FROM events e),
        'artifacts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM artifacts a),
        'credentials',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM publication_publisher_credentials c),
        'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM runs r),
        'tasks',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM tasks t),
        'missions',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM missions m),
        'items',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY id),'[]') FROM factory_work_items f),
        'evidence',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM verification_evidence v),
        'requests',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY run_id),'[]') FROM verification_requests v))")
        .fetch_one(&store.pool).await.unwrap()
}

async fn rejected(store: &PgStore, request: ActiveCheckpointRequest) {
    let before = state(store).await;
    assert!(mutate(store, request).await.is_err());
    assert_eq!(
        state(store).await,
        before,
        "rejection must roll back all durable changes"
    );
}

async fn record_final_evidence(store: &PgStore, passed: bool) {
    let metadata = final_metadata();
    for mut row in evidence(&metadata) {
        if !passed && row.index == 1 {
            row.status = "failed".into();
        }
        sqlx::query("INSERT INTO verification_evidence(id,corp_id,task_id,run_id,check_index,kind,status,summary,payload) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic source-bound native evidence',$8)")
            .bind(Uuid::new_v4()).bind(CORP).bind(TASK).bind(RUN).bind(row.index)
            .bind(row.kind).bind(row.status).bind(row.payload).execute(&store.pool).await.unwrap();
    }
    let mut tx = store.pool.begin().await.unwrap();
    append_event_tx(
        &mut tx,
        NewEvent::new(
            CORP,
            None,
            if passed {
                "run.verification_passed"
            } else {
                "run.verification_failed"
            },
            "run",
            RUN,
            "issue72-native-final-evidence",
            metadata,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
}

async fn adoption(
    store: &PgStore,
    publication: &ActiveCheckpointPublication,
    metadata: &Value,
) -> Result<Option<ActiveCheckpointPublication>> {
    let mut tx = store.pool.begin().await?;
    let policy = full_policy();
    let result = final_adoption_tx(
        &mut tx,
        &item(),
        &FinalCheckpointSource {
            task_id: TASK,
            run_id: RUN,
            commit: &publication.commit_sha,
            branch: "crony/fixture72",
            metadata,
            verification_policy: &policy,
        },
        "fixture/source",
        "main",
        &publication.branch,
    )
    .await;
    tx.rollback().await?;
    result
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_concurrent_publishers_acquire_one_generation_and_one_lease(pool: PgPool) {
    let store = fixture(pool, true).await;
    let other_credential = "8".repeat(64);
    store
        .create_publication_publisher_credential(
            CORP,
            OWNER,
            "publisher-two",
            &other_credential,
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();
    let first = acquire(ARTIFACT);
    let mut second = acquire(ARTIFACT);
    second.publisher_id = "publisher-two".into();
    // Independent credential rows ensure the factory/branch lock must serialize contention.
    let (a, b) = tokio::join!(
        mutate(&store, first),
        store.mutate_active_checkpoint(ActiveCheckpointMutation {
            corp_id: CORP,
            work_item_id: ITEM,
            publisher_credential_hash: other_credential,
            request: second,
        })
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.response.publication.id, b.response.publication.id);
    assert_eq!(
        usize::from(a.response.publisher_token.is_some())
            + usize::from(b.response.publisher_token.is_some()),
        1
    );
    assert_eq!(
        usize::from(a.response.busy) + usize::from(b.response.busy),
        1
    );
    assert_eq!(a.events.len() + b.events.len(), 1);
    let rows = state(&store).await;
    assert_eq!(rows["publications"].as_array().unwrap().len(), 1);
    assert_eq!(rows["operations"].as_array().unwrap().len(), 1);
    assert_eq!(rows["publications"][0]["generation"], 1);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_exact_replay_rechecks_current_human_room_and_credential_authority(pool: PgPool) {
    let store = fixture(pool, true).await;
    let request = acquire(ARTIFACT);
    let original = mutate(&store, request.clone()).await.unwrap();
    let replay = mutate(&store, request.clone()).await.unwrap();
    assert!(replay.response.replayed);
    assert!(replay.events.is_empty());
    assert_eq!(
        replay.response.publisher_token,
        original.response.publisher_token
    );
    assert_eq!(replay.response.publication.version, 1);
    for role in ["viewer", "worker"] {
        sqlx::query("UPDATE actors SET role=$1 WHERE id=$2")
            .bind(role)
            .bind(OWNER)
            .execute(&store.pool)
            .await
            .unwrap();
        rejected(&store, request.clone()).await;
    }
    sqlx::query("UPDATE actors SET role='owner',kind='service' WHERE id=$1")
        .bind(OWNER)
        .execute(&store.pool)
        .await
        .unwrap();
    rejected(&store, request.clone()).await;
    sqlx::query("UPDATE actors SET kind='human' WHERE id=$1")
        .bind(OWNER)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(ROOM)
        .bind(OWNER)
        .execute(&store.pool)
        .await
        .unwrap();
    rejected(&store, request.clone()).await;
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(ROOM)
        .bind(OWNER)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE publication_publisher_credentials SET revoked_at=now() WHERE publisher_id=$1",
    )
    .bind(PUBLISHER)
    .execute(&store.pool)
    .await
    .unwrap();
    rejected(&store, request.clone()).await;
    // Simulate an already-expired credential while retaining the real lifetime constraint.
    sqlx::query("UPDATE publication_publisher_credentials SET revoked_at=NULL,created_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE publisher_id=$1").bind(PUBLISHER).execute(&store.pool).await.unwrap();
    rejected(&store, request.clone()).await;
    sqlx::query("UPDATE publication_publisher_credentials SET expires_at=now()+interval '1 hour' WHERE publisher_id=$1").bind(PUBLISHER).execute(&store.pool).await.unwrap();
    assert_eq!(
        mutate(&store, request)
            .await
            .unwrap()
            .response
            .publisher_token,
        original.response.publisher_token
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_expired_takeover_fences_old_tokens_and_redacts_operation_requests(pool: PgPool) {
    let store = fixture(pool, true).await;
    let original_request = acquire(ARTIFACT);
    let original = mutate(&store, original_request.clone())
        .await
        .unwrap()
        .response;
    expire(&store).await;
    let mut takeover = acquire(ARTIFACT);
    takeover.expected_version = Some(original.publication.version);
    let current = mutate(&store, takeover.clone()).await.unwrap().response;
    assert_ne!(current.publisher_token, original.publisher_token);
    assert_eq!(current.publication.id, original.publication.id);
    rejected(&store, next(&original, ActiveCheckpointAction::Renew)).await;
    let mut wrong_token = next(&current, ActiveCheckpointAction::Renew);
    wrong_token.publisher_token = original.publisher_token;
    rejected(&store, wrong_token).await;
    let old_replay = mutate(&store, original_request).await.unwrap();
    assert!(old_replay.response.replayed);
    assert!(old_replay.response.publisher_token.is_none());
    assert!(old_replay.events.is_empty());
    assert_eq!(
        mutate(&store, takeover)
            .await
            .unwrap()
            .response
            .publisher_token,
        current.publisher_token
    );
    let request = next(&current, ActiveCheckpointAction::Renew);
    let key = request.idempotency_key;
    mutate(&store, request).await.unwrap();
    let stored: Value = sqlx::query_scalar(
        "SELECT request FROM active_checkpoint_operations WHERE corp_id=$1 AND idempotency_key=$2",
    )
    .bind(CORP)
    .bind(key)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    let token = current.publisher_token.unwrap();
    assert!(!stored.to_string().contains(&token.to_string()));
    assert!(stored.get("publisher_token").is_none());
    assert_eq!(
        stored["publisher_token_sha256"],
        hex::encode(Sha256::digest(token.as_bytes()))
    );
    let events = state(&store).await["events"].to_string();
    assert!(!events.contains(&token.to_string()));
    assert!(!events.contains(&credential()));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_remote_draft_receipt_is_separate_from_storage_branch_and_completion(pool: PgPool) {
    let store = fixture(pool, true).await;
    let before = state(&store).await;
    let input = runner_input(ARTIFACT);
    assert!(
        store
            .active_checkpoint_receipt(&input, &"f".repeat(64))
            .await
            .unwrap()
            .is_none()
    );
    let acquired = mutate(&store, acquire(ARTIFACT)).await.unwrap().response;
    rejected(&store, next(&acquired, project_action())).await;
    let pushed = branch(&store, &acquired).await;
    assert!(
        store
            .active_checkpoint_receipt(&input, &"f".repeat(64))
            .await
            .unwrap()
            .is_none()
    );
    rejected(&store, next(&pushed, project_action())).await;
    let published = draft(&store, &pushed).await;
    let receipt = store
        .active_checkpoint_receipt(&input, &"f".repeat(64))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt, published.publication.receipt().unwrap());
    let final_state = advance(&store, &published, project_action()).await;
    assert!(final_state.publication.gates_synchronized());
    assert!(final_state.publisher_token.is_none());
    let after = state(&store).await;
    for key in [
        "runs",
        "tasks",
        "missions",
        "items",
        "artifacts",
        "evidence",
        "requests",
    ] {
        assert_eq!(
            after[key], before[key],
            "checkpoint is not completion: {key}"
        );
    }
    let events = after["events"].as_array().unwrap();
    assert!(!events.iter().any(|e| matches!(
        e["type"].as_str(),
        Some("run.deliverable" | "run.completed" | "task.completed" | "run.verification_passed")
    )));
    let replay = mutate(&store, acquire(ARTIFACT)).await.unwrap();
    assert!(replay.response.replayed && replay.response.publisher_token.is_none());
    assert!(replay.events.is_empty());
    assert_eq!(
        replay.response.publication.version,
        final_state.publication.version
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_receipt_rechecks_assignment_scope_run_state_breaker_and_stop(pool: PgPool) {
    let store = fixture(pool, true).await;
    synchronized(&store).await;
    let valid = runner_input(ARTIFACT);
    let digest = "f".repeat(64);
    for field in ["corp", "run", "agent", "runner", "assignment", "digest"] {
        let mut input = valid.clone();
        let mut wanted = digest.clone();
        match field {
            "corp" => input.corp_id = Uuid::new_v4(),
            "run" => input.run_id = Uuid::new_v4(),
            "agent" => input.agent_id = Uuid::new_v4(),
            "runner" => input.runner_id = "other-runner".into(),
            "assignment" => input.assignment_token = Uuid::new_v4(),
            "digest" => wanted = "0".repeat(64),
            _ => unreachable!(),
        }
        assert!(
            store
                .active_checkpoint_receipt(&input, &wanted)
                .await
                .unwrap()
                .is_none(),
            "{field}"
        );
    }
    for status in ["failed", "completed", "cancelled", "lost"] {
        sqlx::query("UPDATE runs SET status=$1 WHERE id=$2")
            .bind(status)
            .bind(RUN)
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            store
                .active_checkpoint_receipt(&valid, &digest)
                .await
                .unwrap()
                .is_none(),
            "{status}"
        );
    }
    sqlx::query("UPDATE runs SET status='running' WHERE id=$1")
        .bind(RUN)
        .execute(&store.pool)
        .await
        .unwrap();
    for breaker in ["suspend", "stop"] {
        sqlx::query("UPDATE runs SET breaker_stage=$1 WHERE id=$2")
            .bind(breaker)
            .bind(RUN)
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            store
                .active_checkpoint_receipt(&valid, &digest)
                .await
                .unwrap()
                .is_none(),
            "{breaker}"
        );
    }
    sqlx::query("UPDATE runs SET breaker_stage='healthy' WHERE id=$1")
        .bind(RUN)
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .active_checkpoint_receipt(&valid, &digest)
            .await
            .unwrap()
            .is_some()
    );
    let mut tx = store.pool.begin().await.unwrap();
    append_event_tx(
        &mut tx,
        NewEvent::new(
            CORP,
            Some(OWNER),
            "run.stop_requested",
            "run",
            RUN,
            "issue72-native-stop",
            json!({}),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        store
            .active_checkpoint_receipt(&valid, &digest)
            .await
            .unwrap()
            .is_none()
    );
    rejected(&store, acquire(ARTIFACT)).await;
    // Current connection-epoch authentication is performed by the server, not this receipt helper.
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_invalid_scope_version_order_and_remote_proofs_roll_back(pool: PgPool) {
    let store = fixture(pool, true).await;
    let original_request = acquire(ARTIFACT);
    let current = mutate(&store, original_request.clone())
        .await
        .unwrap()
        .response;
    let mut reused = original_request;
    reused.action = ActiveCheckpointAction::Renew;
    rejected(&store, reused).await;
    for field in ["artifact", "actor", "publisher", "version", "token"] {
        let mut bad = next(&current, ActiveCheckpointAction::Renew);
        match field {
            "artifact" => bad.artifact_id = Uuid::new_v4(),
            "actor" => bad.actor_id = AGENT_ACTOR,
            "publisher" => bad.publisher_id = "not-enrolled".into(),
            "version" => bad.expected_version = Some(99),
            "token" => bad.publisher_token = Some(Uuid::new_v4()),
            _ => unreachable!(),
        }
        rejected(&store, bad).await;
    }
    for (corp, item) in [(Uuid::new_v4(), ITEM), (CORP, Uuid::new_v4())] {
        let before = state(&store).await;
        assert!(
            store
                .mutate_active_checkpoint(ActiveCheckpointMutation {
                    corp_id: corp,
                    work_item_id: item,
                    publisher_credential_hash: credential(),
                    request: next(&current, ActiveCheckpointAction::Renew),
                })
                .await
                .is_err()
        );
        assert_eq!(state(&store).await, before);
    }
    rejected(&store, next(&current, draft_action(&current.publication))).await;
    let pushed = branch(&store, &current).await;
    rejected(
        &store,
        next(
            &pushed,
            ActiveCheckpointAction::BranchPushed {
                commit_sha: pushed.publication.commit_sha.clone(),
                base_ref: "main".into(),
            },
        ),
    )
    .await;
    let action = serde_json::to_value(draft_action(&pushed.publication)).unwrap();
    for (field, value) in [
        ("head_sha", json!("0".repeat(40))),
        ("base_ref", json!("release")),
        ("draft", json!(false)),
        ("auto_merge_enabled", json!(true)),
        ("body", json!("human edits must survive")),
        ("title", json!("Human title")),
        ("head_repository_owner", json!("other")),
        ("is_cross_repository", json!(true)),
    ] {
        let mut bad = action.clone();
        bad[field] = value;
        rejected(&store, next(&pushed, serde_json::from_value(bad).unwrap())).await;
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_artifact_intake_rejects_false_gates_and_changed_complete_policy(pool: PgPool) {
    let store = fixture(pool, false).await;
    for corruption in [
        "failed",
        "focused",
        "weaker",
        "different",
        "manual",
        "scope",
        "ready",
    ] {
        let mut metadata = metadata();
        match corruption {
            "failed" => metadata["checkpoint_report"]["passed"] = json!(false),
            "focused" => metadata["checkpoint_policy"]["check_indices"] = json!([1]),
            "weaker" => metadata["verification_policy"]["checks"]
                .as_array_mut()
                .unwrap()
                .truncate(1),
            "different" => metadata["verification_policy"]["checks"][1]["args"] = json!(["check"]),
            "manual" => metadata["verification_policy"]["manual_gate"] = Value::Null,
            "scope" => metadata["base_commit"] = json!("0".repeat(40)),
            "ready" => metadata["publication_ready"] = json!(true),
            _ => unreachable!(),
        }
        let before = state(&store).await;
        let result = store
            .prepare_artifact_upload(
                runner_input(ARTIFACT),
                artifact(ARTIFACT, metadata, "f"),
                &format!("staging/corps/{CORP}/{ARTIFACT}"),
            )
            .await;
        assert!(result.is_err(), "{corruption}");
        assert_eq!(state(&store).await, before, "{corruption}");
    }
    upload(&store, artifact(ARTIFACT, metadata(), "f")).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_artifact_finalization_rechecks_frozen_policy_without_discarding_staged_work(
    pool: PgPool,
) {
    let store = fixture(pool, false).await;
    store
        .prepare_artifact_upload(
            runner_input(ARTIFACT),
            artifact(ARTIFACT, metadata(), "f"),
            &format!("staging/corps/{CORP}/{ARTIFACT}"),
        )
        .await
        .unwrap();
    let mut changed = full_policy();
    changed.manual_gate = None;
    sqlx::query("UPDATE tasks SET verification_policy=$1 WHERE id=$2")
        .bind(serde_json::to_value(changed).unwrap())
        .bind(TASK)
        .execute(&store.pool)
        .await
        .unwrap();
    let before = state(&store).await;
    assert!(
        store
            .finalize_artifact_upload(CORP, ARTIFACT)
            .await
            .is_err()
    );
    assert_eq!(state(&store).await, before);
    assert_eq!(before["artifacts"][0]["status"], "staged");
    sqlx::query("UPDATE tasks SET verification_policy=$1 WHERE id=$2")
        .bind(serde_json::to_value(full_policy()).unwrap())
        .bind(TASK)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .finalize_artifact_upload(CORP, ARTIFACT)
            .await
            .unwrap()
            .unwrap()
            .event_type,
        "run.checkpoint_stored"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_restart_recovers_partial_branch_and_draft_without_changing_identity(pool: PgPool) {
    let store = fixture(pool, true).await;
    let acquired = mutate(&store, acquire(ARTIFACT)).await.unwrap().response;
    let pushed = branch(&store, &acquired).await;
    expire(&store).await;
    let reopened = PgStore {
        pool: store.pool.clone(),
    };
    let mut request = acquire(ARTIFACT);
    request.expected_version = Some(pushed.publication.version);
    let recovered = mutate(&reopened, request).await.unwrap().response;
    assert_eq!(recovered.publication.id, pushed.publication.id);
    assert_eq!(recovered.publication.phase, "branch_pushed");
    assert_eq!(recovered.publication.branch, pushed.publication.branch);
    assert_eq!(
        recovered.publication.commit_sha,
        pushed.publication.commit_sha
    );
    let published = draft(&reopened, &recovered).await;
    expire(&reopened).await;
    let reopened_again = PgStore {
        pool: reopened.pool.clone(),
    };
    let mut request = acquire(ARTIFACT);
    request.expected_version = Some(published.publication.version);
    let recovered = mutate(&reopened_again, request).await.unwrap().response;
    assert_eq!(recovered.publication.phase, "draft_published");
    assert_eq!(
        recovered.publication.pull_request,
        published.publication.pull_request
    );
    let finished = advance(&reopened_again, &recovered, project_action()).await;
    assert!(finished.publication.gates_synchronized());
    assert_eq!(
        state(&store).await["publications"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_next_generation_requires_recovery_and_preserves_the_existing_branch_and_pr(
    pool: PgPool,
) {
    let store = fixture(pool, true).await;
    let original_request = acquire(ARTIFACT);
    let original = mutate(&store, original_request.clone())
        .await
        .unwrap()
        .response;
    let next_id = Uuid::new_v4();
    let mut changed = metadata();
    changed["head_commit"] = json!("9".repeat(40));
    changed["parent_commit"] = json!("e".repeat(40));
    upload(&store, artifact(next_id, changed, "9")).await;
    rejected(&store, acquire(next_id)).await;
    let pushed = branch(&store, &original).await;
    let published = draft(&store, &pushed).await;
    let synced = advance(&store, &published, project_action()).await;
    let new = mutate(&store, acquire(next_id)).await.unwrap().response;
    assert_ne!(new.publication.id, original.publication.id);
    assert_eq!(new.publication.branch, original.publication.branch);
    assert_eq!(
        new.publication.previous_commit_sha,
        Some(original.publication.commit_sha.clone())
    );
    assert_eq!(
        new.publication.previous_pull_request,
        synced.publication.pull_request
    );
    rejected(&store, acquire(ARTIFACT)).await;
    let old_replay = mutate(&store, original_request).await.unwrap();
    assert!(old_replay.response.publisher_token.is_none());
    assert!(
        store
            .active_checkpoint_receipt(&runner_input(ARTIFACT), &"f".repeat(64))
            .await
            .unwrap()
            .is_none()
    );
    let pushed = branch(&store, &new).await;
    let mut identity = serde_json::to_value(draft_action(&pushed.publication)).unwrap();
    identity["number"] = json!(73);
    identity["node_id"] = json!("PR_other");
    identity["url"] = json!("https://github.com/fixture/source/pull/73");
    rejected(
        &store,
        next(&pushed, serde_json::from_value(identity).unwrap()),
    )
    .await;
    let published = draft(&store, &pushed).await;
    let receipt = store
        .active_checkpoint_receipt(&runner_input(next_id), &"9".repeat(64))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.artifact_id, next_id);
    assert_eq!(
        receipt.pull_request_url,
        synced.publication.receipt().unwrap().pull_request_url
    );
    assert_eq!(
        published.publication.pull_request.as_ref().unwrap()["number"],
        72
    );
    assert_eq!(
        state(&store).await["publications"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_final_adoption_requires_current_synchronized_body_and_exact_source(pool: PgPool) {
    let store = fixture(pool, true).await;
    let initial = mutate(&store, acquire(ARTIFACT)).await.unwrap().response;
    assert!(
        adoption(&store, &initial.publication, &final_metadata())
            .await
            .is_err()
    );
    let pushed = branch(&store, &initial).await;
    let published = draft(&store, &pushed).await;
    assert!(
        adoption(&store, &published.publication, &final_metadata())
            .await
            .is_err()
    );
    let synced = advance(&store, &published, project_action()).await;
    record_final_evidence(&store, true).await;
    assert!(
        adoption(&store, &synced.publication, &final_metadata())
            .await
            .is_err(),
        "stale gate body"
    );
    let mut request = acquire(ARTIFACT);
    request.expected_version = Some(synced.publication.version);
    let refresh = mutate(&store, request).await.unwrap().response;
    assert!(refresh.publisher_token.is_some());
    assert!(
        refresh
            .publication
            .body
            .contains("| Complete immutable verification policy | passed |")
    );
    assert!(
        refresh
            .publication
            .body
            .contains("| Persisted manual verification gate | pending |")
    );
    assert!(
        adoption(&store, &refresh.publication, &final_metadata())
            .await
            .is_err()
    );
    let refreshed = draft(&store, &refresh).await;
    assert!(refreshed.publication.gates_synchronized());
    assert!(refreshed.publisher_token.is_none());
    let adopted = adoption(&store, &refreshed.publication, &final_metadata())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(adopted.id, synced.publication.id);
    assert_eq!(adopted.pull_request.as_ref().unwrap()["number"], 72);
    // This is the draft-adoption seam only. Final publication separately enforces
    // all completion and independent-review prerequisites; no review is invented here.
    let mut wrong = final_metadata();
    wrong["source_verification"]["tree"] = json!("0".repeat(40));
    wrong["verified_tree"] = json!("0".repeat(40));
    assert!(
        adoption(&store, &refreshed.publication, &wrong)
            .await
            .is_err()
    );
    sqlx::query("UPDATE active_checkpoint_publications SET snapshot=jsonb_set(snapshot,'{lease_expires_at}',to_jsonb(now()+interval '1 hour')) WHERE id=$1").bind(adopted.id).execute(&store.pool).await.unwrap();
    assert!(
        adoption(&store, &refreshed.publication, &final_metadata())
            .await
            .is_err(),
        "active lease"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_failed_factory_only_refreshes_existing_draft_and_preserves_failed_gates(
    pool: PgPool,
) {
    let store = fixture(pool, true).await;
    sqlx::query("UPDATE factory_work_items SET state='failed' WHERE id=$1")
        .bind(ITEM)
        .execute(&store.pool)
        .await
        .unwrap();
    rejected(&store, acquire(ARTIFACT)).await;
    sqlx::query("UPDATE factory_work_items SET state='running' WHERE id=$1")
        .bind(ITEM)
        .execute(&store.pool)
        .await
        .unwrap();
    let synced = synchronized(&store).await;
    sqlx::query("UPDATE factory_work_items SET state='failed' WHERE id=$1")
        .bind(ITEM)
        .execute(&store.pool)
        .await
        .unwrap();
    record_final_evidence(&store, false).await;
    sqlx::query("UPDATE runs SET status='failed' WHERE id=$1")
        .bind(RUN)
        .execute(&store.pool)
        .await
        .unwrap();
    let mut request = acquire(ARTIFACT);
    request.expected_version = Some(synced.publication.version);
    let refresh = mutate(&store, request).await.unwrap().response;
    assert!(refresh.publication.body.contains("| 1 (test) | failed |"));
    assert!(
        refresh
            .publication
            .body
            .contains("| Complete immutable verification policy | failed |")
    );
    rejected(
        &store,
        next(
            &refresh,
            ActiveCheckpointAction::BranchPushed {
                commit_sha: refresh.publication.commit_sha.clone(),
                base_ref: "main".into(),
            },
        ),
    )
    .await;
    let refreshed = draft(&store, &refresh).await;
    assert_eq!(
        refreshed.publication.pull_request.as_ref().unwrap()["number"],
        72
    );
    assert!(
        store
            .active_checkpoint_receipt(&runner_input(ARTIFACT), &"f".repeat(64))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(state(&store).await["items"][0]["state"], "failed");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_failed_publication_preserves_partial_effects_and_can_be_recovered(pool: PgPool) {
    let store = fixture(pool, true).await;
    let acquired = mutate(&store, acquire(ARTIFACT)).await.unwrap().response;
    let pushed = branch(&store, &acquired).await;
    let failed = advance(
        &store,
        &pushed,
        ActiveCheckpointAction::Failed {
            reason: ActiveCheckpointFailureReason::DraftPublication,
        },
    )
    .await;
    assert_eq!(failed.publication.phase, "branch_pushed");
    assert!(failed.publication.failure_detail.is_some());
    assert!(failed.publisher_token.is_none());
    rejected(&store, next(&pushed, draft_action(&pushed.publication))).await;
    let mut request = acquire(ARTIFACT);
    request.expected_version = Some(failed.publication.version);
    let recovered = mutate(&store, request).await.unwrap().response;
    assert_eq!(recovered.publication.id, pushed.publication.id);
    assert!(recovered.publication.failure_detail.is_none());
    let published = draft(&store, &recovered).await;
    assert!(
        advance(&store, &published, project_action())
            .await
            .publication
            .gates_synchronized()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue72_final_factory_ownership_fences_active_requests_and_replays(pool: PgPool) {
    let store = fixture(pool, true).await;
    let request = acquire(ARTIFACT);
    let current = mutate(&store, request.clone()).await.unwrap().response;
    for status in ["publishing", "published", "cancelled"] {
        sqlx::query("UPDATE factory_work_items SET state=$1 WHERE id=$2")
            .bind(status)
            .bind(ITEM)
            .execute(&store.pool)
            .await
            .unwrap();
        rejected(&store, request.clone()).await;
        rejected(&store, next(&current, ActiveCheckpointAction::Renew)).await;
    }
}
