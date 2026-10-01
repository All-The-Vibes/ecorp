//! Real SQLx transitions against an owned database. Native events, export bytes,
//! publication receipts and human decisions below are synthetic fixture data,
//! not provider execution, GitHub publication or product acceptance.
use super::*;
use crony_domain::{
    AuthorizeFactoryReviewRevision, FactoryReviewRevisionResponse, ReviewFinding,
    ReviewFindingKind, SettleFactoryReviewRevision,
};

struct RevisionFixture {
    store: PgStore,
    input: StartPullRequestPublicationInput,
    publication: PullRequestPublicationOutcome,
    original_review_key: Uuid,
}

async fn complete_publication(
    store: &PgStore,
    input: &StartPullRequestPublicationInput,
    number: i64,
) -> PullRequestPublicationOutcome {
    let started = store
        .start_pull_request_publication(input.clone())
        .await
        .unwrap();
    let head = started.publication.commit_sha.clone();
    let mut branch = branch_checkpoint(input, &started, Uuid::new_v4().to_string());
    branch.checkpoint = PullRequestPublicationCheckpointInput::BranchPushed {
        commit_sha: head.clone(),
    };
    let pushed = store
        .record_pull_request_publication_checkpoint(branch)
        .await
        .unwrap();
    let mut pr = pull_request_checkpoint(input, &pushed, Uuid::new_v4().to_string());
    if let PullRequestPublicationCheckpointInput::PullRequestCreated {
        number: saved_number,
        node_id,
        url,
        head_sha,
        ..
    } = &mut pr.checkpoint
    {
        *saved_number = number;
        *node_id = format!("PR_issue95_sqlx_{number}");
        *url = format!("https://github.com/fixture/source/pull/{number}");
        *head_sha = head;
    }
    let created = store
        .record_pull_request_publication_checkpoint(pr)
        .await
        .unwrap();
    let mut final_checkpoint = branch_checkpoint(input, &created, Uuid::new_v4().to_string());
    final_checkpoint.checkpoint = PullRequestPublicationCheckpointInput::Published {
        project_status: "In Review".into(),
        project_field_id: "PVTSSF_fixture".into(),
        project_option_id: "review-fixture".into(),
    };
    let completed = store
        .record_pull_request_publication_checkpoint(final_checkpoint)
        .await
        .unwrap();
    assert_eq!(
        completed.publication.state,
        PullRequestPublicationState::Published
    );
    completed
}

