//! Real SQLx lifecycle regressions. Reuses the completed publication fixture;
//! source, provider and review metadata are synthetic, not runtime acceptance.
use super::*;
use crony_domain::{
    AuthorizeFactoryBaseRefresh, FactoryBaseRefreshResponse, SettleFactoryBaseRefresh,
};

const NEW_BASE: &str = "1111111111111111111111111111111111111111";

#[path = "factory_base_refresh_authority_tests.rs"]
mod authority;

async fn current_item(f: &PublicationFixture) -> FactoryWorkItem {
    let mut tx = f.store.pool.begin().await.unwrap();
    let item = factory_work_item_tx(&mut tx, CORP, ITEM, false)
        .await
        .unwrap()
        .unwrap()
        .0;
    tx.rollback().await.unwrap();
    item
}

async fn request_refresh(f: &PublicationFixture) -> AuthorizeFactoryBaseRefresh {
    let item = current_item(f).await;
    AuthorizeFactoryBaseRefresh {
        actor_id: OWNER,
        claim_token: CLAIM,
        expected_version: item.version,
        idempotency_key: Uuid::new_v4(),
        source_deliverable_id: f.input.source_deliverable_id,
        new_base_commit: NEW_BASE.into(),
        observed_source_revision: "revision-1".into(),
        reason:
            "Explicit SQLx fixture authorization of the same verified delta on an advanced base"
                .into(),
    }
}

async fn advance_connection(f: &PublicationFixture) {
    // Connection report metadata is synthetic here. The dedicated runtime lane
    // exercises the native connection check before making this observation.
    sqlx::query(
        "UPDATE workspace_connections SET source_base_commit=$1 WHERE corp_id=$2 AND id=$3",
    )
    .bind(NEW_BASE)
    .bind(CORP)
    .bind(CONNECTION)
    .execute(&f.store.pool)
    .await
    .unwrap();
}

async fn authorize_refresh(f: &PublicationFixture) -> FactoryBaseRefreshResponse {
    advance_connection(f).await;
    f.store
        .authorize_factory_base_refresh(CORP, ITEM, request_refresh(f).await)
        .await
        .unwrap()
}

async fn settlement(f: &PublicationFixture) -> SettleFactoryBaseRefresh {
    let item = current_item(f).await;
    SettleFactoryBaseRefresh {
        actor_id: OWNER,
        claim_token: CLAIM,
        expected_version: item.version,
        idempotency_key: Uuid::new_v4(),
        observed_source_revision: "revision-1".into(),
        reason: "Explicit SQLx fixture settlement".into(),
    }
}

