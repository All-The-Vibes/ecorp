//! The existing publication ledger also owns compensation for native PR ready.
//! It grants no new publish, merge, deploy or repository-edit authority.

use super::*;
use crony_domain::{
    PublicationEvidenceKind, PublicationPullRequestSnapshot, PublicationReadiness,
    PublicationReadinessAction as Action, PublicationReadinessRecovery, PublicationReadinessState,
    PublicationReadinessUndo, publication_evidence_body,
};

const KEY: &str = "active_checkpoint_readiness";
const OPERATION: &str = "checkpoint_readiness";
const RECOVERY_SECONDS: i64 = 120;
const MAX_UNDO_DISPATCHES: usize = 32;

pub(super) fn journal(
    publication: &PullRequestPublication,
) -> Result<Option<PublicationReadiness>> {
    publication
        .provenance
        .get(KEY)
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value(value.clone()).context("invalid readiness journal"))
        .transpose()
}

pub(super) fn ensure_settled(publication: &PullRequestPublication) -> Result<()> {
    if journal(publication)?.is_some_and(|journal| journal.pending()) {
        return Err(anyhow!(
            "conflict: native readiness needs draft reconciliation before forward publication"
        ));
    }
    Ok(())
}

fn operation_key(publication: Uuid, intent: Uuid, suffix: &str) -> String {
    format!("active-readiness:{publication}:{intent}:{suffix}")
}

fn action_key(publication: Uuid, intent: Uuid, action: &Action) -> String {
    let suffix = match action {
        Action::Prepare { .. } => "prepare".to_owned(),
        Action::ReadySucceeded { .. } => "ready-succeeded".to_owned(),
        Action::Recover { acquisition_id, .. } => format!("recover:{acquisition_id}"),
        Action::UndoPrepared { dispatch_id, .. } => format!("undo:{dispatch_id}"),
        Action::UndoSucceeded { dispatch_id, .. } => format!("undo-succeeded:{dispatch_id}"),
        Action::DraftObserved {
            expected_version, ..
        } => format!("draft:{expected_version}"),
    };
    operation_key(publication, intent, &suffix)
}

fn presented_token(action: &Action) -> Option<Uuid> {
    match action {
        Action::Prepare {
            publisher_token, ..
        }
        | Action::ReadySucceeded { publisher_token } => Some(*publisher_token),
        Action::UndoPrepared { recovery_token, .. }
        | Action::UndoSucceeded { recovery_token, .. }
        | Action::DraftObserved { recovery_token, .. } => Some(*recovery_token),
        // A recovery acquisition stores the new compensation capability, not
        // the caller's expiring forward token.
        Action::Recover { .. } => None,
    }
}

fn operation_request(input: &PublicationReadinessInput) -> Result<Value> {
    let mut action = serde_json::to_value(&input.request.action)?;
    let object = action.as_object_mut().context("invalid readiness action")?;
    object.remove("publisher_token");
    object.remove("recovery_token");
    Ok(json!({
        "publication_id": input.publication_id,
        "publisher_id": input.publisher_id,
        "intent_id": input.request.intent_id,
        "action": action,
    }))
}

fn require_version(publication: &PullRequestPublication, expected: i64) -> Result<()> {
    if expected <= 0 || publication.version != expected {
        return Err(anyhow!("conflict: readiness publication version changed"));
    }
    Ok(())
}

async fn require_human_scope(
    tx: &mut Transaction<'_, Postgres>,
    publication: &PullRequestPublication,
    actor: Uuid,
) -> Result<()> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM actors WHERE id=$1 AND corp_id=$2 AND kind='human' AND role IN ('owner','admin','manager','member'))",
    )
    .bind(actor)
    .bind(publication.corp_id)
    .fetch_one(&mut **tx)
    .await?;
    if !allowed {
        return Err(anyhow!(
            "forbidden: readiness requires a scoped human actor"
        ));
    }
    assert_publication_room_membership_tx(tx, publication, actor).await
}

