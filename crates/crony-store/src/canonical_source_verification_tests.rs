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