async fn refresh_command(
    f: &PublicationFixture,
    refresh: &FactoryBaseRefreshResponse,
) -> PendingRunnerCommand {
    f.store
        .pending_runner_commands(RUNNER)
        .await
        .unwrap()
        .into_iter()
        .find(|command| command.run_id == refresh.refresh.run_id)
        .unwrap()
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_admission_replays_and_preserves_original_publication_source(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    advance_connection(&f).await;
    let before = publication_state(&f.store).await;
    let input = request_refresh(&f).await;
    let first = f
        .store
        .authorize_factory_base_refresh(CORP, ITEM, input.clone())
        .await
        .unwrap();
    assert_eq!(first.work_item.mission_id, Some(MISSION));
    assert_eq!(first.work_item.state, FactoryWorkItemState::Verified);
    assert_eq!(first.refresh.original_base_commit, "a".repeat(40));
    assert_eq!(first.refresh.refreshed_base_commit, NEW_BASE);
    assert_ne!(first.refresh.mission_id, MISSION);
    assert_ne!(first.refresh.run_id, f.verifier_run_id);
    let after = publication_state(&f.store).await;
    for original in before["runs"].as_array().unwrap() {
        assert_eq!(
            after["runs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|run| run["id"] == original["id"]),
            Some(original)
        );
    }
    assert_eq!(
        after["runs"].as_array().unwrap().len(),
        before["runs"].as_array().unwrap().len() + 1
    );
    assert_eq!(before["source"], after["source"]);
    assert_eq!(before["task"], after["task"]);
    let second = f
        .store
        .authorize_factory_base_refresh(CORP, ITEM, input.clone())
        .await
        .unwrap();
    assert!(second.replayed);
    assert_eq!(second.refresh.id, first.refresh.id);
    assert!(second.events.is_empty());
    assert_eq!(publication_state(&f.store).await, after);
    let mut altered = input;
    altered.new_base_commit = "2".repeat(40);
    assert!(
        f.store
            .authorize_factory_base_refresh(CORP, ITEM, altered)
            .await
            .is_err()
    );
    assert_eq!(publication_state(&f.store).await, after);
    assert!(
        f.store
            .start_pull_request_publication(f.input.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("fenced")
    );
    let command = refresh_command(&f, &first).await;
    let artifacts = f
        .store
        .base_refresh_dispatch_artifacts(&command)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(artifacts.0.run_id, f.verifier_run_id);
    assert_eq!(artifacts.1.unwrap().run_id, f.verifier_run_id);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_stale_connection_and_changed_authority_cannot_allocate_refresh(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let before = publication_state(&f.store).await;
    let input = request_refresh(&f).await;
    let error = f
        .store
        .authorize_factory_base_refresh(CORP, ITEM, input.clone())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("mission adapter or source does not match the saved connection"),
        "{error:#}"
    );
    assert_eq!(publication_state(&f.store).await, before);
    advance_connection(&f).await;
    let before = publication_state(&f.store).await;
    for case in 0..4 {
        let mut denied = input.clone();
        match case {
            0 => denied.claim_token = Uuid::new_v4(),
            1 => denied.observed_source_revision = "changed-issue".into(),
            2 => denied.source_deliverable_id = Uuid::new_v4(),
            _ => denied.actor_id = REVIEWER,
        }
        assert!(
            f.store
                .authorize_factory_base_refresh(CORP, ITEM, denied)
                .await
                .is_err(),
            "case {case}"
        );
        assert_eq!(publication_state(&f.store).await, before);
    }
    assert!(
        f.store
            .authorize_factory_base_refresh(Uuid::new_v4(), ITEM, input)
            .await
            .is_err()
    );
    assert_eq!(publication_state(&f.store).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_publication_already_started_cannot_allocate_refresh(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    f.store
        .start_pull_request_publication(f.input.clone())
        .await
        .unwrap();
    advance_connection(&f).await;
    let before = publication_state(&f.store).await;
    let error = f
        .store
        .authorize_factory_base_refresh(CORP, ITEM, request_refresh(&f).await)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("publication that has already started"),
        "{error:#}"
    );
    assert_eq!(publication_state(&f.store).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_abandonment_is_terminal_authorized_and_bounded_after_issue_changes(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    for _ in 0..crony_domain::MAX_BASE_REFRESH_ATTEMPTS {
        let refresh = authorize_refresh(&f).await;
        let mut input = settlement(&f).await;
        input.observed_source_revision = "issue-changed-after-admission".into();
        let before = publication_state(&f.store).await;
        assert!(
            f.store
                .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, input.clone(), false)
                .await
                .unwrap_err()
                .to_string()
                .contains("stop the active refresh")
        );
        assert_eq!(publication_state(&f.store).await, before);
        let command = refresh_command(&f, &refresh).await;
        f.store
            .fail_base_refresh_before_dispatch(
                &command,
                "SQLx fixture: native transport never started",
            )
            .await
            .unwrap();
        let before = publication_state(&f.store).await;
        for case in 0..3 {
            let mut denied = input.clone();
            match case {
                0 => denied.actor_id = REVIEWER,
                1 => denied.claim_token = Uuid::new_v4(),
                _ => denied.expected_version -= 1,
            }
            assert!(
                f.store
                    .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, denied, false)
                    .await
                    .is_err()
            );
            assert_eq!(publication_state(&f.store).await, before);
        }
        assert!(
            f.store
                .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, input.clone(), true)
                .await
                .unwrap_err()
                .to_string()
                .contains("issue revision changed")
        );
        assert_eq!(publication_state(&f.store).await, before);
        let abandoned = f
            .store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, input.clone(), false)
            .await
            .unwrap();
        assert_eq!(abandoned.refresh.state, "abandoned");
        assert_eq!(abandoned.work_item.mission_id, Some(MISSION));
        assert_eq!(abandoned.work_item.state, FactoryWorkItemState::Verified);
        assert_eq!(abandoned.work_item.policy, before["item"]["policy"]);
        let after = publication_state(&f.store).await;
        assert_eq!(after["runs"], before["runs"]);
        assert_eq!(after["task"], before["task"]);
        assert_eq!(after["source"], before["source"]);
        assert!(
            f.store
                .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, input.clone(), false)
                .await
                .unwrap()
                .replayed
        );
        assert_eq!(publication_state(&f.store).await, after);
        assert!(
            f.store
                .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, input, true)
                .await
                .is_err()
        );
        assert_eq!(publication_state(&f.store).await, after);
    }
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .authorize_factory_base_refresh(CORP, ITEM, request_refresh(&f).await)
            .await
            .unwrap_err()
            .to_string()
            .contains("attempt limit")
    );
    assert_eq!(publication_state(&f.store).await, before);
    assert_eq!(
        f.store
            .factory_base_refreshes(CORP, OWNER, ITEM)
            .await
            .unwrap()
            .len(),
        3
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_dispatch_rechecks_claim_after_artifact_transfer_and_allows_renewal(pool: PgPool) {
    let f = corrected_publication_fixture(pool).await;
    let refresh = authorize_refresh(&f).await;
    let command = refresh_command(&f, &refresh).await;
    let renewed = f
        .store
        .renew_factory_work_item(RenewFactoryWorkItemInput {
            corp_id: CORP,
            work_item_id: ITEM,
            actor_id: OWNER,
            claim_token: CLAIM,
            expected_version: refresh.work_item.version,
            lease_seconds: 300,
            idempotency_key: Uuid::new_v4().to_string(),
        })
        .await
        .unwrap();
    assert!(renewed.work_item.version > refresh.work_item.version);
    assert!(
        f.store
            .base_refresh_dispatch_artifacts(&command)
            .await
            .unwrap()
            .is_some()
    );
    let sent = f
        .store
        .with_base_refresh_command_dispatch(&command, || Ok(true))
        .await
        .unwrap();
    assert!(matches!(
        sent.transport_result,
        RunnerCommandDispatchOutcome::Sent
    ));
    assert!(sent.commit_error.is_none());
    // Simulate revocation between authenticated artifact reads and native
    // enqueue. The callback must never run after this current-claim change.
    sqlx::query("UPDATE factory_work_items SET claim_token=$1 WHERE corp_id=$2 AND id=$3")
        .bind(Uuid::new_v4())
        .bind(CORP)
        .bind(ITEM)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .base_refresh_dispatch_artifacts(&command)
            .await
            .unwrap()
            .is_none()
    );
    let blocked = f
        .store
        .with_base_refresh_command_dispatch(&command, || panic!("revoked native enqueue"))
        .await
        .unwrap();
    assert!(matches!(
        blocked.transport_result,
        RunnerCommandDispatchOutcome::Obsolete
    ));
    assert_eq!(publication_state(&f.store).await, before);
}

