//! Negative store regressions use deliberately corrupted synthetic fixture
//! metadata. They do not claim native transport or independent human review.
use super::*;

#[path = "factory_base_refresh_lock_tests.rs"]
mod lock_order;

async fn assert_dispatch_denied(
    f: &PublicationFixture,
    command: &PendingRunnerCommand,
    label: &str,
) {
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .base_refresh_dispatch_artifacts(command)
            .await
            .unwrap()
            .is_none(),
        "{label}: artifact transfer must be denied"
    );
    let outcome = f
        .store
        .with_base_refresh_command_dispatch(command, || {
            panic!("{label}: unauthorized native enqueue")
        })
        .await
        .unwrap();
    assert!(
        matches!(
            outcome.transport_result,
            RunnerCommandDispatchOutcome::Obsolete
        ),
        "{label}: native enqueue must be denied"
    );
    assert!(outcome.commit_error.is_none());
    assert_eq!(
        publication_state(&f.store).await,
        before,
        "{label}: no side effects"
    );
}

async fn assert_dispatch_allowed(f: &PublicationFixture, command: &PendingRunnerCommand) {
    assert!(
        f.store
            .base_refresh_dispatch_artifacts(command)
            .await
            .unwrap()
            .is_some()
    );
    let outcome = f
        .store
        .with_base_refresh_command_dispatch(command, || Ok(true))
        .await
        .unwrap();
    assert!(matches!(
        outcome.transport_result,
        RunnerCommandDispatchOutcome::Sent
    ));
    assert!(outcome.commit_error.is_none());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_acknowledged_refresh_survives_stale_artifact_dispatch_callbacks(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    // One dispatcher obtained its artifact grant while a concurrent retry
    // delivered the same durable command. ACK precedes the first run event.
    assert_dispatch_allowed(&f, &command).await;
    assert!(
        f.store
            .acknowledge_runner_command(command.id, RUNNER)
            .await
            .unwrap()
            .is_some()
    );
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .base_refresh_dispatch_artifacts(&command)
            .await
            .unwrap()
            .is_none()
    );
    // A stale decode failure must not terminalize the accepted allocation.
    assert!(
        f.store
            .fail_base_refresh_before_dispatch(
                &command,
                "Synthetic stale artifact-transfer callback after native ACK",
            )
            .await
            .unwrap()
            .is_empty()
    );
    let outcome = f
        .store
        .with_base_refresh_command_dispatch(&command, || panic!("duplicate native enqueue"))
        .await
        .unwrap();
    assert!(matches!(
        outcome.transport_result,
        RunnerCommandDispatchOutcome::Settled
    ));
    assert!(outcome.commit_error.is_none());
    assert_eq!(publication_state(&f.store).await, before);
    // A late start remains authorized without allocating any provider budget.
    f.store
        .apply_runner_event(refresh_event(
            &command,
            "run.started",
            json!({"workspace":"isolated-refresh-fixture","workspace_branch":"crony/refresh-fixture",
                "workspace_base_ref":"main","workspace_base_commit":NEW_BASE,"execution_mode":"verification_only"}),
        ))
        .await
        .unwrap();
    assert_eq!(current_item(&f).await.mission_id, Some(MISSION));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_refresh_dispatch_failure_and_command_retirement_are_atomic(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    let before = publication_state(&f.store).await;
    // Inject failure only in this disposable database, after run cleanup but
    // before its matching command-failure evidence can be persisted.
    sqlx::raw_sql(
        "CREATE FUNCTION reject_refresh_failure_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'synthetic command failure evidence rejection'; END $$;
         CREATE TRIGGER reject_refresh_failure_evidence BEFORE INSERT ON events
         FOR EACH ROW WHEN (NEW.type='runner.command_failed')
         EXECUTE FUNCTION reject_refresh_failure_evidence();",
    )
    .execute(&f.store.pool)
    .await
    .unwrap();
    let error = f
        .store
        .fail_base_refresh_before_dispatch(&command, "Synthetic dispatch rejection")
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("synthetic command failure evidence rejection"));
    assert_eq!(publication_state(&f.store).await, before);
    sqlx::raw_sql(
        "DROP TRIGGER reject_refresh_failure_evidence ON events;
         DROP FUNCTION reject_refresh_failure_evidence();",
    )
    .execute(&f.store.pool)
    .await
    .unwrap();
    let events = f
        .store
        .fail_base_refresh_before_dispatch(&command, "Synthetic dispatch rejection")
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        ["run.failed", "runner.command_failed"]
    );
    let failed = publication_state(&f.store).await;
    assert!(
        f.store
            .acknowledge_runner_command(command.id, RUNNER)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        f.store
            .fail_base_refresh_before_dispatch(&command, "Repeated stale failure")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(publication_state(&f.store).await, failed);
    assert_eq!(current_item(&f).await.mission_id, Some(MISSION));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_started_refresh_preserves_pending_ack_during_stale_failure(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    f.store
        .apply_runner_event(refresh_event(
            &command,
            "run.started",
            json!({"workspace":"isolated-refresh-fixture","workspace_branch":"crony/refresh-fixture",
                "workspace_base_ref":"main","workspace_base_commit":NEW_BASE,"execution_mode":"verification_only"}),
        ))
        .await
        .unwrap();
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .fail_base_refresh_before_dispatch(&command, "Synthetic failure while ACK is delayed")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(publication_state(&f.store).await, before);
    assert!(
        f.store
            .acknowledge_runner_command(command.id, RUNNER)
            .await
            .unwrap()
            .is_some()
    );
}

async fn deny_dispatch_mutation(
    f: &PublicationFixture,
    command: &PendingRunnerCommand,
    change: &MetadataMutation,
) {
    let before = publication_state(&f.store).await;
    let original = metadata_column(&f.store, change.table, change.column, change.id).await;
    set_metadata_column(&f.store, change, &change.value).await;
    assert_dispatch_denied(f, command, change.label).await;
    // Remove only this test's metadata corruption. No native usage, budget
    // transition, terminal event or human decision is rolled back.
    set_metadata_column(&f.store, change, &original).await;
    assert_eq!(
        publication_state(&f.store).await,
        before,
        "{}",
        change.label
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_dispatch_revalidates_selection_contracts_and_connection(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    assert_dispatch_allowed(&f, &command).await;
    let mut policy = current_item(&f).await.policy;
    policy["source_repository"] = json!("fixture/other-repository");
    let mut cases = vec![
        MetadataMutation::new(
            "changed selected mission",
            "factory_work_items",
            "mission_id",
            ITEM,
            json!(refresh.refresh.mission_id),
        ),
        MetadataMutation::new(
            "changed selected source policy",
            "factory_work_items",
            "policy",
            ITEM,
            policy,
        ),
        MetadataMutation::new(
            "revoked authorizer role",
            "actors",
            "role",
            OWNER,
            json!("member"),
        ),
        MetadataMutation::new(
            "changed connection repository",
            "workspace_connections",
            "source_repository",
            CONNECTION,
            json!("fixture/other-repository"),
        ),
        MetadataMutation::new(
            "changed connection base ref",
            "workspace_connections",
            "source_base_ref",
            CONNECTION,
            json!("release"),
        ),
        MetadataMutation::new(
            "advanced connection base again",
            "workspace_connections",
            "source_base_commit",
            CONNECTION,
            json!("8".repeat(40)),
        ),
        MetadataMutation::new(
            "changed assignment token",
            "runs",
            "assignment_token",
            refresh.refresh.run_id,
            json!(Uuid::new_v4()),
        ),
    ];
    for task in [refresh.refresh.source_task_id, refresh.refresh.task_id] {
        let mut contract = metadata_column(&f.store, "tasks", "contract", task).await;
        contract["write_scope"] = json!(["unapproved.txt"]);
        cases.push(MetadataMutation::new(
            "changed saved write contract",
            "tasks",
            "contract",
            task,
            contract,
        ));
        let mut verifier = metadata_column(&f.store, "tasks", "verification_policy", task).await;
        verifier["checks"] = json!([]);
        cases.push(MetadataMutation::new(
            "weakened saved verifier checks",
            "tasks",
            "verification_policy",
            task,
            verifier,
        ));
    }
    for change in cases {
        deny_dispatch_mutation(&f, &command, &change).await;
    }
    assert_dispatch_allowed(&f, &command).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_final_dispatch_rejects_altered_command_and_foreign_scope(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    assert_dispatch_allowed(&f, &command).await;
    for field in [
        "assignment_token",
        "run_id",
        "workspace_run_id",
        "corp_id",
        "room_id",
        "task_id",
        "mission_id",
        "refresh_id",
    ] {
        let mut altered = command.clone();
        altered.payload[field] = json!(Uuid::new_v4());
        assert_dispatch_denied(&f, &altered, field).await;
    }
    for case in 0..5 {
        let mut altered = command.clone();
        match case {
            0 => altered.id = Uuid::new_v4(),
            1 => altered.corp_id = Uuid::new_v4(),
            2 => altered.run_id = Uuid::new_v4(),
            3 => altered.runner_id = "another-fixture-runner".into(),
            _ => altered.command_kind = "run_resume".into(),
        }
        assert_dispatch_denied(&f, &altered, "foreign command identity").await;
    }
    let mut payload = command.payload.clone();
    payload["source_repository"] = json!("fixture/other-repository");
    deny_dispatch_mutation(
        &f,
        &command,
        &MetadataMutation::new(
            "saved native command changed",
            "runner_commands",
            "payload",
            command.id,
            payload,
        ),
    )
    .await;
    assert_dispatch_allowed(&f, &command).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_zero_provider_exemption_rejects_session_and_provider_metadata(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    let run = refresh.refresh.run_id;
    let before = publication_state(&f.store).await;
    for (kind, payload) in [
        (
            "run.session",
            json!({"session_id":"synthetic-unapproved-session"}),
        ),
        (
            "run.usage",
            json!({"input_tokens":1,"output_tokens":1,"cost_microusd":1}),
        ),
    ] {
        assert!(
            f.store
                .apply_runner_event(refresh_event(&command, kind, payload))
                .await
                .is_err(),
            "{kind}"
        );
        assert_eq!(publication_state(&f.store).await, before);
    }
    for (column, value) in [
        ("execution_mode", json!("provider")),
        ("provider_session_id", json!("synthetic-unapproved-session")),
        ("model", json!("synthetic-unapproved-model")),
        ("reasoning_effort", json!("high")),
        ("resumed_from_run_id", json!(f.verifier_run_id)),
        ("workspace_run_id", json!(f.verifier_run_id)),
        ("artifact_sha256", json!("9".repeat(64))),
    ] {
        let change = MetadataMutation::new(
            "invalid provider-free allocation",
            "runs",
            column,
            run,
            value,
        );
        let original = metadata_column(&f.store, "runs", column, run).await;
        set_metadata_column(&f.store, &change, &change.value).await;
        let mut tx = f.store.pool.begin().await.unwrap();
        assert!(
            !factory_base_refresh::zero_provider_allocation_tx(&mut tx, CORP, run)
                .await
                .unwrap(),
            "{column}"
        );
        assert!(
            factory_base_refresh::inherited_provider_artifact_tx(&mut tx, CORP, run)
                .await
                .unwrap()
                .is_none(),
            "{column}"
        );
        tx.rollback().await.unwrap();
        assert_dispatch_denied(&f, &command, column).await;
        set_metadata_column(&f.store, &change, &original).await;
    }
    assert_dispatch_allowed(&f, &command).await;
    // Retain the synthetic nonzero budget, rather than clearing usage or
    // lowering a real breaker to make a later positive assertion succeed.
    sqlx::query("UPDATE runs SET budget_tokens_limit=1,budget_cost_microusd_limit=1,input_tokens=1,output_tokens=1,cost_microusd=1 WHERE corp_id=$1 AND id=$2")
        .bind(CORP).bind(run).execute(&f.store.pool).await.unwrap();
    let mut tx = f.store.pool.begin().await.unwrap();
    assert!(
        !factory_base_refresh::zero_provider_allocation_tx(&mut tx, CORP, run)
            .await
            .unwrap()
    );
    tx.rollback().await.unwrap();
    assert_dispatch_denied(&f, &command, "nonzero provider budget and usage").await;
}

async fn approve_refresh(f: &PublicationFixture, refresh: &FactoryBaseRefreshResponse) -> Uuid {
    let key = Uuid::new_v4();
    f.store
        .decide_verification(
            CORP,
            refresh.refresh.run_id,
            REVIEWER,
            true,
            "Synthetic independent store-fixture review",
            Some(key),
        )
        .await
        .unwrap();
    key
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_inherited_provider_evidence_preserves_exact_producer_identity(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    let (_, provider) = f
        .store
        .base_refresh_dispatch_artifacts(&command)
        .await
        .unwrap()
        .unwrap();
    let provider = provider.unwrap();
    let stored = sqlx::query("SELECT * FROM artifacts WHERE corp_id=$1 AND id=$2")
        .bind(CORP)
        .bind(provider.id)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let stored = map_stored_artifact(stored);
    assert_eq!(provider.id, stored.id);
    assert_eq!(provider.corp_id, stored.corp_id);
    assert_eq!(provider.task_id, stored.task_id);
    assert_eq!(provider.run_id, stored.run_id);
    assert_eq!(provider.producer_agent_id, stored.producer_agent_id);
    assert_eq!(provider.producer_runner_id, stored.producer_runner_id);
    assert_eq!(provider.verifier, stored.verifier);
    assert_eq!(provider.object_key, stored.object_key);
    assert_eq!(provider.uri, stored.uri);
    assert_eq!(provider.sha256, stored.sha256);
    assert_eq!(provider.media_type, stored.media_type);
    assert_eq!(provider.bytes, stored.bytes);
    assert_eq!(provider.artifact_role, stored.artifact_role);
    assert_eq!(provider.file_name, stored.file_name);
    assert_eq!(provider.metadata, stored.metadata);
    assert_eq!(provider.provenance_signature, stored.provenance_signature);
    assert_eq!(provider.retention_until, stored.retention_until);
    assert_eq!(provider.run_id, refresh.refresh.source_run_id);
    assert_eq!(provider.task_id, refresh.refresh.source_task_id);
    assert_ne!(provider.run_id, refresh.refresh.run_id);
    for (corp, run) in [
        (Uuid::new_v4(), refresh.refresh.run_id),
        (CORP, Uuid::new_v4()),
    ] {
        let mut tx = f.store.pool.begin().await.unwrap();
        assert!(
            factory_base_refresh::inherited_provider_artifact_tx(&mut tx, corp, run)
                .await
                .unwrap()
                .is_none()
        );
        tx.rollback().await.unwrap();
    }
    let agent: Uuid = serde_json::from_value(command.payload["agent_id"].clone()).unwrap();
    for (column, value) in [
        ("run_id", json!(refresh.refresh.run_id)),
        ("task_id", json!(refresh.refresh.task_id)),
        ("producer_agent_id", json!(agent)),
        ("sha256", json!("9".repeat(64))),
    ] {
        let before = publication_state(&f.store).await;
        let original = metadata_column(&f.store, "artifacts", column, provider.id).await;
        let change = MetadataMutation::new(
            "corrupted inherited provider identity",
            "artifacts",
            column,
            provider.id,
            value,
        );
        set_metadata_column(&f.store, &change, &change.value).await;
        let mut tx = f.store.pool.begin().await.unwrap();
        assert!(
            !matches!(
                factory_base_refresh::inherited_provider_artifact_tx(
                    &mut tx,
                    CORP,
                    refresh.refresh.run_id
                )
                .await,
                Ok(Some(_))
            ),
            "{column}: a refresh must not relabel inherited evidence as its own"
        );
        tx.rollback().await.unwrap();
        // Restore only deliberately corrupted fixture metadata.
        set_metadata_column(&f.store, &change, &original).await;
        assert_eq!(publication_state(&f.store).await, before);
    }
    // A ready source export already exists for the producer run. The database
    // itself rejects relabeling its provider evidence as another source export.
    let mut tx = f.store.pool.begin().await.unwrap();
    let error = sqlx::query(
        "UPDATE artifacts SET artifact_role='source_deliverable' WHERE corp_id=$1 AND id=$2",
    )
    .bind(CORP)
    .bind(provider.id)
    .execute(&mut *tx)
    .await
    .unwrap_err();
    assert_eq!(
        error
            .as_database_error()
            .and_then(|error| error.constraint()),
        Some("artifacts_one_source_deliverable_per_run_idx")
    );
    tx.rollback().await.unwrap();
    assert_dispatch_allowed(&f, &command).await;
}

async fn original_stop_after_refresh_case(pool: PgPool, adopted: bool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let result = verify_refresh(&f, &refresh).await;
    approve_refresh(&f, &refresh).await;
    let mut input = f.input.clone();
    input.source_deliverable_id = result;
    let renewal = if adopted {
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, settlement(&f).await, true)
            .await
            .unwrap();
        let started = f
            .store
            .start_pull_request_publication(input.clone())
            .await
            .unwrap();
        Some(publication_renewal(&input, &started))
    } else {
        None
    };
    let before = publication_state(&f.store).await;
    // The original provider is already stopped. Append the exact native STOP
    // control fence as synthetic fixture authority, without resuming it or
    // changing its retained checkpoint, usage or terminal outcome.
    let mut tx = f.store.pool.begin().await.unwrap();
    append_event_tx(
        &mut tx,
        NewEvent {
            room_id: Some(ROOM),
            correlation_id: Some(MISSION),
            ..NewEvent::new(
                CORP,
                Some(OWNER),
                "run.stop_requested",
                "run",
                SOURCE,
                format!("run-stop:{SOURCE}:{}", Uuid::new_v4()),
                json!({"agent_id":AGENT,"reason":"Synthetic explicit owner stop after base refresh"}),
            )
        },
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    let stopped = publication_state(&f.store).await;
    for key in ["runs", "tasks", "missions"] {
        assert_eq!(stopped[key], before[key]);
    }
    if adopted {
        reject_publication(&f.store, &input, renewal.as_ref()).await;
    } else {
        assert_adoption_denied(&f, &refresh).await;
        assert_eq!(current_item(&f).await.mission_id, Some(MISSION));
    }
    assert_eq!(publication_state(&f.store).await, stopped);
    // The explicit stop remains durable; no fixture cleanup restores authority.
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_original_stop_after_review_blocks_adoption(pool: PgPool) {
    original_stop_after_refresh_case(pool, false).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_original_stop_after_adoption_blocks_publication(pool: PgPool) {
    original_stop_after_refresh_case(pool, true).await;
}

async fn remove_reviewer_membership(f: &PublicationFixture) -> Value {
    let membership: Value = sqlx::query_scalar(
        "SELECT to_jsonb(member) FROM room_memberships member WHERE room_id=$1 AND actor_id=$2",
    )
    .bind(ROOM)
    .bind(REVIEWER)
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(ROOM)
        .bind(REVIEWER)
        .execute(&f.store.pool)
        .await
        .unwrap();
    membership
}

async fn restore_reviewer_membership(f: &PublicationFixture, membership: Value) {
    // Restore the exact deliberately removed fixture row and timestamp.
    sqlx::query("INSERT INTO room_memberships SELECT * FROM jsonb_populate_record(NULL::room_memberships,$1)")
        .bind(membership).execute(&f.store.pool).await.unwrap();
}

async fn assert_adoption_denied(f: &PublicationFixture, refresh: &FactoryBaseRefreshResponse) {
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, settlement(f).await, true)
            .await
            .is_err()
    );
    assert_eq!(publication_state(&f.store).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_current_reviewer_role_and_membership_fence_adoption_and_publication(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let result = verify_refresh(&f, &refresh).await;
    approve_refresh(&f, &refresh).await;
    let before = publication_state(&f.store).await;
    let change = MetadataMutation::new(
        "revoked independent reviewer role",
        "actors",
        "role",
        REVIEWER,
        // Members remain eligible under the original fixture's default gate.
        // Guest is outside the saved independent-review role set.
        json!("guest"),
    );
    let role = metadata_column(&f.store, "actors", "role", REVIEWER).await;
    set_metadata_column(&f.store, &change, &change.value).await;
    assert_adoption_denied(&f, &refresh).await;
    set_metadata_column(&f.store, &change, &role).await;
    let membership = remove_reviewer_membership(&f).await;
    assert_adoption_denied(&f, &refresh).await;
    restore_reviewer_membership(&f, membership).await;
    assert_eq!(publication_state(&f.store).await, before);
    f.store
        .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, settlement(&f).await, true)
        .await
        .unwrap();
    let mut input = f.input.clone();
    input.source_deliverable_id = result;
    set_metadata_column(&f.store, &change, &change.value).await;
    reject_publication(&f.store, &input, None).await;
    set_metadata_column(&f.store, &change, &role).await;
    let membership = remove_reviewer_membership(&f).await;
    reject_publication(&f.store, &input, None).await;
    restore_reviewer_membership(&f, membership).await;
    let started = f
        .store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    // Current authority is still checked after publication was allocated and
    // before advancing its branch/PR checkpoints.
    let renewal = publication_renewal(&input, &started);
    set_metadata_column(&f.store, &change, &change.value).await;
    reject_publication(&f.store, &input, Some(&renewal)).await;
    set_metadata_column(&f.store, &change, &role).await;
    let membership = remove_reviewer_membership(&f).await;
    reject_publication(&f.store, &input, Some(&renewal)).await;
    restore_reviewer_membership(&f, membership).await;
    f.store
        .renew_pull_request_publication(renewal)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_adoption_requires_unchanged_source_and_complete_saved_policies(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    verify_refresh(&f, &refresh).await;
    approve_refresh(&f, &refresh).await;
    let mut cases = vec![MetadataMutation::new(
        "changed selected mission",
        "factory_work_items",
        "mission_id",
        ITEM,
        json!(refresh.refresh.mission_id),
    )];
    let mut selection = current_item(&f).await.policy;
    selection["source_base_commit"] = json!("9".repeat(40));
    cases.push(MetadataMutation::new(
        "changed selected base",
        "factory_work_items",
        "policy",
        ITEM,
        selection,
    ));
    for task in [refresh.refresh.source_task_id, refresh.refresh.task_id] {
        for column in ["contract", "verification_policy"] {
            let mut value = metadata_column(&f.store, "tasks", column, task).await;
            if column == "contract" {
                value["write_scope"] = json!(["unapproved.txt"]);
            } else {
                value["checks"] = json!([]);
            }
            cases.push(MetadataMutation::new(
                "changed source/replacement contract",
                "tasks",
                column,
                task,
                value,
            ));
        }
    }
    for change in cases {
        let before = publication_state(&f.store).await;
        let original = metadata_column(&f.store, change.table, change.column, change.id).await;
        set_metadata_column(&f.store, &change, &change.value).await;
        assert_adoption_denied(&f, &refresh).await;
        set_metadata_column(&f.store, &change, &original).await;
        assert_eq!(publication_state(&f.store).await, before);
    }
    let request = settlement(&f).await;
    f.store
        .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, request.clone(), true)
        .await
        .unwrap();
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, request.clone(), true)
            .await
            .unwrap()
            .replayed
    );
    assert_eq!(publication_state(&f.store).await, before);
    for case in 0..4 {
        let mut altered = request.clone();
        match case {
            0 => altered.reason.push_str(" changed"),
            1 => altered.claim_token = Uuid::new_v4(),
            2 => altered.observed_source_revision.push_str(" changed"),
            _ => altered.actor_id = REVIEWER,
        }
        assert!(
            f.store
                .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, altered, true)
                .await
                .is_err()
        );
        assert_eq!(publication_state(&f.store).await, before);
    }
    assert!(
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, request.clone(), false)
            .await
            .is_err()
    );
    let changed_role = MetadataMutation::new(
        "settlement replay requires current actor role",
        "actors",
        "role",
        OWNER,
        json!("member"),
    );
    set_metadata_column(&f.store, &changed_role, &changed_role.value).await;
    let revoked = publication_state(&f.store).await;
    assert!(
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, request, true)
            .await
            .is_err()
    );
    assert_eq!(publication_state(&f.store).await, revoked);
    // A new settlement key must also fail after the immutable adoption.
    assert_adoption_denied(&f, &refresh).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_emergency_stop_fences_native_dispatch_and_late_progress(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    assert_dispatch_allowed(&f, &command).await;
    let agent: Uuid = serde_json::from_value(command.payload["agent_id"].clone()).unwrap();
    let stopped = f
        .store
        .request_emergency_stop(CORP, agent, OWNER, "Explicit store-fixture stop")
        .await
        .unwrap();
    assert_eq!(stopped.run_id, refresh.refresh.run_id);
    assert_dispatch_denied(&f, &command, "durable operator stop").await;
    let before = publication_state(&f.store).await;
    for kind in [
        "run.started",
        "run.verification_started",
        "run.verification_passed",
    ] {
        assert!(
            f.store
                .apply_runner_event(refresh_event(&command, kind, json!({})))
                .await
                .is_err(),
            "{kind}"
        );
        assert_eq!(publication_state(&f.store).await, before);
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_quarantine_fences_native_dispatch(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    sqlx::query("UPDATE runs SET workspace_disposition='quarantined' WHERE corp_id=$1 AND id=$2")
        .bind(CORP)
        .bind(refresh.refresh.run_id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_dispatch_denied(&f, &command, "quarantined refresh workspace").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_stop_breaker_fences_native_dispatch(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    sqlx::query("UPDATE runs SET breaker_stage='stop' WHERE corp_id=$1 AND id=$2")
        .bind(CORP)
        .bind(refresh.refresh.run_id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_dispatch_denied(&f, &command, "retained stop breaker").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_adopted_audit_archive_retains_both_missions_and_exact_lineage(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    f.store
        .initialize_state_audit(CORP, OWNER, Uuid::new_v4())
        .await
        .unwrap();
    f.store.cover_mission(CORP, OWNER, MISSION).await.unwrap();
    let refresh = authorize_refresh(&f).await;
    let result = verify_refresh(&f, &refresh).await;
    let key = approve_refresh(&f, &refresh).await;
    let settlement_request = settlement(&f).await;
    f.store
        .settle_factory_base_refresh(
            CORP,
            ITEM,
            refresh.refresh.id,
            settlement_request.clone(),
            true,
        )
        .await
        .unwrap();
    let signer = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let checkpoint = f
        .store
        .audit_checkpoint(CORP, "issue84-synthetic-audit-key", &signer)
        .await
        .unwrap();
    let archive = f.store.audit_export(CORP, OWNER).await.unwrap();
    archive
        .verify_with_key_history(&archive.signing_keys, Some(&checkpoint.digest))
        .unwrap();
    let mut missions = HashSet::new();
    for object in archive
        .rows
        .iter()
        .flat_map(|row| &row.objects)
        .filter(|object| object.kind == "content")
    {
        for lineage in object.value["base_refreshes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|lineage| {
                lineage["id"] == json!(refresh.refresh.id) && lineage["state"] == "adopted"
            })
        {
            missions.insert(object.value["mission_id"].as_str().unwrap().to_owned());
            assert_eq!(lineage["source_mission_id"], json!(MISSION));
            assert_eq!(lineage["mission_id"], json!(refresh.refresh.mission_id));
            assert_eq!(lineage["source_run_id"], json!(f.verifier_run_id));
            assert_eq!(
                lineage["source_deliverable_id"],
                json!(f.input.source_deliverable_id)
            );
            assert_eq!(lineage["original_base_commit"], "a".repeat(40));
            assert_eq!(lineage["refreshed_base_commit"], NEW_BASE);
            assert_eq!(lineage["result_deliverable_id"], json!(result));
            assert_eq!(lineage["result_commit"], "5".repeat(40));
            assert_eq!(lineage["review_decision_id"], json!(key));
            assert_eq!(lineage["authority_digest"].as_str().unwrap().len(), 64);
            assert_eq!(lineage["settlement_digest"].as_str().unwrap().len(), 64);
        }
    }
    assert_eq!(
        missions,
        HashSet::from([MISSION.to_string(), refresh.refresh.mission_id.to_string()])
    );
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, settlement_request, true)
            .await
            .unwrap()
            .replayed
    );
    assert_eq!(publication_state(&f.store).await, before);
    let replayed = f.store.audit_export(CORP, OWNER).await.unwrap();
    assert_eq!(
        serde_json::to_value(&replayed).unwrap(),
        serde_json::to_value(&archive).unwrap()
    );
    // Historical proof is not new execution authority. Neither the replaced
    // source nor the immutable refresh mission can acquire a provider resume.
    for run in [
        f.corrected_run_id,
        f.verifier_run_id,
        refresh.refresh.run_id,
    ] {
        assert!(f.store.create_resume_run(CORP, run, OWNER).await.is_err());
        let mut recovery = request();
        recovery.source_run_id = run;
        recovery.expected_factory_version = current_item(&f).await.version;
        recovery.idempotency_key = Uuid::new_v4();
        assert!(
            f.store
                .create_factory_verification_recovery(recovery)
                .await
                .is_err()
        );
        assert_eq!(publication_state(&f.store).await, before);
    }
}
