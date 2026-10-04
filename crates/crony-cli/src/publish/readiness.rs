//! Native GitHub ready has no conditional head/text fence. Persist the intent
//! before dispatch, acknowledge successful commands, and compensate independently
//! of forward publication authority. Unknown in-flight effects remain blocked.
use super::*;
use crony_domain::{
    PublicationEvidenceKind, PublicationPullRequestSnapshot, PublicationReadiness,
    PublicationReadinessAction as Action, PublicationReadinessRequest, PublicationReadinessState,
    publication_evidence_body,
};
use crony_protocol::PublicationReadinessResponse;

pub(super) fn journal(
    publication: &PullRequestPublication,
) -> Result<Option<PublicationReadiness>> {
    publication
        .provenance
        .get("active_checkpoint_readiness")
        .filter(|value| !value.is_null())
        .map(|value| {
            serde_json::from_value(value.clone()).context("decode publication readiness journal")
        })
        .transpose()
}

pub(super) async fn mutate(
    client: &Client,
    server: &str,
    args: &FactoryPublishArgs,
    publication_id: Uuid,
    intent_id: Uuid,
    action: Action,
) -> Result<PublicationReadinessResponse> {
    let value = publisher_server_json(
        client,
        Method::POST,
        format!(
            "{server}/api/corps/{}/factory/publications/{publication_id}/readiness",
            args.corp_id
        ),
        Some(serde_json::to_value(PublicationReadinessRequest {
            actor_id: args.actor_id,
            intent_id,
            action,
        })?),
        args,
    )
    .await?;
    let response: PublicationReadinessResponse =
        serde_json::from_value(value).context("decode readiness response")?;
    if response.publication.id != publication_id
        || response.publication.corp_id != args.corp_id
        || response.publication.factory_work_item_id != args.work_item_id
    {
        bail!("readiness response belongs to another publication scope");
    }
    Ok(response)
}

fn read_retained(
    args: &FactoryPublishArgs,
    publication: &PullRequestPublication,
    intent: &PublicationReadiness,
) -> Result<PullRequestView> {
    let remote = active_checkpoint::read_repository_pull_request(
        &args.github_cli,
        &publication.target_repository,
        intent.pull_request.number,
    )?;
    if !intent
        .pull_request
        .same_identity(&PublicationPullRequestSnapshot::from(&remote))
    {
        bail!("readiness compensation refuses a different PR identity");
    }
    if remote.state != "OPEN" {
        bail!("retained PR is no longer open; draft restoration remains unresolved");
    }
    Ok(remote)
}

/// This path deliberately runs before plan construction, source checks or lease
/// acquisition. Changed source or revoked publish permission cannot skip repair.
pub(super) async fn recover_pending(
    client: &Client,
    server: &str,
    args: &FactoryPublishArgs,
    publisher_token: Option<Uuid>,
) -> Result<()> {
    let current = get_publication(client, server, args).await?.publication;
    let Some(intent) = journal(&current)?.filter(|intent| intent.pending()) else {
        return Ok(());
    };
    let mut response = mutate(
        client,
        server,
        args,
        current.id,
        intent.intent_id,
        Action::Recover {
            publisher_token,
            expected_version: current.version,
            acquisition_id: Uuid::new_v4(),
        },
    )
    .await?;
    if response.busy {
        bail!("readiness reconciliation is still owned by another live publisher");
    }
    let Some(token) = response.recovery_token else {
        if journal(&response.publication)?.is_none_or(|intent| !intent.pending()) {
            return Ok(());
        }
        bail!("readiness reconciliation did not grant compensation authority");
    };
    let mut remote = read_retained(args, &response.publication, &intent)?;
    let mut native_error = None;
    if !remote.is_draft {
        let dispatch_id = Uuid::new_v4();
        response = mutate(
            client,
            server,
            args,
            current.id,
            intent.intent_id,
            Action::UndoPrepared {
                recovery_token: token,
                expected_version: response.publication.version,
                dispatch_id,
            },
        )
        .await?;
        if response.replayed || response.busy {
            bail!("compensation dispatch was already recorded; no native effect repeated");
        }
        let undone = gh_run(
            &args.github_cli,
            &[
                "pr",
                "ready",
                &remote.number.to_string(),
                "--repo",
                &current.target_repository,
                "--undo",
            ],
        );
        match undone {
            Ok(()) => {
                response = mutate(
                    client,
                    server,
                    args,
                    current.id,
                    intent.intent_id,
                    Action::UndoSucceeded {
                        recovery_token: token,
                        dispatch_id,
                    },
                )
                .await?;
            }
            Err(error) => native_error = Some(error),
        }
        remote = read_retained(args, &response.publication, &intent)?;
    }
    if !remote.is_draft {
        if let Some(error) = native_error {
            return Err(error).context("native draft restoration failed");
        }
        bail!("retained PR is still ready; draft reconciliation is incomplete");
    }
    response = mutate(
        client,
        server,
        args,
        current.id,
        intent.intent_id,
        Action::DraftObserved {
            recovery_token: token,
            expected_version: response.publication.version,
            pull_request: PublicationPullRequestSnapshot::from(&remote),
        },
    )
    .await?;
    if journal(&response.publication)?.is_some_and(|intent| intent.pending()) {
        bail!(
            "retained PR is draft, but a native ready or undo result remains unknown; forward publication stays blocked"
        );
    }
    Ok(())
}

pub(super) fn final_evidence_body(publication: &PullRequestPublication) -> String {
    publication_evidence_body(
        PublicationEvidenceKind::Final,
        publication.id,
        &publication.target_repository,
        &publication.commit_sha,
        &publication.title,
        &publication.body,
    )
}

pub(super) fn validate_final(
    args: &FactoryPublishArgs,
    publication: &PullRequestPublication,
    pr: &PullRequestView,
) -> Result<bool> {
    let Some(intent) = journal(publication)? else {
        return Ok(false);
    };
    if intent.state != PublicationReadinessState::Accepted
        || !intent.ready_succeeded
        || !intent.undo.is_empty()
        || !intent
            .pull_request
            .matches_ready(&PublicationPullRequestSnapshot::from(pr))
    {
        bail!("remote PR no longer matches its accepted readiness intent");
    }
    evidence_comment::verify(
        &args.github_cli,
        &publication.target_repository,
        pr.number,
        &intent.evidence_comment,
        &final_evidence_body(publication),
    )?;
    Ok(true)
}