fn refresh_event(command: &PendingRunnerCommand, kind: &str, payload: Value) -> RunnerEventInput {
    let token = serde_json::from_value(command.payload["assignment_token"].clone()).unwrap();
    RunnerEventInput {
        agent_id: serde_json::from_value(command.payload["agent_id"].clone()).unwrap(),
        ..event(command.run_id, token, kind, payload)
    }
}

fn refreshed_source() -> crony_domain::SourceVerification {
    crony_domain::SourceVerification {
        base_commit: NEW_BASE.into(),
        tree: "2".repeat(40),
        candidate_commit: "3".repeat(40),
        ignored_input_sha256: hex::encode(Sha256::digest([])),
        ignored_input_count: 0,
        ignored_input_bytes: 0,
    }
}

async fn verify_refresh(f: &PublicationFixture, refresh: &FactoryBaseRefreshResponse) -> Uuid {
    let command = refresh_command(f, refresh).await;
    let (_, provider) = f
        .store
        .base_refresh_dispatch_artifacts(&command)
        .await
        .unwrap()
        .unwrap();
    let provider = provider.unwrap();
    assert_eq!(provider.run_id, f.verifier_run_id);
    let sent = f
        .store
        .with_base_refresh_command_dispatch(&command, || Ok(true))
        .await
        .unwrap();
    assert!(matches!(
        sent.transport_result,
        RunnerCommandDispatchOutcome::Sent
    ));
    f.store
        .acknowledge_runner_command(command.id, RUNNER)
        .await
        .unwrap();
    for (kind, payload) in [
        (
            "run.started",
            json!({"workspace":"isolated-refresh-fixture","workspace_branch":"crony/refresh-fixture",
            "workspace_base_ref":"main","workspace_base_commit":NEW_BASE,"execution_mode":"verification_only"}),
        ),
        ("run.verification_started", json!({})),
        (
            "run.verification_evidence",
            json!({"evidence_id":Uuid::new_v4(),"check_index":0,"kind":"file","status":"passed",
            "summary":"Synthetic refresh source-file check","payload":{"source":refreshed_source()}}),
        ),
    ] {
        f.store
            .apply_runner_event(refresh_event(&command, kind, payload))
            .await
            .unwrap();
    }
    // No accepted completion can precede the second saved verifier check.
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .apply_runner_event(refresh_event(
                &command,
                "run.verification_passed",
                json!({
                    "verification_sha256":"4".repeat(64),"source_verification":refreshed_source()
                })
            ))
            .await
            .is_err()
    );
    assert_eq!(publication_state(&f.store).await, before);
    f.store
        .apply_runner_event(refresh_event(
            &command,
            "run.verification_evidence",
            json!({
                "evidence_id":Uuid::new_v4(),"check_index":1,"kind":"artifact","status":"passed",
                "summary":"Fresh check of inherited provider artifact; no new inference claimed",
                "payload":{"path":provider.uri,"sha256":provider.sha256,"bytes":provider.bytes,
                    "media_type":provider.media_type,"source":refreshed_source()}
            }),
        ))
        .await
        .unwrap();
    let input = refresh_event(&command, "run.deliverable_upload", json!({}));
    let mut artifact = fixture_artifact(
        &input,
        b"issue84 synthetic refreshed export",
        "source_deliverable",
        "ecorp-commit-branch.json",
        "application/vnd.ecorp.deliverable+json",
        json!({
            "form":"commit_branch","verification_sha256":"4".repeat(64),
            "base_commit":NEW_BASE,"head_commit":"5".repeat(40),"branch":"crony/refresh-fixture",
            "integration_state":"ready_for_review","git_bundle_sha256":hex::encode(Sha256::digest(b"synthetic refresh bundle")),
            "publication_ready":true,"verified_tree":refreshed_source().tree,"source_verification":refreshed_source()
        }),
    );
    artifact.task_id = refresh.refresh.task_id;
    artifact.producer_agent_id = input.agent_id;
    f.store
        .prepare_artifact_upload(
            input,
            artifact.clone(),
            &format!("staging/corps/{CORP}/{}", artifact.id),
        )
        .await
        .unwrap();
    f.store
        .finalize_artifact_upload(CORP, artifact.id)
        .await
        .unwrap()
        .unwrap();
    for (kind, payload) in [
        (
            "run.verification_passed",
            json!({"summary":"Complete synthetic verifier-policy evidence",
            "verification_sha256":"4".repeat(64),"deliverable_sha256":artifact.sha256,
            "verified_tree":refreshed_source().tree,"source_verification":refreshed_source()}),
        ),
        (
            "run.verification_waiting",
            json!({"gate":command.payload["verification_policy"]["manual_gate"],"gate_type":"independent_review"}),
        ),
        (
            "run.workspace_preserved",
            json!({"workspace":"isolated-refresh-fixture","workspace_branch":"crony/refresh-fixture",
            "workspace_base_ref":"main","workspace_base_commit":NEW_BASE,"workspace_fingerprint":"6".repeat(64),
            "head_commit":"5".repeat(40),"workspace_quarantined":false,"detail":"Synthetic refresh workspace preservation"}),
        ),
    ] {
        f.store
            .apply_runner_event(refresh_event(&command, kind, payload))
            .await
            .unwrap();
    }
    sqlx::query_scalar("SELECT id FROM source_deliverables WHERE corp_id=$1 AND artifact_id=$2")
        .bind(CORP)
        .bind(artifact.id)
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue84_complete_verification_independent_review_and_explicit_adoption_publish_once(
    pool: PgPool,
) {
    let f = corrected_publication_fixture(pool).await;
    let original = publication_state(&f.store).await;
    let refresh = authorize_refresh(&f).await;
    let result = verify_refresh(&f, &refresh).await;
    assert_eq!(current_item(&f).await.mission_id, Some(MISSION));
    let before = publication_state(&f.store).await;
    assert!(
        f.store
            .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, settlement(&f).await, true)
            .await
            .is_err()
    );
    for (actor, key) in [
        (OWNER, Some(Uuid::new_v4())),
        (REVIEWER, None),
        (REVIEWER, Some(Uuid::nil())),
    ] {
        assert!(
            f.store
                .decide_verification(
                    CORP,
                    refresh.refresh.run_id,
                    actor,
                    true,
                    "Synthetic independent review",
                    key
                )
                .await
                .is_err()
        );
        assert_eq!(publication_state(&f.store).await, before);
    }
    let review_key = Uuid::new_v4();
    f.store
        .decide_verification(
            CORP,
            refresh.refresh.run_id,
            REVIEWER,
            true,
            "Synthetic independent review",
            Some(review_key),
        )
        .await
        .unwrap();
    assert_eq!(current_item(&f).await.mission_id, Some(MISSION));
    let adopted = f
        .store
        .settle_factory_base_refresh(CORP, ITEM, refresh.refresh.id, settlement(&f).await, true)
        .await
        .unwrap();
    assert_eq!(adopted.refresh.state, "adopted");
    assert_eq!(adopted.refresh.result_deliverable_id, Some(result));
    assert_eq!(adopted.refresh.result_commit, Some("5".repeat(40)));
    assert_eq!(adopted.refresh.review_decision_id, Some(review_key));
    assert_eq!(
        adopted.work_item.mission_id,
        Some(refresh.refresh.mission_id)
    );
    assert_eq!(adopted.work_item.policy["source_base_commit"], NEW_BASE);
    let after = publication_state(&f.store).await;
    for run in original["runs"].as_array().unwrap() {
        assert_eq!(
            after["runs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|candidate| candidate["id"] == run["id"]),
            Some(run)
        );
    }
    assert_eq!(after["source"], original["source"]);
    assert_eq!(after["task"], original["task"]);
    let mut authority = f.store.pool.begin().await.unwrap();
    assert!(
        budget_checkpoint::zero_provider_allocation_tx(&mut authority, CORP, f.verifier_run_id,)
            .await
            .unwrap()
    );
    assert!(
        !budget_checkpoint::zero_provider_allocation_tx(&mut authority, CORP, f.corrected_run_id,)
            .await
            .unwrap()
    );
    budget_checkpoint::source_authority_tx(&mut authority, CORP, ITEM, f.corrected_run_id)
        .await
        .unwrap();
    assert_eq!(
        checkpoint_retention::exported_head_tx(&mut authority, CORP, f.verifier_run_id)
            .await
            .unwrap()
            .as_deref(),
        Some(refresh.refresh.source_head_commit.as_str())
    );
    for (corp, item) in [(Uuid::new_v4(), ITEM), (CORP, Uuid::new_v4())] {
        assert!(
            !factory_base_refresh::adopted_source_contains_run_tx(
                &mut authority,
                corp,
                item,
                f.verifier_run_id,
            )
            .await
            .unwrap()
        );
    }
    authority.rollback().await.unwrap();
    let mut input = f.input.clone();
    input.source_deliverable_id = result;
    let started = f
        .store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    assert_eq!(started.publication.run_id, refresh.refresh.run_id);
    let replayed = f.store.start_pull_request_publication(input).await.unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.publication.id, started.publication.id);
    assert_eq!(
        publication_state(&f.store).await["publication"]["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
