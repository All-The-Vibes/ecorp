//! #89 real-store regressions with synthetic checkpoint metadata. Native Git
//! bytes, exporter behavior and browser acceptance have separate fixture lanes.
use super::*;
use crony_domain::{PreservedDeliverableCheckpoint, PreservedProviderArtifact};

const SCOPE: &[&str] = &["result.md", "scenario/**", "unused/**"];

fn deliverable() -> DeliverableSpec {
    DeliverableSpec {
        form: DeliverableForm::CommitBranch,
        commit_after_verification: true,
        paths: vec!["scenario".to_owned()],
    }
}

async fn source_fixture(pool: PgPool, suspended: bool) -> PgStore {
    fixture_with_profile(
        pool,
        true,
        false,
        Some(deliverable()),
        false,
        CheckpointFixtureProfile {
            mission_tokens: 10_000,
            run_tokens: 5_000,
            used_tokens: if suspended { 5_300 } else { 100 },
            attempt_count: 1,
            expected_stage: if suspended { "suspend" } else { "healthy" },
            verification_failure: !suspended,
            workspace_connection_id: Some(Uuid::from_u128(89)),
            write_scope: Some(SCOPE),
            ..CheckpointFixtureProfile::default()
        },
    )
    .await
}

fn proof() -> PreservedDeliverableCheckpoint {
    PreservedDeliverableCheckpoint {
        schema_version: 1,
        run_id: SOURCE,
        workspace_run_id: SOURCE,
        workspace_base_commit: "a".repeat(40),
        head_commit: "a".repeat(40),
        workspace_fingerprint: "b".repeat(64),
        index_sha256: "c".repeat(64),
        deliverable: Some(deliverable()),
        changed_paths: [
            "scenario/.gitignore",
            "scenario/EVIDENCE.md",
            "scenario/committed.js",
            "scenario/staged-only.js",
            "scenario/untracked.js",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        provider_artifacts: Vec::new(),
    }
}

async fn attest(store: &PgStore, proof: Value) {
    // Preserve the already accepted outer identity even in malformed-proof
    // cases. This is a new authenticated journal event, not retrofitted history.
    store
        .apply_runner_event(event(
            SOURCE,
            TOKEN,
            "run.workspace_preserved",
            json!({"workspace":"fixture-worktree","workspace_branch":"crony/fixture",
                "workspace_base_ref":"main","workspace_base_commit":"a".repeat(40),
                "workspace_fingerprint":"b".repeat(64),"head_commit":"a".repeat(40),
                "workspace_quarantined":false,"deliverable_checkpoint":proof}),
        ))
        .await
        .unwrap();
}

async fn business_state(store: &PgStore) -> Value {
    let mut snapshot = state(store).await;
    for (key, query) in [
        (
            "contract_revisions",
            "SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM mission_contract_revisions r",
        ),
        (
            "budget_revisions",
            "SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM mission_budget_revisions r",
        ),
    ] {
        snapshot[key] = sqlx::query_scalar(query)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    }
    // Audited refusals may add audit records; they must not change business
    // state, journal events, commands, contracts, budgets or run attempts.
    snapshot
}

async fn revision(store: &PgStore, scope: Vec<String>) -> CreateMissionContractRevisionInput {
    let before = state(store).await;
    let mut contract: TaskContract =
        serde_json::from_value(before["task"]["contract"].clone()).unwrap();
    contract.write_scope = scope;
    CreateMissionContractRevisionInput {
        corp_id: CORP,
        mission_id: MISSION,
        task_id: TASK,
        actor_id: OWNER,
        expected_contract_version: before["task"]["contract_version"].as_i64().unwrap(),
        next_action: MissionContractRevisionAction::Resume,
        source_run_id: Some(SOURCE),
        reason: "Correct evidence without losing the retained application".to_owned(),
        idempotency_key: Uuid::new_v4(),
        description: "Retain all selected source while correcting evidence".to_owned(),
        contract,
        verification_policy: serde_json::from_value(before["task"]["verification_policy"].clone())
            .unwrap(),
    }
}

async fn refuse_revision(store: &PgStore, scope: Vec<String>) -> String {
    let input = revision(store, scope).await;
    let before = business_state(store).await;
    let error = store
        .create_mission_contract_revision(input)
        .await
        .unwrap_err();
    assert_eq!(business_state(store).await, before);
    format!("{error:#}")
}

fn complete_scope() -> Vec<String> {
    vec!["result.md".to_owned(), "scenario/**".to_owned()]
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_legacy_proof_refuses_narrowing_but_allows_unchanged_authority(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    let error = refuse_revision(&store, complete_scope()).await;
    assert!(error.contains("complete runner checkpoint"), "{error}");
    assert!(error.contains("Do not retry this correction in a fresh worktree"));
    let before = state(&store).await;
    store
        .create_mission_contract_revision(
            revision(&store, SCOPE.iter().map(|s| (*s).to_owned()).collect()).await,
        )
        .await
        .unwrap();
    let after = state(&store).await;
    for key in ["runs", "commands", "source"] {
        assert_eq!(after[key], before[key], "{key}");
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_contract_narrowing_keeps_each_retained_source_category(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    let proof = proof();
    attest(&store, json!(proof)).await;
    for omitted in &proof.changed_paths {
        let scope = std::iter::once("result.md".to_owned())
            .chain(
                proof
                    .changed_paths
                    .iter()
                    .filter(|path| *path != omitted)
                    .cloned(),
            )
            .collect();
        let error = refuse_revision(&store, scope).await;
        assert!(error.contains(omitted), "missing {omitted}: {error}");
    }
    let before = state(&store).await;
    let accepted = store
        .create_mission_contract_revision(revision(&store, complete_scope()).await)
        .await
        .unwrap();
    assert_eq!(
        accepted.revision.replacement_contract.write_scope,
        complete_scope()
    );
    let after = state(&store).await;
    assert_eq!(after["runs"], before["runs"]);
    assert_eq!(after["commands"], before["commands"]);
    assert_eq!(
        after["task"]["attempt_count"],
        before["task"]["attempt_count"]
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_foreign_or_malformed_checkpoint_cannot_authorize_narrowing(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    for (field, value) in [
        ("run_id", json!(Uuid::new_v4())),
        ("workspace_run_id", json!(Uuid::new_v4())),
        ("workspace_base_commit", json!("d".repeat(40))),
        ("workspace_fingerprint", json!("d".repeat(64))),
        ("head_commit", json!("d".repeat(40))),
        ("index_sha256", json!("not-a-digest")),
        ("schema_version", json!(2)),
        ("deliverable", Value::Null),
        ("changed_paths", json!(["../escape"])),
    ] {
        let mut bad = json!(proof());
        bad[field] = value;
        attest(&store, bad).await;
        refuse_revision(&store, complete_scope()).await;
    }
    attest(&store, json!(proof())).await;
    for column in ["room_id", "correlation_id"] {
        // Fault injection in this disposable metadata fixture; the public
        // RunnerEvent API correctly derives these scopes from the source run.
        let seq: i64 = sqlx::query_scalar(
            "SELECT max(seq) FROM events WHERE aggregate_id=$1 AND type='run.workspace_preserved'",
        )
        .bind(SOURCE)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let query = format!("UPDATE events SET {column}=NULL WHERE seq=$1");
        sqlx::query(&query)
            .bind(seq)
            .execute(&store.pool)
            .await
            .unwrap();
        refuse_revision(&store, complete_scope()).await;
        attest(&store, json!(proof())).await;
    }
    let mut foreign = revision(&store, complete_scope()).await;
    foreign.corp_id = Uuid::new_v4();
    let before = business_state(&store).await;
    assert!(
        store
            .create_mission_contract_revision(foreign)
            .await
            .is_err()
    );
    assert_eq!(business_state(&store).await, before);
    store
        .create_mission_contract_revision(revision(&store, complete_scope()).await)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_latest_cleanup_and_termination_require_new_complete_attestation(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    attest(&store, json!(proof())).await;
    attest(&store, Value::Null).await;
    assert!(
        refuse_revision(&store, complete_scope())
            .await
            .contains("complete runner checkpoint")
    );
    attest(&store, json!(proof())).await;
    store
        .apply_runner_event(event(
            SOURCE,
            TOKEN,
            "run.session_terminated",
            json!({"adapter":"codex","outcome":"completed","provider_process_alive":false}),
        ))
        .await
        .unwrap();
    assert!(
        refuse_revision(&store, complete_scope())
            .await
            .contains("not quiescent")
    );
    attest(&store, json!(proof())).await;
    store
        .create_mission_contract_revision(revision(&store, complete_scope()).await)
        .await
        .unwrap();
}

async fn finish_scope(store: &PgStore, scope: Vec<String>) -> ProposeMissionBudgetRevisionInput {
    let current = state(store).await;
    ProposeMissionBudgetRevisionInput {
        corp_id: CORP,
        mission_id: MISSION,
        actor_id: OWNER,
        expected_budget_tokens: 10_000,
        expected_budget_cost_microusd: 5_000_000,
        proposed_budget_tokens: 12_000,
        proposed_budget_cost_microusd: 5_000_000,
        rationale: "Finish retained application evidence under bounded authority".to_owned(),
        idempotency_key: Uuid::new_v4(),
        finish_scope: Some(MissionFinishScopeInput {
            task_id: TASK,
            objective: "Correct scenario evidence".to_owned(),
            expected_output: "Complete scenario and evidence".to_owned(),
            acceptance_tests: vec!["All retained scenario files export".to_owned()],
            write_scope: scope,
            budget_tokens: 3_000,
            budget_cost_microusd: 1_000_000,
            verification_policy: serde_json::from_value(
                current["task"]["verification_policy"].clone(),
            )
            .unwrap(),
        }),
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_budget_finish_scope_checks_proposal_and_latest_index_at_approval(pool: PgPool) {
    let store = source_fixture(pool, true).await;
    attest(&store, json!(proof())).await;
    let before = business_state(&store).await;
    let denied = store
        .propose_mission_budget_revision(
            finish_scope(&store, vec!["scenario/EVIDENCE.md".to_owned()]).await,
        )
        .await;
    assert!(format!("{:#}", denied.unwrap_err()).contains("scenario/.gitignore"));
    assert_eq!(business_state(&store).await, before);
    let proposal = store
        .propose_mission_budget_revision(finish_scope(&store, proof().changed_paths).await)
        .await
        .unwrap();
    let mut changed = proof();
    changed.index_sha256 = "d".repeat(64);
    changed
        .changed_paths
        .push("scenario/newly-staged.js".to_owned());
    changed.changed_paths.sort();
    attest(&store, json!(changed)).await;
    let decision = DecideMissionBudgetRevisionInput {
        corp_id: CORP,
        mission_id: MISSION,
        actor_id: OWNER,
        revision_id: proposal.revision.id,
        expected_version: proposal.revision.version,
        approved: true,
        note: "Only the complete retained delta may finish".to_owned(),
        decision_key: Uuid::new_v4(),
    };
    let before = business_state(&store).await;
    let error = store
        .decide_mission_budget_revision(decision.clone())
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("scenario/newly-staged.js"));
    assert_eq!(
        business_state(&store).await,
        before,
        "budget update must roll back with refusal"
    );
    // Model a later native re-attestation after the newly staged change is
    // explicitly removed. The existing selected application is still complete.
    attest(&store, json!(proof())).await;
    let before = state(&store).await;
    store
        .decide_mission_budget_revision(DecideMissionBudgetRevisionInput {
            decision_key: Uuid::new_v4(),
            ..decision
        })
        .await
        .unwrap();
    let after = state(&store).await;
    assert_eq!(after["mission"]["budget_tokens"], 12_000);
    for key in ["runs", "source", "commands"] {
        assert_eq!(
            after[key], before[key],
            "budget approval must not execute: {key}"
        );
    }
}

async fn artifact_metadata(store: &PgStore) -> PreservedProviderArtifact {
    let artifact = PreservedProviderArtifact {
        path: "historical-provider.md".to_owned(),
        sha256: "e".repeat(64),
        bytes: 42,
        media_type: "text/markdown".to_owned(),
    };
    // No object or valid server signature is claimed by this metadata fixture.
    sqlx::query(
        "INSERT INTO artifacts(id,corp_id,task_id,run_id,producer_agent_id,
        producer_runner_id,verifier,object_key,uri,sha256,media_type,bytes,
        retention_until,provenance_signature,status,artifact_role,metadata,finalized_at)
        VALUES($1,$2,$3,$4,$5,$6,'metadata-fixture','fixture','fixture',$7,$8,$9,
        now()+interval '1 hour',$10,'ready','provider_evidence',$11,now())",
    )
    .bind(Uuid::new_v4())
    .bind(CORP)
    .bind(TASK)
    .bind(SOURCE)
    .bind(AGENT)
    .bind(RUNNER)
    .bind(&artifact.sha256)
    .bind(&artifact.media_type)
    .bind(artifact.bytes as i64)
    .bind("f".repeat(64))
    .bind(json!({"workspace_relative_path":artifact.path}))
    .execute(&store.pool)
    .await
    .unwrap();
    artifact
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_legacy_checkpoint_upgrade_and_replay_freeze_original_authority(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    let input = CheckpointFactoryWorkspaceInput {
        corp_id: CORP,
        work_item_id: ITEM,
        actor_id: OWNER,
        claim_token: CLAIM,
        expected_version: state(&store).await["item"]["version"].as_i64().unwrap(),
        idempotency_key: Uuid::new_v4().to_string(),
        source_run_id: SOURCE,
        expected_head_commit: "a".repeat(40),
    };
    let accepted = store
        .checkpoint_factory_workspace(input.clone())
        .await
        .unwrap();
    let command_id = accepted
        .command_id
        .expect("legacy fingerprint must permit a complete checkpoint upgrade");
    let commands = store.pending_runner_commands(RUNNER).await.unwrap();
    let command = commands.iter().find(|c| c.id == command_id).unwrap();
    assert_eq!(
        command.payload["expected_workspace_fingerprint"],
        "b".repeat(64)
    );
    assert_eq!(command.payload["deliverable"], json!(deliverable()));
    assert_eq!(command.payload["preserved_provider_artifacts"], json!([]));
    artifact_metadata(&store).await;
    let before = business_state(&store).await;
    let replay = store
        .checkpoint_factory_workspace(input.clone())
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.command_id, Some(command_id));
    assert_eq!(business_state(&store).await, before);
    // Model a durable command written by the old protocol. Replay must retain
    // its absent fields instead of upgrading its authority from current data.
    sqlx::query("UPDATE runner_commands SET payload=payload-'deliverable'-'preserved_provider_artifacts'-'expected_workspace_fingerprint' WHERE id=$1")
        .bind(command_id).execute(&store.pool).await.unwrap();
    let before = business_state(&store).await;
    assert!(
        store
            .checkpoint_factory_workspace(input)
            .await
            .unwrap()
            .replayed
    );
    assert_eq!(business_state(&store).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_correction_replay_keeps_frozen_proof_and_historical_artifacts(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    let artifact = artifact_metadata(&store).await;
    attest(&store, json!(proof())).await;
    let revision = store
        .create_mission_contract_revision(revision(&store, complete_scope()).await)
        .await
        .unwrap();
    let mut input = request();
    input.mode = FactoryVerificationRecoveryMode::SourceCorrection;
    input.contract_revision_id = Some(revision.revision.id);
    input.expected_factory_version = state(&store).await["item"]["version"].as_i64().unwrap();
    input.observed_source_revision = "revision-2".to_owned();
    input.reviewed_source_snapshot = json!({"source_revision":"revision-2","issue_number":148});
    let evidence_before = state(&store).await["verification_evidence"].clone();
    let outcome = store
        .create_factory_verification_recovery(input.clone())
        .await
        .unwrap();
    let FactoryVerificationRecoveryLaunch::SourceCorrection(first) = outcome.launch else {
        panic!("expected explicit source correction");
    };
    assert_eq!(first.preserved_deliverable.as_deref(), Some(&proof()));
    assert_eq!(first.preserved_provider_artifacts, vec![artifact]);
    assert_eq!(
        state(&store).await["verification_evidence"],
        evidence_before
    );
    // A later metadata edit must not replace the authority in a durable launch.
    sqlx::query("UPDATE artifacts SET metadata=jsonb_build_object('workspace_relative_path','later.md') WHERE run_id=$1")
        .bind(SOURCE).execute(&store.pool).await.unwrap();
    let before = business_state(&store).await;
    let replay = store
        .create_factory_verification_recovery(input)
        .await
        .unwrap();
    assert!(replay.replayed);
    let FactoryVerificationRecoveryLaunch::SourceCorrection(launch) = replay.launch else {
        panic!("replay changed execution mode");
    };
    assert_eq!(launch.run_id, first.run_id);
    assert_eq!(launch.preserved_deliverable, first.preserved_deliverable);
    assert_eq!(
        launch.preserved_provider_artifacts,
        first.preserved_provider_artifacts
    );
    assert_eq!(business_state(&store).await, before);
}

async fn source_head(store: &PgStore) -> Result<Option<String>> {
    let mut tx = store.pool.begin().await?;
    let checkpoint = source_workspace_checkpoint_with_lock_tx(&mut tx, CORP, SOURCE, false).await?;
    tx.rollback().await?;
    Ok(checkpoint.expected_head_commit)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_legacy_provider_head_requires_exact_preserved_source_scope(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    assert_eq!(state(&store).await["deliverables"], json!([]));
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
    // Synthetic journal corruption must not turn a foreign or unbound report
    // into authority. Each transaction rolls back; no production history is edited.
    for (field, value) in [
        ("workspace", json!("other-worktree")),
        ("workspace_branch", json!("crony/other")),
        ("workspace_base_ref", json!("other")),
        ("workspace_base_commit", json!("d".repeat(40))),
        ("workspace_fingerprint", json!("d".repeat(64))),
        ("workspace_quarantined", json!(true)),
        ("workspace_quarantined", Value::Null),
        ("head_commit", Value::Null),
    ] {
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::query("UPDATE events SET payload=jsonb_set(payload,ARRAY[$3]::text[],$4) WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.workspace_preserved'")
            .bind(CORP).bind(SOURCE).bind(field).bind(value)
            .execute(&mut *tx).await.unwrap();
        let checkpoint = source_workspace_checkpoint_with_lock_tx(&mut tx, CORP, SOURCE, false)
            .await
            .unwrap();
        assert_eq!(checkpoint.expected_head_commit, None, "{field}");
        tx.rollback().await.unwrap();
    }
    for field in ["room_id", "correlation_id"] {
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::query(&format!("UPDATE events SET {field}=NULL WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.workspace_preserved'"))
            .bind(CORP).bind(SOURCE).execute(&mut *tx).await.unwrap();
        assert_eq!(
            source_workspace_checkpoint_with_lock_tx(&mut tx, CORP, SOURCE, false)
                .await
                .unwrap()
                .expected_head_commit,
            None,
            "{field}"
        );
        tx.rollback().await.unwrap();
    }
    let mut legacy = store.pool.begin().await.unwrap();
    sqlx::query("UPDATE events SET payload=payload-'workspace_quarantined' WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.workspace_preserved'")
        .bind(CORP).bind(SOURCE).execute(&mut *legacy).await.unwrap();
    assert_eq!(
        source_workspace_checkpoint_with_lock_tx(&mut legacy, CORP, SOURCE, false)
            .await
            .unwrap()
            .expected_head_commit,
        Some("a".repeat(40)),
        "legacy cleanup need not carry the later quarantine field"
    );
    legacy.rollback().await.unwrap();
    let mut invalid = store.pool.begin().await.unwrap();
    sqlx::query("UPDATE events SET payload=jsonb_set(payload,'{head_commit}',$3) WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.workspace_preserved'")
        .bind(CORP).bind(SOURCE).bind(json!("not-a-commit"))
        .execute(&mut *invalid).await.unwrap();
    assert!(
        source_workspace_checkpoint_with_lock_tx(&mut invalid, CORP, SOURCE, false)
            .await
            .is_err()
    );
    invalid.rollback().await.unwrap();
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_latest_preservation_without_head_never_reuses_older_head(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
    store
        .apply_runner_event(event(
            SOURCE,
            TOKEN,
            "run.workspace_preserved",
            json!({
                "workspace":"fixture-worktree", "workspace_branch":"crony/fixture",
                "workspace_base_ref":"main", "workspace_base_commit":"a".repeat(40),
                "workspace_fingerprint":"b".repeat(64), "workspace_quarantined":false,
                "detail":"Cleanup did not attest a head; do not reuse an older one"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(source_head(&store).await.unwrap(), None);
    attest(&store, json!(proof())).await;
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_uncertain_teardown_invalidates_earlier_provider_termination(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    // Reconstruct an allowed native order: termination, a later uncertainty
    // while verification is active, failed verification, then preservation.
    sqlx::query("UPDATE runs SET status='verifying' WHERE id=$1")
        .bind(SOURCE)
        .execute(&store.pool)
        .await
        .unwrap();
    store.apply_runner_event(event(SOURCE, TOKEN, "run.teardown_uncertain", json!({
        "provider_process_state":"unverified", "detail":"Native teardown could not be proven"
    }))).await.unwrap();
    sqlx::query("UPDATE runs SET status='failed' WHERE id=$1")
        .bind(SOURCE)
        .execute(&store.pool)
        .await
        .unwrap();
    attest(&store, json!(proof())).await;
    assert_eq!(source_head(&store).await.unwrap(), None);
    assert!(
        refuse_revision(&store, complete_scope())
            .await
            .contains("not quiescent")
    );
    store
        .apply_runner_event(event(
            SOURCE,
            TOKEN,
            "run.session_terminated",
            json!({
                "adapter":"codex", "outcome":"completed", "provider_process_alive":false
            }),
        ))
        .await
        .unwrap();
    assert_eq!(
        source_head(&store).await.unwrap(),
        None,
        "termination is newer than preserved bytes"
    );
    attest(&store, json!(proof())).await;
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
    store
        .create_mission_contract_revision(revision(&store, complete_scope()).await)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_provider_export_head_keeps_precedence_and_rejects_conflict(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    artifact_metadata(&store).await;
    // Relational export metadata only; this fixture claims no signed object.
    let artifact: Uuid = sqlx::query_scalar(
        "UPDATE artifacts SET artifact_role='source_deliverable' WHERE run_id=$1 RETURNING id",
    )
    .bind(SOURCE)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO source_deliverables(id,corp_id,task_id,run_id,artifact_id,form,file_name,verification_sha256,base_commit,head_commit,branch,integration_state) VALUES($1,$2,$3,$4,$1,'commit_branch','fixture.bundle',$5,$6,$6,'crony/fixture','ready_for_review')")
        .bind(artifact).bind(CORP).bind(TASK).bind(SOURCE).bind("f".repeat(64)).bind("a".repeat(40))
        .execute(&store.pool).await.unwrap();
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
    sqlx::query("UPDATE events SET payload=payload-'head_commit' WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.workspace_preserved'")
        .bind(CORP).bind(SOURCE).execute(&store.pool).await.unwrap();
    assert_eq!(source_head(&store).await.unwrap(), Some("a".repeat(40)));
    sqlx::query("UPDATE events SET payload=jsonb_set(payload,'{head_commit}',$3) WHERE corp_id=$1 AND aggregate_id=$2 AND type='run.workspace_preserved'")
        .bind(CORP).bind(SOURCE).bind(json!("d".repeat(40))).execute(&store.pool).await.unwrap();
    assert!(format!("{:#}", source_head(&store).await.unwrap_err()).contains("conflicts"));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue89_checkpoint_projection_honors_unlocked_source_reads(pool: PgPool) {
    let store = source_fixture(pool, false).await;
    let mut owner = store.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
        .bind(SOURCE)
        .fetch_one(&mut *owner)
        .await
        .unwrap();
    let mut reader = store.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *reader)
        .await
        .unwrap();
    let checkpoint = source_workspace_checkpoint_with_lock_tx(&mut reader, CORP, SOURCE, false)
        .await
        .expect("a projection must not acquire an extra source lock");
    assert_eq!(checkpoint.expected_head_commit, Some("a".repeat(40)));
    reader.rollback().await.unwrap();
    owner.rollback().await.unwrap();
}
