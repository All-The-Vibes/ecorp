//! Actual-store recovery and capability tests in SQLx-owned databases. The
//! existing fixture establishes real publication authority and a durable branch;
//! a synthetic Prepared journal models the crash boundary. These tests do not
//! attest native GitHub execution or the forward active-checkpoint adoption path.
use super::*;
use crony_domain::{
    PublicationEvidenceComment, PublicationEvidenceKind, PublicationPullRequestSnapshot,
    PublicationReadiness, PublicationReadinessAction as Action, PublicationReadinessRequest,
    PublicationReadinessState as ReadinessState, PublicationReadinessUndo,
    publication_evidence_body,
};

struct Fixture {
    store: PgStore,
    start: StartPullRequestPublicationInput,
    branch: RecordPullRequestPublicationCheckpointInput,
    renewal: RenewPullRequestPublicationInput,
    prepare: PublicationReadinessInput,
    forward_token: Uuid,
    intent: PublicationReadiness,
}

impl Fixture {
    async fn current(&self) -> PullRequestPublication {
        self.store
            .pull_request_publication_for_work_item(CORP, OWNER, ITEM)
            .await
            .unwrap()
            .unwrap()
    }

    fn request(&self, action: Action) -> PublicationReadinessInput {
        PublicationReadinessInput {
            corp_id: CORP,
            publication_id: self.branch.publication_id,
            publisher_id: self.start.publisher_id.clone(),
            publisher_credential_hash: self.start.publisher_credential_hash.clone(),
            request: PublicationReadinessRequest {
                actor_id: OWNER,
                intent_id: self.intent.intent_id,
                action,
            },
        }
    }

    async fn apply(&self, action: Action) -> PublicationReadinessOutcome {
        self.store
            .mutate_publication_readiness(self.request(action))
            .await
            .unwrap()
    }

    async fn recover(&self, forward: Option<Uuid>) -> PublicationReadinessOutcome {
        self.apply(Action::Recover {
            publisher_token: forward,
            expected_version: self.current().await.version,
            acquisition_id: Uuid::new_v4(),
        })
        .await
    }

    async fn observe(
        &self,
        token: Uuid,
        pr: PublicationPullRequestSnapshot,
    ) -> PublicationReadinessOutcome {
        self.apply(Action::DraftObserved {
            recovery_token: token,
            expected_version: self.current().await.version,
            pull_request: pr,
        })
        .await
    }

    async fn rejected(&self, input: PublicationReadinessInput) {
        let before = publication_state(&self.store).await;
        assert!(
            self.store
                .mutate_publication_readiness(input)
                .await
                .is_err()
        );
        assert_eq!(
            publication_state(&self.store).await,
            before,
            "rejection must roll back all changes"
        );
    }
}

fn journal(publication: &PullRequestPublication) -> PublicationReadiness {
    serde_json::from_value(publication.provenance["active_checkpoint_readiness"].clone()).unwrap()
}