async fn revision_fixture(pool: PgPool) -> RevisionFixture {
    // The run cap is narrower than the already authorized task/mission caps.
    // Its native suspension leaves 3,940 task tokens and two attempts. No
    // stopped/completed authority is edited to make admission possible.
    let store = fixture_with_profile(
        pool,
        false,
        false,
        Some(DeliverableSpec {
            form: DeliverableForm::CommitBranch,
            commit_after_verification: true,
            paths: vec!["result.md".into()],
        }),
        true,
        CheckpointFixtureProfile {
            mission_tokens: 10_000,
            run_tokens: 1_000,
            used_tokens: 1_060,
            attempt_count: 1,
            max_attempts: 3,
            expected_stage: "suspend",
            workspace_connection_id: Some(CONNECTION),
            ..CheckpointFixtureProfile::default()
        },
    )
    .await;
    let (store, command, artifact) = ready_export_fixture_from_store(store).await;
    let token = retention_event(&command).assignment_token;
    for (kind, payload) in [
        (
            "run.verification_passed",
            json!({"summary":"Synthetic persisted verifier evidence",
            "verification_sha256":"c".repeat(64),"deliverable_sha256":artifact.sha256,
            "verified_tree":fixture_source_verification().tree,
            "source_verification":fixture_source_verification()}),
        ),
        (
            "run.verification_waiting",
            json!({"gate":gate(),"gate_type":"independent_review"}),
        ),
    ] {
        store
            .apply_runner_event(event(command.run_id, token, kind, payload))
            .await
            .unwrap();
    }
    store
        .acknowledge_runner_command(command.id, RUNNER)
        .await
        .unwrap();
    store
        .apply_runner_event(retention_event(&command))
        .await
        .unwrap();
    let original_review_key = Uuid::new_v4();
    store
        .decide_verification(
            CORP,
            command.run_id,
            REVIEWER,
            true,
            "Synthetic original publication review",
            Some(original_review_key),
        )
        .await
        .unwrap();
    let publisher_hash = digest(&"issue95 SQLx-only publisher credential");
    store
        .create_publication_publisher_credential(
            CORP,
            OWNER,
            "issue95-store-publisher",
            &publisher_hash,
            Utc::now() + Duration::hours(1),
        )
        .await
        .unwrap();
    let source_deliverable_id =
        sqlx::query_scalar("SELECT id FROM source_deliverables WHERE artifact_id=$1")
            .bind(artifact.id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let input = StartPullRequestPublicationInput {
        corp_id: CORP,
        work_item_id: ITEM,
        actor_id: OWNER,
        actor_role: "owner".into(),
        source_deliverable_id,
        target_repository: "fixture/source".into(),
        base_ref: "main".into(),
        branch: "ecorp/issue148-review-fixture".into(),
        title: "Synthetic publication".into(),
        body: "Closes https://github.com/fixture/source/issues/148\nSQLx metadata only.".into(),
        authorization_id: Uuid::new_v4(),
        authorization_reason: "Publish the exact fixture export".into(),
        effect_key: Uuid::new_v4().to_string(),
        idempotency_key: Uuid::new_v4().to_string(),
        publisher_id: "issue95-store-publisher".into(),
        publisher_credential_hash: publisher_hash,
        lease_seconds: 300,
    };
    let publication = complete_publication(&store, &input, 950).await;
    RevisionFixture {
        store,
        input,
        publication,
        original_review_key,
    }
}

async fn item(store: &PgStore) -> FactoryWorkItem {
    let mut tx = store.pool.begin().await.unwrap();
    let result = factory_work_item_tx(&mut tx, CORP, ITEM, false)
        .await
        .unwrap()
        .unwrap()
        .0;
    tx.rollback().await.unwrap();
    result
}

async fn authorize_input(f: &RevisionFixture) -> AuthorizeFactoryReviewRevision {
    AuthorizeFactoryReviewRevision {
        actor_id: OWNER,
        expected_version: item(&f.store).await.version,
        idempotency_key: Uuid::new_v4(),
        publication_id: f.publication.publication.id,
        published_head_commit: f.publication.publication.commit_sha.clone(),
        observed_source_revision: "revision-1".into(),
        findings: vec![ReviewFinding {
            kind: ReviewFindingKind::Correctness,
            summary: "Correct the fixture's result.md omission within its original write scope"
                .into(),
            source_url: Some("https://github.com/fixture/source/pull/950#discussion_r95".into()),
            path: Some("result.md".into()),
            line: Some(1),
        }],
    }
}

async fn settlement_input(store: &PgStore) -> SettleFactoryReviewRevision {
    SettleFactoryReviewRevision {
        actor_id: OWNER,
        expected_version: item(store).await.version,
        idempotency_key: Uuid::new_v4(),
        observed_source_revision: "revision-1".into(),
        reason: "Explicit synthetic fixture settlement".into(),
    }
}

async fn source_snapshot(store: &PgStore) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object(
        'mission',(SELECT to_jsonb(m) FROM missions m WHERE id=$1),
        'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$2),
        'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM runs r WHERE task_id=$2),
        'exports',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM source_deliverables d WHERE task_id=$2),
        'artifacts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM artifacts a WHERE task_id=$2),
        'publications',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM pull_request_publications p WHERE mission_id=$1))")
        .bind(MISSION).bind(TASK).fetch_one(&store.pool).await.unwrap()
}

fn correction_event(launch: &LaunchRecord, kind: &str, payload: Value) -> RunnerEventInput {
    RunnerEventInput {
        agent_id: launch.agent_id,
        ..event(launch.run_id, launch.assignment_token, kind, payload)
    }
}