async fn require_operation_token(
    tx: &mut Transaction<'_, Postgres>,
    publication: &PullRequestPublication,
    journal: &PublicationReadiness,
    suffix: &str,
    token: Uuid,
) -> Result<()> {
    let operation = publication_operation_tx(
        tx,
        publication.corp_id,
        &operation_key(publication.id, journal.intent_id, suffix),
    )
    .await?
    .context("conflict: readiness dispatch receipt is missing")?;
    if operation.publication_id != publication.id
        || operation.actor_id != journal.actor_id
        || operation.operation != OPERATION
        || operation.publisher_token != Some(token)
        || operation.request["publisher_id"] != journal.publisher_id
    {
        return Err(anyhow!(
            "forbidden: readiness capability does not own this operation"
        ));
    }
    Ok(())
}

async fn require_recovery(
    tx: &mut Transaction<'_, Postgres>,
    publication: &PullRequestPublication,
    journal: &PublicationReadiness,
    token: Uuid,
    expected: i64,
) -> Result<Uuid> {
    require_version(publication, expected)?;
    let recovery = journal
        .recovery
        .as_ref()
        .filter(|recovery| recovery.expires_at > Utc::now())
        .context("conflict: readiness recovery lease expired")?;
    if journal.state != PublicationReadinessState::Recovering {
        return Err(anyhow!("conflict: readiness is not owned for compensation"));
    }
    require_operation_token(
        tx,
        publication,
        journal,
        &format!("recover:{}", recovery.acquisition_id),
        token,
    )
    .await?;
    Ok(recovery.acquisition_id)
}

fn validate_prepared_source(
    publication: &PullRequestPublication,
    pr: &PublicationPullRequestSnapshot,
) -> Result<()> {
    validate_observed_publication_text(&pr.title, &pr.body)?;
    let adopted = &publication.provenance["active_checkpoint"]["pull_request"];
    if adopted["number"] != pr.number
        || adopted["node_id"] != pr.node_id
        || adopted["url"] != pr.url
        || adopted["base_ref"] != pr.base_ref
        || !pr.draft
        || pr.node_id.is_empty()
        || ((adopted["title"] != pr.title || adopted["body"] != pr.body)
            && (publication.title != pr.title || publication.body != pr.body))
    {
        return Err(anyhow!(
            "readiness intent must retain the adopted draft and observed shared text"
        ));
    }
    // Shared PR text is frozen in the intent; final evidence lives in a separate
    // source-bound comment. All other existing identity checks still apply.
    let mut expected = publication.clone();
    expected.title.clone_from(&pr.title);
    expected.body.clone_from(&pr.body);
    expected
        .provenance
        .as_object_mut()
        .context("invalid publication provenance")?
        .remove(KEY);
    validate_pull_request_identity(
        &expected,
        pr.number,
        &pr.node_id,
        &pr.url,
        &pr.state,
        &pr.title,
        &pr.body,
        &pr.head_ref,
        &pr.base_ref,
        &pr.head_sha,
        &pr.head_repository_owner,
        pr.is_cross_repository,
        pr.auto_merge,
    )
}