async fn fixture(pool: PgPool) -> Fixture {
    let (store, _, _, start) = publication_fixture(pool).await;
    let started = store
        .start_pull_request_publication(start.clone())
        .await
        .unwrap();
    let forward_token = started.publisher_token.unwrap();
    let branch = RecordPullRequestPublicationCheckpointInput {
        corp_id: CORP,
        publication_id: started.publication.id,
        actor_id: OWNER,
        publisher_id: start.publisher_id.clone(),
        publisher_credential_hash: start.publisher_credential_hash.clone(),
        publisher_token: forward_token,
        expected_version: started.publication.version,
        idempotency_key: Uuid::new_v4().to_string(),
        checkpoint: PullRequestPublicationCheckpointInput::BranchPushed {
            commit_sha: started.publication.commit_sha.clone(),
        },
    };
    let pushed = store
        .record_pull_request_publication_checkpoint(branch.clone())
        .await
        .unwrap();
    let renewal = publication_renewal(&start, &pushed);
    let renewed = store
        .renew_pull_request_publication(renewal.clone())
        .await
        .unwrap();
    let publication = &renewed.publication;
    let pr = PublicationPullRequestSnapshot {
        number: 72,
        node_id: "PR_readiness_fixture72".into(),
        url: "https://github.com/fixture/source/pull/72".into(),
        state: "OPEN".into(),
        draft: true,
        title: "Retained shared title".into(),
        body: "Retained collaborator notes\r\nRésumé 🚀\n".into(),
        head_ref: publication.branch.clone(),
        base_ref: publication.base_ref.clone(),
        head_sha: publication.commit_sha.clone(),
        head_repository_owner: "fixture".into(),
        is_cross_repository: false,
        auto_merge: false,
    };
    let evidence_comment = PublicationEvidenceComment {
        id: 72001,
        node_id: "IC_readiness_fixture72001".into(),
        url: format!("{}#issuecomment-72001", pr.url),
        author_id: 72,
        author_login: "fixture-publisher".into(),
        body: publication_evidence_body(
            PublicationEvidenceKind::Final,
            publication.id,
            &publication.target_repository,
            &publication.commit_sha,
            &publication.title,
            &publication.body,
        ),
    };
    let intent = PublicationReadiness {
        intent_id: Uuid::new_v4(),
        actor_id: OWNER,
        publisher_id: start.publisher_id.clone(),
        state: ReadinessState::Prepared,
        pull_request: pr.clone(),
        evidence_comment: evidence_comment.clone(),
        ready_succeeded: false,
        undo: vec![],
        recovery: None,
        draft_observed: None,
        created_at: Utc::now(),
    };
    let prepare = PublicationReadinessInput {
        corp_id: CORP,
        publication_id: publication.id,
        publisher_id: start.publisher_id.clone(),
        publisher_credential_hash: start.publisher_credential_hash.clone(),
        request: PublicationReadinessRequest {
            actor_id: OWNER,
            intent_id: intent.intent_id,
            action: Action::Prepare {
                publisher_token: forward_token,
                expected_version: publication.version,
                pull_request: pr,
                evidence_comment,
            },
        },
    };
    let mut request_action = serde_json::to_value(&prepare.request.action).unwrap();
    request_action
        .as_object_mut()
        .unwrap()
        .remove("publisher_token");
    let request = json!({"publication_id":publication.id, "publisher_id":start.publisher_id,
        "intent_id":intent.intent_id, "action":request_action});
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("UPDATE pull_request_publications SET provenance=jsonb_set(provenance,'{active_checkpoint_readiness}',$2),version=version+1 WHERE id=$1")
        .bind(publication.id).bind(serde_json::to_value(&intent).unwrap()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO pull_request_publication_operations(corp_id,idempotency_key,publication_id,actor_id,operation,resulting_version,publisher_token,request) VALUES($1,$2,$3,$4,'checkpoint_readiness',$5,$6,$7)")
        .bind(CORP).bind(format!("active-readiness:{}:{}:prepare", publication.id, intent.intent_id))
        .bind(publication.id).bind(OWNER).bind(publication.version + 1).bind(forward_token).bind(request)
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    Fixture {
        store,
        start,
        branch,
        renewal,
        prepare,
        forward_token,
        intent,
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_recovery_after_demotion_preserves_models_and_changed_pr_text(pool: PgPool) {
    let fixture = fixture(pool).await;
    let before = publication_state(&fixture.store).await;
    sqlx::query("UPDATE actors SET role='member' WHERE id=$1")
        .bind(OWNER)
        .execute(&fixture.store.pool)
        .await
        .unwrap();
    fixture
        .apply(Action::ReadySucceeded {
            publisher_token: fixture.forward_token,
        })
        .await;
    let acquired = fixture.recover(Some(fixture.forward_token)).await;
    let token = acquired.recovery_token.unwrap();
    assert_ne!(token, fixture.forward_token);
    assert!(acquired.publication.publisher_id.is_none());
    assert!(acquired.publication.publisher_lease_expires_at.is_none());
    let dispatch = Uuid::new_v4();
    let prepared = fixture
        .apply(Action::UndoPrepared {
            recovery_token: token,
            expected_version: acquired.publication.version,
            dispatch_id: dispatch,
        })
        .await;
    assert_eq!(journal(&prepared.publication).undo.len(), 1);
    fixture
        .apply(Action::UndoSucceeded {
            recovery_token: token,
            dispatch_id: dispatch,
        })
        .await;
    let mut changed = fixture.intent.pull_request.clone();
    changed.head_sha = "f".repeat(40);
    changed.body = "Collaborator's latest text\r\n".into();
    changed.base_ref = "release".into();
    let observed = fixture.observe(token, changed.clone()).await;
    assert_eq!(
        journal(&observed.publication).state,
        ReadinessState::Compensated
    );
    assert_eq!(journal(&observed.publication).draft_observed, Some(changed));
    let public = serde_json::to_string(&observed.publication.provenance).unwrap();
    assert!(!public.contains(&token.to_string()));
    assert!(!public.contains(&fixture.forward_token.to_string()));
    let mut retry = fixture.start.clone();
    retry.idempotency_key = Uuid::new_v4().to_string();
    assert!(
        fixture
            .store
            .start_pull_request_publication(retry)
            .await
            .is_err(),
        "compensation cannot restore a demoted actor's publish permission"
    );
    assert_publication_preserves_models(&before, &publication_state(&fixture.store).await);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_unknown_ready_remains_blocked_until_original_dispatch_acknowledgement(
    pool: PgPool,
) {
    let fixture = fixture(pool).await;
    let acquired = fixture.recover(Some(fixture.forward_token)).await;
    let first = fixture
        .observe(
            acquired.recovery_token.unwrap(),
            fixture.intent.pull_request.clone(),
        )
        .await;
    let pending = journal(&first.publication);
    assert!(pending.pending());
    assert!(!pending.ready_succeeded);
    assert!(pending.draft_observed.is_some());
    let mut retry = fixture.start.clone();
    retry.idempotency_key = Uuid::new_v4().to_string();
    assert!(
        fixture
            .store
            .start_pull_request_publication(retry)
            .await
            .is_err()
    );
    fixture
        .rejected(fixture.request(Action::ReadySucceeded {
            publisher_token: Uuid::new_v4(),
        }))
        .await;
    // The original command may report successful completion after its forward
    // lease was abandoned. This record-only acknowledgement grants no capability.
    let acknowledged = fixture
        .apply(Action::ReadySucceeded {
            publisher_token: fixture.forward_token,
        })
        .await;
    assert!(acknowledged.recovery_token.is_none());
    assert!(journal(&acknowledged.publication).pending());
    assert!(acknowledged.publication.publisher_id.is_none());
    let recovery = fixture.recover(None).await;
    let token = recovery.recovery_token.unwrap();
    let dispatch = Uuid::new_v4();
    fixture
        .apply(Action::UndoPrepared {
            recovery_token: token,
            expected_version: recovery.publication.version,
            dispatch_id: dispatch,
        })
        .await;
    fixture
        .apply(Action::UndoSucceeded {
            recovery_token: token,
            dispatch_id: dispatch,
        })
        .await;
    let settled = fixture
        .observe(token, fixture.intent.pull_request.clone())
        .await;
    assert_eq!(
        journal(&settled.publication).state,
        ReadinessState::Compensated
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_unknown_undo_and_late_ack_require_a_fresh_draft_observation(pool: PgPool) {
    let fixture = fixture(pool).await;
    fixture
        .apply(Action::ReadySucceeded {
            publisher_token: fixture.forward_token,
        })
        .await;
    let recovery = fixture.recover(Some(fixture.forward_token)).await;
    let token = recovery.recovery_token.unwrap();
    let dispatch = Uuid::new_v4();
    fixture
        .apply(Action::UndoPrepared {
            recovery_token: token,
            expected_version: recovery.publication.version,
            dispatch_id: dispatch,
        })
        .await;
    let observed = fixture
        .observe(token, fixture.intent.pull_request.clone())
        .await;
    assert!(
        journal(&observed.publication).pending(),
        "an observed draft does not acknowledge an in-flight undo"
    );
    fixture
        .rejected(fixture.request(Action::UndoSucceeded {
            recovery_token: Uuid::new_v4(),
            dispatch_id: dispatch,
        }))
        .await;
    let newer = fixture.recover(None).await;
    let newer_token = newer.recovery_token.unwrap();
    let version_before_ack = newer.publication.version;
    fixture
        .apply(Action::UndoSucceeded {
            recovery_token: token,
            dispatch_id: dispatch,
        })
        .await;
    fixture
        .rejected(fixture.request(Action::DraftObserved {
            recovery_token: newer_token,
            expected_version: version_before_ack,
            pull_request: fixture.intent.pull_request.clone(),
        }))
        .await;
    let settled = fixture
        .observe(newer_token, fixture.intent.pull_request.clone())
        .await;
    assert_eq!(
        journal(&settled.publication).state,
        ReadinessState::Compensated
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_concurrent_recovery_grants_one_live_compensation_capability(pool: PgPool) {
    let fixture = fixture(pool).await;
    let version = fixture.current().await.version;
    let requests: Vec<_> = (0..2)
        .map(|_| {
            fixture.request(Action::Recover {
                publisher_token: Some(fixture.forward_token),
                expected_version: version,
                acquisition_id: Uuid::new_v4(),
            })
        })
        .collect();
    let (left, right) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            fixture
                .store
                .mutate_publication_readiness(requests[0].clone()),
            fixture
                .store
                .mutate_publication_readiness(requests[1].clone())
        )
    })
    .await
    .expect("concurrent compensation must not deadlock");
    let results = [left, right];
    let winners: Vec<_> = results
        .iter()
        .enumerate()
        .filter(|(_, result)| {
            result
                .as_ref()
                .is_ok_and(|outcome| outcome.recovery_token.is_some())
        })
        .collect();
    assert_eq!(winners.len(), 1);
    let (index, winner) = winners[0];
    let token = winner.as_ref().unwrap().recovery_token;
    let replay = fixture
        .store
        .mutate_publication_readiness(requests[index].clone())
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.recovery_token, token);
    let busy = fixture.recover(None).await;
    assert!(busy.busy);
    assert!(busy.recovery_token.is_none());
    // SQLx metadata fixture only: model an elapsed recovery lease. Browser
    // acceptance separately waits for actual clocks and native process restart.
    sqlx::query("UPDATE pull_request_publications SET provenance=jsonb_set(provenance,'{active_checkpoint_readiness,recovery,expires_at}',to_jsonb(now()-interval '1 second')) WHERE id=$1")
        .bind(fixture.branch.publication_id).execute(&fixture.store.pool).await.unwrap();
    let expired = fixture
        .store
        .mutate_publication_readiness(requests[index].clone())
        .await
        .unwrap();
    assert!(expired.busy);
    assert!(expired.recovery_token.is_none());
    let renewed = fixture.recover(None).await;
    assert_ne!(renewed.recovery_token, token);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_recovery_keeps_actor_corp_room_and_publisher_credential_scope(pool: PgPool) {
    let fixture = fixture(pool).await;
    let request = fixture.request(Action::Recover {
        publisher_token: Some(fixture.forward_token),
        expected_version: fixture.current().await.version,
        acquisition_id: Uuid::new_v4(),
    });
    for variant in 0..5 {
        let mut bad = request.clone();
        match variant {
            0 => bad.corp_id = Uuid::new_v4(),
            1 => bad.request.actor_id = REVIEWER,
            2 => bad.publisher_id = "another-publisher".into(),
            3 => bad.publisher_credential_hash = "f".repeat(64),
            _ => bad.request.intent_id = Uuid::new_v4(),
        }
        fixture.rejected(bad).await;
    }
    sqlx::query("UPDATE publication_publisher_credentials SET revoked_at=now() WHERE corp_id=$1 AND publisher_id=$2")
        .bind(CORP).bind(&fixture.start.publisher_id).execute(&fixture.store.pool).await.unwrap();
    fixture.rejected(request.clone()).await;
    sqlx::query("UPDATE publication_publisher_credentials SET revoked_at=NULL WHERE corp_id=$1 AND publisher_id=$2")
        .bind(CORP).bind(&fixture.start.publisher_id).execute(&fixture.store.pool).await.unwrap();
    sqlx::query("DELETE FROM room_memberships WHERE actor_id=$1")
        .bind(OWNER)
        .execute(&fixture.store.pool)
        .await
        .unwrap();
    fixture.rejected(request).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_pending_and_compensation_tokens_cannot_replay_forward_authority(pool: PgPool) {
    let fixture = fixture(pool).await;
    let start = fixture
        .store
        .start_pull_request_publication(fixture.start.clone())
        .await
        .unwrap();
    assert!(start.replayed);
    assert!(start.publisher_token.is_none());
    let branch = fixture
        .store
        .record_pull_request_publication_checkpoint(fixture.branch.clone())
        .await
        .unwrap();
    assert!(branch.replayed);
    assert!(branch.publisher_token.is_none());
    assert!(
        fixture
            .store
            .renew_pull_request_publication(fixture.renewal.clone())
            .await
            .is_err()
    );
    let prepare = fixture
        .store
        .mutate_publication_readiness(fixture.prepare.clone())
        .await
        .unwrap();
    assert!(prepare.replayed);
    assert!(prepare.recovery_token.is_none());
    fixture
        .apply(Action::ReadySucceeded {
            publisher_token: fixture.forward_token,
        })
        .await;
    let recovery = fixture.recover(Some(fixture.forward_token)).await;
    let token = recovery.recovery_token.unwrap();
    let mut renewal = fixture.renewal.clone();
    renewal.publisher_token = token;
    renewal.expected_version = recovery.publication.version;
    renewal.idempotency_key = Uuid::new_v4().to_string();
    assert!(
        fixture
            .store
            .renew_pull_request_publication(renewal)
            .await
            .is_err()
    );
    let mut checkpoint = fixture.branch.clone();
    checkpoint.publisher_token = token;
    checkpoint.expected_version = recovery.publication.version;
    checkpoint.idempotency_key = Uuid::new_v4().to_string();
    checkpoint.checkpoint = PullRequestPublicationCheckpointInput::Failed {
        failure_detail: "Synthetic invalid compensation-token replay".into(),
    };
    assert!(
        fixture
            .store
            .record_pull_request_publication_checkpoint(checkpoint)
            .await
            .is_err()
    );
    let mut forwarded = fixture.prepare.clone();
    forwarded.request.intent_id = Uuid::new_v4();
    if let Action::Prepare {
        publisher_token,
        expected_version,
        ..
    } = &mut forwarded.request.action
    {
        *publisher_token = token;
        *expected_version = recovery.publication.version;
    }
    fixture.rejected(forwarded).await;
    let settled = fixture
        .observe(token, fixture.intent.pull_request.clone())
        .await;
    assert_eq!(
        journal(&settled.publication).state,
        ReadinessState::Compensated
    );
    let mut retry = fixture.start.clone();
    retry.idempotency_key = Uuid::new_v4().to_string();
    let resumed = fixture
        .store
        .start_pull_request_publication(retry)
        .await
        .unwrap();
    assert!(resumed.publisher_token.is_some());
    assert_ne!(resumed.publisher_token, Some(token));
    assert_ne!(resumed.publisher_token, Some(fixture.forward_token));
    assert!(
        fixture
            .store
            .start_pull_request_publication(fixture.start.clone())
            .await
            .unwrap()
            .publisher_token
            .is_none()
    );
    assert!(
        fixture
            .store
            .record_pull_request_publication_checkpoint(fixture.branch.clone())
            .await
            .unwrap()
            .publisher_token
            .is_none()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn readiness_undo_is_bounded_and_cannot_target_another_or_accepted_pr(pool: PgPool) {
    let fixture = fixture(pool).await;
    fixture
        .apply(Action::ReadySucceeded {
            publisher_token: fixture.forward_token,
        })
        .await;
    let recovery = fixture.recover(Some(fixture.forward_token)).await;
    let token = recovery.recovery_token.unwrap();
    for change in ["number", "node_id", "url", "state", "draft"] {
        let mut pr = fixture.intent.pull_request.clone();
        match change {
            "number" => pr.number += 1,
            "node_id" => pr.node_id.push_str("-other"),
            "url" => pr.url.push_str("-other"),
            "state" => pr.state = "CLOSED".into(),
            _ => pr.draft = false,
        }
        fixture
            .rejected(fixture.request(Action::DraftObserved {
                recovery_token: token,
                expected_version: recovery.publication.version,
                pull_request: pr,
            }))
            .await;
    }
    let mut bounded = journal(&recovery.publication);
    bounded.undo = (0..32)
        .map(|_| PublicationReadinessUndo {
            dispatch_id: Uuid::new_v4(),
            acquisition_id: Uuid::new_v4(),
            succeeded: true,
        })
        .collect();
    sqlx::query("UPDATE pull_request_publications SET provenance=jsonb_set(provenance,'{active_checkpoint_readiness}',$2) WHERE id=$1")
        .bind(recovery.publication.id).bind(serde_json::to_value(&bounded).unwrap())
        .execute(&fixture.store.pool).await.unwrap();
    fixture
        .rejected(fixture.request(Action::UndoPrepared {
            recovery_token: token,
            expected_version: recovery.publication.version,
            dispatch_id: Uuid::new_v4(),
        }))
        .await;
    // Model an already accepted journal; this boundary test proves recovery
    // cannot grant undo authority. Genuine forward acceptance is a browser case.
    bounded.state = ReadinessState::Accepted;
    bounded.undo.clear();
    bounded.recovery = None;
    sqlx::query("UPDATE pull_request_publications SET provenance=jsonb_set(provenance,'{active_checkpoint_readiness}',$2) WHERE id=$1")
        .bind(recovery.publication.id).bind(serde_json::to_value(&bounded).unwrap())
        .execute(&fixture.store.pool).await.unwrap();
    let accepted = fixture.recover(None).await;
    assert!(accepted.replayed);
    assert!(!accepted.busy);
    assert!(accepted.recovery_token.is_none());
    fixture
        .rejected(fixture.request(Action::UndoPrepared {
            recovery_token: token,
            expected_version: accepted.publication.version,
            dispatch_id: Uuid::new_v4(),
        }))
        .await;
}