async fn verify_correction(
    f: &RevisionFixture,
    revision: &FactoryReviewRevisionResponse,
) -> (LaunchRecord, Uuid) {
    let r = &revision.revision;
    let launch = f
        .store
        .create_task_run(CORP, r.mission_id, r.task_id, Some(OWNER), RUNNER)
        .await
        .unwrap()
        .0;
    assert!(
        f.store
            .review_revision_dispatch(CORP, launch.run_id)
            .await
            .unwrap()
            .is_some()
    );
    let source = crony_domain::SourceVerification {
        base_commit: "a".repeat(40),
        tree: "2".repeat(40),
        candidate_commit: "3".repeat(40),
        ignored_input_sha256: hex::encode(Sha256::digest([])),
        ignored_input_count: 0,
        ignored_input_bytes: 0,
    };
    assert_eq!(launch.verification_policy.checks.len(), 1);
    for (kind, payload) in [
        (
            "run.started",
            json!({"workspace":"isolated-correction-fixture",
            "workspace_branch":"crony/correction-fixture","workspace_base_ref":"main",
            "workspace_base_commit":source.base_commit,"execution_mode":"provider"}),
        ),
        ("run.verification_started", json!({})),
    ] {
        f.store
            .apply_runner_event(correction_event(&launch, kind, payload))
            .await
            .unwrap();
    }
    assert!(
        f.store
            .apply_runner_event(correction_event(
                &launch,
                "run.verification_passed",
                json!({"verification_sha256":"4".repeat(64),"source_verification":source})
            ))
            .await
            .is_err()
    );
    f.store
        .apply_runner_event(correction_event(
            &launch,
            "run.verification_evidence",
            json!({"evidence_id":Uuid::new_v4(),"check_index":0,"kind":"file","status":"passed",
            "summary":"Synthetic correction check","payload":{"source":source}}),
        ))
        .await
        .unwrap();
    let upload = correction_event(&launch, "run.deliverable_upload", json!({}));
    let mut artifact = fixture_artifact(
        &upload,
        b"issue95 synthetic correction export",
        "source_deliverable",
        "ecorp-commit-branch.json",
        "application/vnd.ecorp.deliverable+json",
        json!({"form":"commit_branch","verification_sha256":"4".repeat(64),
            "base_commit":source.base_commit,"head_commit":"5".repeat(40),
            "branch":"crony/correction-fixture","integration_state":"ready_for_review",
            "git_bundle_sha256":hex::encode(Sha256::digest(b"synthetic correction bundle")),
            "publication_ready":true,"verified_tree":source.tree,"source_verification":source}),
    );
    artifact.task_id = r.task_id;
    artifact.producer_agent_id = launch.agent_id;
    f.store
        .prepare_artifact_upload(
            upload,
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
            json!({"summary":"Synthetic persisted correction evidence",
            "verification_sha256":"4".repeat(64),"deliverable_sha256":artifact.sha256,
            "verified_tree":source.tree,"source_verification":source}),
        ),
        (
            "run.verification_waiting",
            json!({"gate":launch.verification_policy.manual_gate,
            "gate_type":"independent_review"}),
        ),
        (
            "run.workspace_preserved",
            json!({"workspace":"isolated-correction-fixture",
            "workspace_branch":"crony/correction-fixture","workspace_base_ref":"main",
            "workspace_base_commit":source.base_commit,"workspace_fingerprint":"6".repeat(64),
            "head_commit":"5".repeat(40),"workspace_quarantined":false,
            "detail":"Synthetic correction workspace preservation"}),
        ),
    ] {
        f.store
            .apply_runner_event(correction_event(&launch, kind, payload))
            .await
            .unwrap();
    }
    let deliverable = sqlx::query_scalar(
        "SELECT id FROM source_deliverables WHERE corp_id=$1 AND artifact_id=$2",
    )
    .bind(CORP)
    .bind(artifact.id)
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    (launch, deliverable)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue95_fresh_review_adoption_and_superseding_publication_preserve_history(pool: PgPool) {
    let f = revision_fixture(pool).await;
    let before = source_snapshot(&f.store).await;
    let authorizer = Uuid::new_v4();
    sqlx::query("INSERT INTO actors(id,corp_id,kind,role,name) VALUES($1,$2,'human','owner','Synthetic correction authorizer')")
        .bind(authorizer).bind(CORP).execute(&f.store.pool).await.unwrap();
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(ROOM)
        .bind(authorizer)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let mut input = authorize_input(&f).await;
    input.actor_id = authorizer;
    let revision = f
        .store
        .authorize_factory_review_revision(CORP, ITEM, input)
        .await
        .unwrap();
    let r = &revision.revision;
    for mission in [MISSION, r.mission_id] {
        let context = f
            .store
            .mission_context(CORP, OWNER, mission)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(context.mission_id, mission);
        assert!(
            matches!(context.origin, crony_domain::MissionOrigin::Factory {work_item_id, ..} if work_item_id == ITEM)
        );
    }
    let pending = f
        .store
        .factory_publication_context(CORP, OWNER, ITEM)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.publication_history.len(), 1);
    assert_eq!(pending.review_revisions.len(), 1);
    assert_eq!(pending.review_revisions[0].state, "pending");
    assert_eq!(pending.publication.unwrap().mission_id, MISSION);
    let (launch, deliverable) = verify_correction(&f, &revision).await;
    assert_eq!(item(&f.store).await.mission_id, Some(MISSION));
    assert!(
        f.store
            .settle_factory_review_revision(
                CORP,
                ITEM,
                r.id,
                settlement_input(&f.store).await,
                true
            )
            .await
            .is_err()
    );
    let producer: Uuid = sqlx::query_scalar("SELECT actor_id FROM agents WHERE id=$1")
        .bind(launch.agent_id)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    for (actor, key) in [
        (OWNER, Some(Uuid::new_v4())),
        (authorizer, Some(Uuid::new_v4())),
        (producer, Some(Uuid::new_v4())),
        (REVIEWER, None),
        (REVIEWER, Some(Uuid::nil())),
        (REVIEWER, Some(f.original_review_key)),
    ] {
        assert!(
            f.store
                .decide_verification(
                    CORP,
                    launch.run_id,
                    actor,
                    true,
                    "Synthetic review refusal probe",
                    key
                )
                .await
                .is_err()
        );
    }
    let review_key = Uuid::new_v4();
    f.store
        .decide_verification(
            CORP,
            launch.run_id,
            REVIEWER,
            true,
            "Synthetic new independent review",
            Some(review_key),
        )
        .await
        .unwrap();
    let settlement = settlement_input(&f.store).await;
    let (a, b) = tokio::join!(
        f.store
            .settle_factory_review_revision(CORP, ITEM, r.id, settlement.clone(), true),
        f.store
            .settle_factory_review_revision(CORP, ITEM, r.id, settlement.clone(), true)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(a.revision.result_deliverable_id, Some(deliverable));
    assert_eq!(a.revision.result_run_id, Some(launch.run_id));
    assert_eq!(a.revision.review_decision_id, Some(review_key));
    assert_eq!(a.work_item.mission_id, Some(r.mission_id));
    let context = f
        .store
        .factory_publication_context(CORP, OWNER, ITEM)
        .await
        .unwrap()
        .unwrap();
    assert!(context.publication.is_none());
    assert_eq!(context.publication_history.len(), 1);
    assert_eq!(context.review_revisions[0].state, "adopted");
    assert!(
        context
            .source_deliverables
            .iter()
            .any(|d| d.id == deliverable && d.run_id == launch.run_id)
    );
    let mut successor = f.input.clone();
    successor.source_deliverable_id = deliverable;
    successor.idempotency_key = Uuid::new_v4().to_string();
    successor.effect_key = Uuid::new_v4().to_string();
    successor.authorization_id = Uuid::new_v4();
    successor.body = format!(
        "{}\nSupersedes https://github.com/fixture/source/pull/950",
        successor.body
    );
    assert!(
        f.store
            .start_pull_request_publication(successor.clone())
            .await
            .is_err(),
        "cannot overwrite the predecessor branch"
    );
    successor.branch = crony_domain::review_revision_branch("ecorp/", 148, r.id);
    let published = complete_publication(&f.store, &successor, 951).await;
    assert_eq!(
        published.publication.supersedes_publication_id,
        Some(f.publication.publication.id)
    );
    assert_eq!(published.publication.commit_sha, "5".repeat(40));
    assert_eq!(
        published.publication.provenance["review_revision"]["review_decision_id"],
        json!(review_key)
    );
    let replay = f
        .store
        .start_pull_request_publication(successor)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.publication.id, published.publication.id);
    let context = f
        .store
        .factory_publication_context(CORP, OWNER, ITEM)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(context.publication_history.len(), 2);
    assert_eq!(context.publication.unwrap().id, published.publication.id);
    assert_eq!(source_snapshot(&f.store).await, before);
    assert!(
        f.store
            .mission_context(CORP, OWNER, MISSION)
            .await
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue95_admission_replay_keeps_exact_source_and_residual_authority(pool: PgPool) {
    let f = revision_fixture(pool).await;
    let before = source_snapshot(&f.store).await;
    let input = authorize_input(&f).await;
    let revision = f
        .store
        .authorize_factory_review_revision(CORP, ITEM, input.clone())
        .await
        .unwrap();
    let r = &revision.revision;
    assert_eq!(
        revision.work_item.state,
        FactoryWorkItemState::ReviewRevision
    );
    assert_eq!(revision.work_item.mission_id, Some(MISSION));
    assert_eq!(r.source_deliverable_id, f.input.source_deliverable_id);
    assert_eq!(r.source_run_id, f.publication.publication.run_id);
    assert_eq!(r.authorized_by, OWNER);
    assert_eq!(r.findings, input.findings);
    assert_ne!(r.mission_id, MISSION);
    let row = sqlx::query(
        "SELECT t.contract,t.verification_policy,t.max_attempts,m.requested_by,m.budget_tokens
        FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE t.id=$1",
    )
    .bind(r.task_id)
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    let mut expected: TaskContract =
        serde_json::from_value(before["task"]["contract"].clone()).unwrap();
    expected.budget_tokens = 3_940;
    expected.objective = format!(
        "{}\n\nCorrect the authenticated review findings for published commit {}:\n{}",
        expected.objective,
        r.source_head_commit,
        serde_json::to_string(&input.findings).unwrap()
    );
    assert_eq!(row.get::<Value, _>("contract"), json!(expected));
    assert_eq!(row.get::<i32, _>("max_attempts"), 2);
    assert_eq!(row.get::<i64, _>("budget_tokens"), 3_940);
    assert_eq!(row.get::<Uuid, _>("requested_by"), OWNER);
    let original_policy: VerificationPolicy =
        serde_json::from_value(before["task"]["verification_policy"].clone()).unwrap();
    assert_eq!(
        row.get::<Value, _>("verification_policy"),
        json!(crony_domain::base_refresh_policy(&original_policy))
    );
    let replay = f
        .store
        .authorize_factory_review_revision(CORP, ITEM, input.clone())
        .await
        .unwrap();
    assert!(replay.replayed && replay.events.is_empty());
    assert_eq!(replay.revision.id, r.id);
    let mut changed = input.clone();
    changed.findings[0].summary.push_str(" changed");
    assert!(
        f.store
            .authorize_factory_review_revision(CORP, ITEM, changed)
            .await
            .is_err()
    );
    let mut duplicate = input;
    duplicate.idempotency_key = Uuid::new_v4();
    duplicate.expected_version = revision.work_item.version;
    assert!(
        f.store
            .authorize_factory_review_revision(CORP, ITEM, duplicate)
            .await
            .is_err()
    );
    assert_eq!(source_snapshot(&f.store).await, before);
    assert!(
        f.store
            .schedulable_tasks(CORP, r.mission_id, false)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        f.store
            .create_task_run(CORP, r.mission_id, r.task_id, None, RUNNER)
            .await
            .is_err()
    );
    let launch = f
        .store
        .create_task_run(CORP, r.mission_id, r.task_id, Some(OWNER), RUNNER)
        .await
        .unwrap()
        .0;
    let grant = f
        .store
        .review_revision_dispatch(CORP, launch.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(grant.source.source_head_commit, r.source_head_commit);
    assert_eq!(grant.source.source_run_id, r.source_run_id);
    assert_eq!(grant.artifact.run_id, r.source_run_id);
    assert!(grant.expected_head_commit.is_none());
    assert_eq!(source_snapshot(&f.store).await, before);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue95_exhausted_completed_authority_cannot_be_replenished(pool: PgPool) {
    let exhausted = corrected_publication_fixture(pool).await;
    let publication = complete_publication(&exhausted.store, &exhausted.input, 950).await;
    let f = RevisionFixture {
        store: exhausted.store,
        input: exhausted.input,
        publication,
        original_review_key: Uuid::nil(),
    };
    let before = source_snapshot(&f.store).await;
    let error = f
        .store
        .authorize_factory_review_revision(CORP, ITEM, authorize_input(&f).await)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("remaining correction budget or attempts"),
        "{error:#}"
    );
    assert_eq!(source_snapshot(&f.store).await, before);
    assert_eq!(item(&f.store).await.state, FactoryWorkItemState::Published);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue95_concurrent_admission_allocates_one_mission_and_abandonment_is_terminal(
    pool: PgPool,
) {
    let f = revision_fixture(pool).await;
    let original = source_snapshot(&f.store).await;
    let input = authorize_input(&f).await;
    let (a, b) = tokio::join!(
        f.store
            .authorize_factory_review_revision(CORP, ITEM, input.clone()),
        f.store.authorize_factory_review_revision(CORP, ITEM, input)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.revision.id, b.revision.id);
    assert_ne!(a.replayed, b.replayed);
    let settlement = settlement_input(&f.store).await;
    let abandoned = f
        .store
        .settle_factory_review_revision(CORP, ITEM, a.revision.id, settlement.clone(), false)
        .await
        .unwrap();
    assert_eq!(abandoned.revision.state, "abandoned");
    assert_eq!(abandoned.work_item.state, FactoryWorkItemState::Published);
    let replay = f
        .store
        .settle_factory_review_revision(CORP, ITEM, a.revision.id, settlement.clone(), false)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert!(
        f.store
            .settle_factory_review_revision(CORP, ITEM, a.revision.id, settlement, true)
            .await
            .is_err()
    );
    assert!(
        f.store
            .create_task_run(
                CORP,
                a.revision.mission_id,
                a.revision.task_id,
                Some(OWNER),
                RUNNER
            )
            .await
            .is_err()
    );
    assert_eq!(source_snapshot(&f.store).await, original);
    assert!(
        f.store
            .authorize_factory_review_revision(CORP, ITEM, authorize_input(&f).await)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue95_role_room_revocation_and_foreign_scope_fence_replays_and_dispatch(pool: PgPool) {
    let f = revision_fixture(pool).await;
    let input = authorize_input(&f).await;
    let revision = f
        .store
        .authorize_factory_review_revision(CORP, ITEM, input.clone())
        .await
        .unwrap();
    let r = &revision.revision;
    let run = f
        .store
        .create_task_run(CORP, r.mission_id, r.task_id, Some(OWNER), RUNNER)
        .await
        .unwrap()
        .0;
    let before = source_snapshot(&f.store).await;
    for role in ["viewer", "worker"] {
        sqlx::query("UPDATE actors SET role=$1 WHERE id=$2")
            .bind(role)
            .bind(OWNER)
            .execute(&f.store.pool)
            .await
            .unwrap();
        assert!(
            f.store
                .authorize_factory_review_revision(CORP, ITEM, input.clone())
                .await
                .is_err()
        );
        assert!(
            f.store
                .review_revision_dispatch(CORP, run.run_id)
                .await
                .is_err()
        );
        assert!(
            f.store
                .factory_publication_context(CORP, OWNER, ITEM)
                .await
                .unwrap()
                .is_none()
        );
    }
    sqlx::query("UPDATE actors SET role='owner' WHERE id=$1")
        .bind(OWNER)
        .execute(&f.store.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(ROOM)
        .bind(OWNER)
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(
        f.store
            .authorize_factory_review_revision(CORP, ITEM, input)
            .await
            .is_err()
    );
    assert!(
        f.store
            .review_revision_dispatch(CORP, run.run_id)
            .await
            .is_err()
    );
    assert!(
        f.store
            .factory_publication_context(CORP, OWNER, ITEM)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        f.store
            .mission_context(CORP, OWNER, r.mission_id)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(ROOM)
        .bind(OWNER)
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(
        f.store
            .review_revision_dispatch(Uuid::new_v4(), run.run_id)
            .await
            .is_err()
    );
    assert!(
        f.store
            .factory_publication_context(Uuid::new_v4(), OWNER, ITEM)
            .await
            .is_err()
    );
    assert!(
        f.store
            .review_revision_dispatch(CORP, run.run_id)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(source_snapshot(&f.store).await, before);
}