impl PgStore {
    pub async fn mutate_publication_readiness(
        &self,
        input: PublicationReadinessInput,
    ) -> Result<PublicationReadinessOutcome> {
        if input.request.intent_id.is_nil() {
            return Err(anyhow!("readiness intent must be non-nil"));
        }
        let publisher_id =
            normalize_factory_identifier(&input.publisher_id, "trusted publisher id", 160)?;
        let credential =
            normalize_publication_publisher_credential_hash(&input.publisher_credential_hash)?;
        let actor = input.request.actor_id;
        let key = action_key(
            input.publication_id,
            input.request.intent_id,
            &input.request.action,
        );
        let request = operation_request(&input)?;
        let mut tx = self.pool.begin().await?;
        assert_actor_scope_tx(&mut tx, input.corp_id, actor).await?;
        // Retain the existing credential-before-publication lock order.
        revalidate_publication_publisher_credential_tx(
            &mut tx,
            input.corp_id,
            &publisher_id,
            &credential,
        )
        .await?;
        lock_factory_keys_tx(
            &mut tx,
            &[
                format!("publication:idempotency:{}:{key}", input.corp_id),
                format!(
                    "publication:item:{}:{}",
                    input.corp_id, input.publication_id
                ),
            ],
        )
        .await?;
        let (mut current, current_token) =
            publication_by_id_tx(&mut tx, input.corp_id, input.publication_id, true)
                .await?
                .context("pull-request publication not found")?;
        require_human_scope(&mut tx, &current, actor).await?;
        let existing = journal(&current)?;

        if let Some(operation) = publication_operation_tx(&mut tx, input.corp_id, &key).await? {
            ensure_publication_operation_matches(
                &operation,
                OPERATION,
                actor,
                presented_token(&input.request.action),
                &request,
            )?;
            if operation.publication_id != current.id {
                return Err(anyhow!(
                    "conflict: readiness replay belongs to another publication"
                ));
            }
            let recovery_token = match (&input.request.action, &existing) {
                (Action::Recover { acquisition_id, .. }, Some(journal))
                    if journal.intent_id == input.request.intent_id
                        && journal.actor_id == actor
                        && journal.publisher_id == publisher_id
                        && journal.pending()
                        && journal.recovery.as_ref().is_some_and(|recovery| {
                            recovery.acquisition_id == *acquisition_id
                                && recovery.expires_at > Utc::now()
                        }) =>
                {
                    operation.publisher_token
                }
                _ => None,
            };
            let busy = recovery_token.is_none()
                && matches!(input.request.action, Action::Recover { .. })
                && existing.as_ref().is_some_and(|journal| journal.pending());
            tx.commit().await?;
            return Ok(PublicationReadinessOutcome {
                publication: current,
                recovery_token,
                events: vec![],
                replayed: true,
                busy,
            });
        }

        let mut private_token = presented_token(&input.request.action);
        let mut recovery_token = None;
        let mut release_forward = false;
        let journal = if let Action::Prepare {
            publisher_token,
            expected_version,
            pull_request,
            evidence_comment,
        } = &input.request.action
        {
            ensure_settled(&current)?;
            if current.state != PullRequestPublicationState::BranchPushed {
                return Err(anyhow!(
                    "conflict: readiness preparation requires a durable branch"
                ));
            }
            ensure_active_publication_control_tx(
                &mut tx,
                &current,
                current_token,
                ActivePublicationControl {
                    actor_id: actor,
                    publisher_id: &publisher_id,
                    presented_token: *publisher_token,
                    expected_version: *expected_version,
                    now: Utc::now(),
                },
            )
            .await?;
            revalidate_publication_authority_tx(&mut tx, &current, actor).await?;
            current = publication_by_id_tx(&mut tx, input.corp_id, input.publication_id, false)
                .await?
                .context("publication disappeared during readiness authorization")?
                .0;
            validate_prepared_source(&current, pull_request)?;
            evidence_comment
                .validate(
                    &current.target_repository,
                    pull_request.number,
                    &publication_evidence_body(
                        PublicationEvidenceKind::Final,
                        current.id,
                        &current.target_repository,
                        &current.commit_sha,
                        &current.title,
                        &current.body,
                    ),
                )
                .map_err(anyhow::Error::msg)?;
            PublicationReadiness {
                intent_id: input.request.intent_id,
                actor_id: actor,
                publisher_id: publisher_id.clone(),
                state: PublicationReadinessState::Prepared,
                pull_request: pull_request.clone(),
                evidence_comment: evidence_comment.clone(),
                ready_succeeded: false,
                undo: vec![],
                recovery: None,
                draft_observed: None,
                created_at: Utc::now(),
            }
        } else {
            let mut journal = existing.context("conflict: publication has no readiness intent")?;
            if journal.intent_id != input.request.intent_id
                || journal.actor_id != actor
                || journal.publisher_id != publisher_id
            {
                return Err(anyhow!(
                    "forbidden: readiness intent belongs to another actor or publisher"
                ));
            }
            if !journal.pending() {
                // An accepted publication is never compensated. A settled intent
                // cannot authorize a new effect through a different request key.
                if matches!(input.request.action, Action::Recover { .. }) {
                    tx.commit().await?;
                    return Ok(PublicationReadinessOutcome {
                        publication: current,
                        recovery_token: None,
                        events: vec![],
                        replayed: true,
                        busy: false,
                    });
                }
                return Err(anyhow!("conflict: readiness intent is already settled"));
            }
            if publication_state_rank(current.state)
                >= publication_state_rank(PullRequestPublicationState::PullRequestCreated)
            {
                return Err(anyhow!(
                    "conflict: a durable final publication cannot be reverted"
                ));
            }
            match &input.request.action {
                Action::ReadySucceeded { publisher_token } => {
                    require_operation_token(
                        &mut tx,
                        &current,
                        &journal,
                        "prepare",
                        *publisher_token,
                    )
                    .await?;
                    journal.ready_succeeded = true;
                }
                Action::Recover {
                    publisher_token,
                    expected_version,
                    acquisition_id,
                } => {
                    require_version(&current, *expected_version)?;
                    if acquisition_id.is_nil() {
                        return Err(anyhow!("recovery acquisition must be non-nil"));
                    }
                    if journal
                        .recovery
                        .as_ref()
                        .is_some_and(|recovery| recovery.expires_at > Utc::now())
                    {
                        tx.commit().await?;
                        return Ok(PublicationReadinessOutcome {
                            publication: current,
                            recovery_token: None,
                            events: vec![],
                            replayed: false,
                            busy: true,
                        });
                    }
                    if current
                        .publisher_lease_expires_at
                        .is_some_and(|expiry| expiry > Utc::now())
                    {
                        ensure_active_publication_control_tx(
                            &mut tx,
                            &current,
                            current_token,
                            ActivePublicationControl {
                                actor_id: actor,
                                publisher_id: &publisher_id,
                                presented_token: publisher_token.context(
                                    "conflict: forward publisher still owns the readiness dispatch",
                                )?,
                                expected_version: *expected_version,
                                now: Utc::now(),
                            },
                        )
                        .await?;
                    }
                    release_forward = true;
                    let token = Uuid::new_v4();
                    private_token = Some(token);
                    recovery_token = Some(token);
                    journal.state = PublicationReadinessState::Recovering;
                    journal.recovery = Some(PublicationReadinessRecovery {
                        acquisition_id: *acquisition_id,
                        expires_at: Utc::now() + Duration::seconds(RECOVERY_SECONDS),
                    });
                }
                Action::UndoPrepared {
                    recovery_token,
                    expected_version,
                    dispatch_id,
                } => {
                    let acquisition_id = require_recovery(
                        &mut tx,
                        &current,
                        &journal,
                        *recovery_token,
                        *expected_version,
                    )
                    .await?;
                    if journal.undo.len() >= MAX_UNDO_DISPATCHES {
                        return Err(anyhow!(
                            "conflict: native draft reconciliation reached its 32-dispatch limit; retain unresolved evidence for operator reconciliation"
                        ));
                    }
                    if dispatch_id.is_nil()
                        || journal
                            .undo
                            .iter()
                            .any(|undo| undo.acquisition_id == acquisition_id)
                    {
                        return Err(anyhow!(
                            "conflict: compensation permits one native undo dispatch per recovery lease"
                        ));
                    }
                    journal.undo.push(PublicationReadinessUndo {
                        dispatch_id: *dispatch_id,
                        acquisition_id,
                        succeeded: false,
                    });
                }
                Action::UndoSucceeded {
                    recovery_token,
                    dispatch_id,
                } => {
                    require_operation_token(
                        &mut tx,
                        &current,
                        &journal,
                        &format!("undo:{dispatch_id}"),
                        *recovery_token,
                    )
                    .await?;
                    journal
                        .undo
                        .iter_mut()
                        .find(|undo| undo.dispatch_id == *dispatch_id)
                        .context("conflict: compensation dispatch is missing")?
                        .succeeded = true;
                }
                Action::DraftObserved {
                    recovery_token,
                    expected_version,
                    pull_request,
                } => {
                    require_recovery(
                        &mut tx,
                        &current,
                        &journal,
                        *recovery_token,
                        *expected_version,
                    )
                    .await?;
                    if !journal.pull_request.same_identity(pull_request)
                        || !pull_request.draft
                        || pull_request.state != "OPEN"
                    {
                        return Err(anyhow!(
                            "draft reconciliation must observe the same open PR restored to draft"
                        ));
                    }
                    journal.draft_observed = Some(pull_request.clone());
                    if journal.effects_acknowledged() {
                        journal.state = PublicationReadinessState::Compensated;
                    }
                    // Unknown native effects remain unresolved. Release this
                    // compensation lease so a later invocation can repair a late
                    // ready without ever authorizing a new forward ready.
                    journal
                        .recovery
                        .as_mut()
                        .context("recovery lease missing")?
                        .expires_at = Utc::now();
                }
                Action::Prepare { .. } => unreachable!(),
            }
            journal
        };

        // The current summary never contains either kind of capability. Previous
        // source observations and acknowledgements remain in the operation log.
        current.provenance[KEY] = serde_json::to_value(&journal)?;
        if release_forward {
            sqlx::query("UPDATE pull_request_publication_attempts SET state='abandoned', failure_detail='Native readiness requires draft reconciliation.', finished_at=COALESCE(finished_at,now()) WHERE publication_id=$1 AND corp_id=$2 AND state='running'")
                .bind(current.id).bind(current.corp_id).execute(&mut *tx).await?;
        }
        let row = sqlx::query(&format!(
            "UPDATE pull_request_publications SET provenance=$1, version=version+1, publisher_id=CASE WHEN $2 THEN NULL ELSE publisher_id END, publisher_token=CASE WHEN $2 THEN NULL ELSE publisher_token END, publisher_lease_expires_at=CASE WHEN $2 THEN NULL ELSE publisher_lease_expires_at END, failure_detail=CASE WHEN $3 THEN 'Native readiness has unacknowledged effects; reconcile the retained PR before publication.' ELSE failure_detail END, updated_at=now() WHERE id=$4 AND corp_id=$5 RETURNING {}",
            publication_returning_columns()))
            .bind(&current.provenance).bind(release_forward)
            .bind(journal.state == PublicationReadinessState::Recovering)
            .bind(current.id).bind(current.corp_id).fetch_one(&mut *tx).await?;
        let publication = map_pull_request_publication(row)?;
        record_publication_operation_tx(
            &mut tx,
            NewPublicationOperation {
                corp_id: input.corp_id,
                idempotency_key: &key,
                publication_id: publication.id,
                actor_id: actor,
                operation: OPERATION,
                resulting_version: publication.version,
                publisher_token: private_token,
                request: &request,
            },
        )
        .await?;
        let event = publication_event_tx(&mut tx, &publication, actor, "factory.publication_readiness",
            json!({"intent_id":journal.intent_id, "state":journal.state, "ready_succeeded":journal.ready_succeeded,
                "unacknowledged_undo":journal.undo.iter().filter(|undo| !undo.succeeded).count(),
                "pull_request_number":journal.pull_request.number, "action":request["action"]["kind"]})).await?;
        tx.commit().await?;
        Ok(PublicationReadinessOutcome {
            publication,
            recovery_token,
            events: event.into_iter().collect(),
            replayed: false,
            busy: false,
        })
    }
}

