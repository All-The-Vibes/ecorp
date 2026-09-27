//! Actual SQLx persistence and rollback with synthetic source/signature metadata.
//! Native Git export and server signing are exercised in their own lanes.
use super::*;

fn passed_payload(artifact: &StoredArtifact) -> Value {
    json!({
        "summary": "SQLx canonical linkage fixture",
        "verification_sha256": "c".repeat(64),
        "deliverable_sha256": artifact.sha256,
        "verified_tree": fixture_source_verification().tree,
        "source_verification": fixture_source_verification(),
    })
}

async fn rejected_passed_event(
    store: &PgStore,
    command: &PendingRunnerCommand,
    payload: Value,
    expected_error: &str,
) {
    let before = state(store).await;
    let input = event(
        command.run_id,
        retention_event(command).assignment_token,
        "run.verification_passed",
        payload,
    );
    let error = store.apply_runner_event(input).await.unwrap_err();
    assert!(format!("{error:#}").contains(expected_error), "{error:#}");
    assert_eq!(
        state(store).await,
        before,
        "rejection must roll back all state and events"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_canonical_completion_requires_event_artifact_and_every_evidence_identity(
    pool: PgPool,
) {
    let (store, command, artifact) = ready_export_fixture_with_publication(pool, false).await;
    let payload = passed_payload(&artifact);
    for field in ["source_verification", "verified_tree"] {
        let mut missing = payload.clone();
        missing.as_object_mut().unwrap().remove(field);
        rejected_passed_event(&store, &command, missing, "source verification").await;
    }
    let mut malformed = payload.clone();
    malformed["source_verification"]["candidate_commit"] = json!("partial");
    rejected_passed_event(&store, &command, malformed, "source verification").await;
    let mut different = payload.clone();
    different["source_verification"]["candidate_commit"] = json!("9".repeat(40));
    rejected_passed_event(
        &store,
        &command,
        different,
        "does not match the signed source deliverable",
    )
    .await;

    let original_metadata = artifact.metadata.clone();
    let original_evidence = json!({"source":fixture_source_verification()});
    for location in ["artifact", "evidence"] {
        let mut variants = vec![Value::Null];
        for (field, value) in [
            ("tree", json!("9".repeat(40))),
            ("base_commit", json!("9".repeat(40))),
            ("candidate_commit", json!("9".repeat(40))),
            ("ignored_input_sha256", json!("9".repeat(64))),
            ("ignored_input_count", json!(1)),
            ("ignored_input_bytes", json!(1)),
        ] {
            let mut source = serde_json::to_value(fixture_source_verification()).unwrap();
            source[field] = value;
            variants.push(source);
        }
        for source in variants {
            if location == "artifact" {
                let mut metadata = original_metadata.clone();
                metadata["source_verification"] = source.clone();
                if !source.is_null() {
                    metadata["verified_tree"] = source["tree"].clone();
                    metadata["base_commit"] = source["base_commit"].clone();
                }
                sqlx::query("UPDATE artifacts SET metadata = $1 WHERE id = $2")
                    .bind(metadata)
                    .bind(artifact.id)
                    .execute(&store.pool)
                    .await
                    .unwrap();
            } else {
                sqlx::query("UPDATE verification_evidence SET payload = $1 WHERE run_id = $2")
                    .bind(json!({"source":source}))
                    .bind(command.run_id)
                    .execute(&store.pool)
                    .await
                    .unwrap();
            }
            rejected_passed_event(
                &store,
                &command,
                payload.clone(),
                if source.is_null() {
                    if location == "artifact" {
                        "source verification"
                    } else {
                        "canonical source identity"
                    }
                } else if location == "artifact" {
                    "does not match the signed source deliverable"
                } else {
                    "different source tree or input set"
                },
            )
            .await;
        }
        sqlx::query("UPDATE artifacts SET metadata = $1 WHERE id = $2")
            .bind(&original_metadata)
            .bind(artifact.id)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE verification_evidence SET payload = $1 WHERE run_id = $2")
            .bind(&original_evidence)
            .bind(command.run_id)
            .execute(&store.pool)
            .await
            .unwrap();
    }

    let input = event(
        command.run_id,
        retention_event(&command).assignment_token,
        "run.verification_passed",
        payload,
    );
    store.apply_runner_event(input.clone()).await.unwrap();
    let after = state(&store).await;
    assert_eq!(
        retained_run(&after, command.run_id)["verification_status"],
        "passed"
    );
    assert_ne!(
        retained_run(&after, command.run_id)["status"],
        "completed",
        "the independent gate still applies"
    );
    assert!(
        store
            .apply_runner_event(input)
            .await
            .unwrap()
            .event
            .is_none()
    );
    assert_eq!(state(&store).await, after, "exact replay is idempotent");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_consistent_runner_claims_cannot_replace_persisted_source_authority(pool: PgPool) {
    let (store, command, artifact) = ready_export_fixture_with_publication(pool, false).await;
    let mut source = fixture_source_verification();
    source.base_commit = "9".repeat(40);
    let mut metadata = artifact.metadata.clone();
    metadata["base_commit"] = json!(source.base_commit);
    metadata["source_verification"] = json!(source);
    sqlx::query("UPDATE artifacts SET metadata=$1 WHERE id=$2")
        .bind(metadata)
        .bind(artifact.id)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE verification_evidence SET payload=$1 WHERE run_id=$2")
        .bind(json!({"source":source}))
        .bind(command.run_id)
        .execute(&store.pool)
        .await
        .unwrap();
    // The upload and run.started event also originate at the runner. Even if
    // they agree, they cannot replace the immutable dispatched run/task base.
    for sql in [
        "UPDATE source_deliverables SET base_commit=repeat('9',40) WHERE run_id=$1",
        "UPDATE runs SET workspace_base_commit=repeat('9',40) WHERE id=$1",
    ] {
        sqlx::query(sql)
            .bind(command.run_id)
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let mut payload = passed_payload(&artifact);
    payload["source_verification"] = json!(source);
    rejected_passed_event(&store, &command, payload, "persisted source base").await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_canonical_completion_rechecks_each_persisted_base(pool: PgPool) {
    let (store, command, artifact) = ready_export_fixture_with_publication(pool, false).await;
    for (changed, restored) in [
        (
            "UPDATE runs SET workspace_base_commit=repeat('9',40) WHERE id=$1",
            "UPDATE runs SET workspace_base_commit=repeat('a',40) WHERE id=$1",
        ),
        (
            "UPDATE runs SET workspace_base_commit=NULL WHERE id=$1",
            "UPDATE runs SET workspace_base_commit=repeat('a',40) WHERE id=$1",
        ),
        (
            // Preserve the checkpoint's source/replacement lineage so this case
            // isolates canonical acceptance, rather than the budget exception.
            "UPDATE runs SET source_base_commit=repeat('9',40) WHERE task_id=(SELECT task_id FROM runs WHERE id=$1)",
            "UPDATE runs SET source_base_commit=repeat('a',40) WHERE task_id=(SELECT task_id FROM runs WHERE id=$1)",
        ),
        (
            "UPDATE tasks SET contract=jsonb_set(contract,'{source_base_commit}',to_jsonb(repeat('9',40))) WHERE id=(SELECT task_id FROM runs WHERE id=$1)",
            "UPDATE tasks SET contract=jsonb_set(contract,'{source_base_commit}',to_jsonb(repeat('a',40))) WHERE id=(SELECT task_id FROM runs WHERE id=$1)",
        ),
        (
            "UPDATE source_deliverables SET base_commit=repeat('9',40) WHERE run_id=$1",
            "UPDATE source_deliverables SET base_commit=repeat('a',40) WHERE run_id=$1",
        ),
    ] {
        sqlx::query(changed)
            .bind(command.run_id)
            .execute(&store.pool)
            .await
            .unwrap();
        rejected_passed_event(
            &store,
            &command,
            passed_payload(&artifact),
            "persisted source base",
        )
        .await;
        sqlx::query(restored)
            .bind(command.run_id)
            .execute(&store.pool)
            .await
            .unwrap();
    }
}

async fn accept_canonical_export(
    store: &PgStore,
    command: &PendingRunnerCommand,
    artifact: &StoredArtifact,
) {
    store
        .apply_runner_event(event(
            command.run_id,
            retention_event(command).assignment_token,
            "run.verification_passed",
            passed_payload(artifact),
        ))
        .await
        .unwrap();
}

async fn assert_downloadable(store: &PgStore, artifact_id: Uuid, allowed: bool) {
    for actor in [OWNER, REVIEWER] {
        assert_eq!(
            store
                .artifact_for_download(CORP, artifact_id, actor)
                .await
                .unwrap()
                .is_some(),
            allowed,
            "authorized reviewer download availability"
        );
    }
    assert!(
        store
            .artifact_for_download(Uuid::new_v4(), artifact_id, OWNER)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .artifact_for_download(CORP, artifact_id, Uuid::new_v4())
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_canonical_completion_supports_legacy_absent_source_tuple(pool: PgPool) {
    let (store, command, artifact) = ready_export_fixture_with_publication(pool, false).await;
    // Model an absent tuple consistently in both the original and resumed run;
    // changing only the replacement would invalidate its budget recovery lineage.
    sqlx::query("UPDATE runs SET source_repository=NULL,source_base_ref=NULL,source_base_commit=NULL WHERE task_id=$1")
        .bind(TASK).execute(&store.pool).await.unwrap();
    sqlx::query("UPDATE tasks SET contract=contract-'source_repository'-'source_base_ref'-'source_base_commit' WHERE id=$1")
        .bind(TASK).execute(&store.pool).await.unwrap();
    accept_canonical_export(&store, &command, &artifact).await;
    assert_downloadable(&store, artifact.id, true).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_canonical_download_waits_for_acceptance_but_allows_manual_review(pool: PgPool) {
    let (store, command, artifact) = ready_export_fixture_with_publication(pool, false).await;
    assert_downloadable(&store, artifact.id, false).await;
    let mut invalid = passed_payload(&artifact);
    invalid["source_verification"]["tree"] = json!("9".repeat(40));
    rejected_passed_event(&store, &command, invalid, "source verification").await;
    assert_downloadable(&store, artifact.id, false).await;

    accept_canonical_export(&store, &command, &artifact).await;
    assert_downloadable(&store, artifact.id, true).await;
    store
        .apply_runner_event(event(
            command.run_id,
            retention_event(&command).assignment_token,
            "run.verification_waiting",
            json!({"gate":gate(),"gate_type":"independent_review"}),
        ))
        .await
        .unwrap();
    assert_eq!(
        retained_run(&state(&store).await, command.run_id)["verification_status"],
        "waiting_for_approval"
    );
    assert_downloadable(&store, artifact.id, true).await;
    sqlx::query("DELETE FROM verification_requests WHERE run_id=$1")
        .bind(command.run_id)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_downloadable(&store, artifact.id, false).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_canonical_download_rechecks_accepted_linkage_and_metadata(pool: PgPool) {
    let (store, command, artifact) = ready_export_fixture_with_publication(pool, false).await;
    accept_canonical_export(&store, &command, &artifact).await;
    let original = state(&store).await;
    let original_run = retained_run(&original, command.run_id);
    for changed in [
        "UPDATE runs SET verification_status='failed' WHERE id=$1",
        "UPDATE runs SET verification_status='pending' WHERE id=$1",
        "UPDATE runs SET verification_sha256=repeat('9',64) WHERE id=$1",
        "UPDATE runs SET deliverable_sha256=repeat('9',64) WHERE id=$1",
        "UPDATE runs SET workspace_base_commit=repeat('9',40) WHERE id=$1",
        "UPDATE runs SET workspace_base_commit=NULL WHERE id=$1",
        "UPDATE runs SET source_base_commit=repeat('9',40) WHERE id=$1",
        "UPDATE runs SET runner_id='different-runner' WHERE id=$1",
        "UPDATE source_deliverables SET verification_sha256=repeat('9',64) WHERE run_id=$1",
        "UPDATE source_deliverables SET base_commit=repeat('9',40) WHERE run_id=$1",
        "UPDATE artifacts SET sha256=repeat('9',64) WHERE run_id=$1",
        "UPDATE artifacts SET run_id='00000000-0000-0000-0000-000000000004' WHERE run_id=$1",
        "UPDATE tasks SET contract=jsonb_set(contract,'{source_base_commit}',to_jsonb(repeat('9',40))) WHERE id=(SELECT task_id FROM runs WHERE id=$1)",
    ] {
        sqlx::query(changed)
            .bind(command.run_id)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_downloadable(&store, artifact.id, false).await;
        sqlx::query("UPDATE runs r SET verification_status=p.verification_status,verification_sha256=p.verification_sha256,deliverable_sha256=p.deliverable_sha256,workspace_base_commit=p.workspace_base_commit,source_base_commit=p.source_base_commit,runner_id=p.runner_id FROM jsonb_populate_record(NULL::runs,$2) p WHERE r.id=$1")
            .bind(command.run_id).bind(original_run).execute(&store.pool).await.unwrap();
        sqlx::query("UPDATE source_deliverables SET verification_sha256=repeat('c',64),base_commit=repeat('a',40) WHERE run_id=$1")
            .bind(command.run_id).execute(&store.pool).await.unwrap();
        sqlx::query("UPDATE artifacts SET run_id=$1,sha256=$2 WHERE id=$3")
            .bind(command.run_id)
            .bind(&artifact.sha256)
            .bind(artifact.id)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET contract=$1 WHERE id=$2")
            .bind(&original["task"]["contract"])
            .bind(TASK)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_downloadable(&store, artifact.id, true).await;
    }
    for (field, value) in [
        ("verified_tree", json!("9".repeat(40))),
        ("verification_sha256", json!("9".repeat(64))),
        ("base_commit", json!("9".repeat(40))),
        ("source_verification", Value::Null),
        ("source_verification", json!({})),
    ] {
        let mut metadata = artifact.metadata.clone();
        metadata[field] = value;
        sqlx::query("UPDATE artifacts SET metadata=$1 WHERE id=$2")
            .bind(metadata)
            .bind(artifact.id)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_downloadable(&store, artifact.id, false).await;
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue82_historical_sources_and_provider_evidence_keep_their_download_contract(
    pool: PgPool,
) {
    let (store, _, artifact) = ready_export_fixture_with_publication(pool, false).await;
    let mut historical = artifact.metadata.clone();
    for field in ["verified_tree", "source_verification"] {
        historical.as_object_mut().unwrap().remove(field);
    }
    sqlx::query("UPDATE artifacts SET metadata=$1 WHERE id=$2")
        .bind(&historical)
        .bind(artifact.id)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_downloadable(&store, artifact.id, true).await;
    // A present null or a partial extension must never masquerade as history.
    for field in ["verified_tree", "source_verification"] {
        for value in [Value::Null, artifact.metadata[field].clone()] {
            let mut partial = historical.clone();
            partial[field] = value;
            sqlx::query("UPDATE artifacts SET metadata=$1 WHERE id=$2")
                .bind(partial)
                .bind(artifact.id)
                .execute(&store.pool)
                .await
                .unwrap();
            assert_downloadable(&store, artifact.id, false).await;
        }
    }
    sqlx::query("UPDATE artifacts SET artifact_role='provider_evidence' WHERE id=$1")
        .bind(artifact.id)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_downloadable(&store, artifact.id, true).await;
}