pub(super) fn accept(
    publication: &PullRequestPublication,
    observed: &PublicationPullRequestSnapshot,
) -> Result<Option<PublicationReadiness>> {
    if publication
        .provenance
        .get("active_checkpoint")
        .is_none_or(|value| value.is_null())
    {
        return Ok(None);
    }
    let Some(mut journal) = journal(publication)? else {
        // Preserve already recorded legacy final receipts; incomplete drafts
        // require the new journal before their first final checkpoint.
        if publication_state_rank(publication.state)
            >= publication_state_rank(PullRequestPublicationState::PullRequestCreated)
        {
            return Ok(None);
        }
        return Err(anyhow!(
            "final draft promotion requires a persisted readiness intent"
        ));
    };
    if !matches!(
        journal.state,
        PublicationReadinessState::Prepared | PublicationReadinessState::Accepted
    ) || !journal.ready_succeeded
        || !journal.undo.is_empty()
        || !journal.pull_request.matches_ready(observed)
    {
        return Err(anyhow!(
            "conflict: final PR no longer matches its acknowledged readiness intent; reconcile draft"
        ));
    }
    journal.state = PublicationReadinessState::Accepted;
    Ok(Some(journal))
}

pub(super) fn record_accepted(
    provenance: &mut Value,
    journal: Option<PublicationReadiness>,
) -> Result<()> {
    if let Some(journal) = journal {
        provenance[KEY] = serde_json::to_value(journal)?;
    }
    Ok(())
}
