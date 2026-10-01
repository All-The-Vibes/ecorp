//! Publication succession uses the same create-only native Git/GitHub effects.
//! Every retained predecessor is read again, including on completed replays.
use super::*;
use anyhow::ensure;
use crony_domain::{FactoryReviewRevision, MAX_REVIEW_REVISIONS};
use std::collections::HashSet;

pub(super) fn lineage(
    args: &FactoryPublishArgs,
    context: &Value,
    mission: Uuid,
    deliverable: &Value,
) -> Result<(Option<Uuid>, Vec<PullRequestPublication>)> {
    let revisions: Vec<FactoryReviewRevision> = serde_json::from_value(
        context
            .get("review_revisions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .context("decode governed review revisions")?;
    let history: Vec<PullRequestPublication> = serde_json::from_value(
        context
            .get("publication_history")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .context("decode immutable publication history")?;
    ensure!(
        revisions.len() <= MAX_REVIEW_REVISIONS && history.len() <= MAX_REVIEW_REVISIONS + 1,
        "publication review lineage exceeds its bound"
    );
    let mut cursor = mission;
    let mut head = value_string(deliverable, "/head_commit")?;
    let mut result = value_uuid(deliverable, "/id")?;
    let mut run = value_uuid(deliverable, "/run_id")?;
    let mut selected_revision = None;
    let mut predecessors = Vec::new();
    let mut visited = HashSet::new();
    loop {
        let matches = revisions
            .iter()
            .filter(|revision| revision.mission_id == cursor)
            .collect::<Vec<_>>();
        let revision = match matches.as_slice() {
            [] => break,
            [revision] => *revision,
            _ => bail!("ambiguous review revision mission"),
        };
        ensure!(
            visited.insert(revision.id)
                && visited.len() <= MAX_REVIEW_REVISIONS
                && revision.corp_id == args.corp_id
                && revision.factory_work_item_id == args.work_item_id
                && revision.state == "adopted"
                && revision.result_deliverable_id == Some(result)
                && revision.result_run_id == Some(run)
                && revision.result_commit.as_deref() == Some(head.as_str())
                && revision.review_decision_id.is_some(),
            "correction is not the exact independently reviewed adopted result"
        );
        selected_revision.get_or_insert(revision.id);
        let matches = history
            .iter()
            .filter(|publication| publication.id == revision.publication_id)
            .collect::<Vec<_>>();
        let prior = match matches.as_slice() {
            [prior] => *prior,
            _ => bail!("correction predecessor publication is missing or ambiguous"),
        };
        ensure!(
            prior.corp_id == args.corp_id
                && prior.factory_work_item_id == args.work_item_id
                && prior.state == PullRequestPublicationState::Published
                && prior.mission_id == revision.source_mission_id
                && prior.task_id == revision.source_task_id
                && prior.run_id == revision.source_run_id
                && prior.source_deliverable_id == revision.source_deliverable_id
                && prior.commit_sha == revision.source_head_commit,
            "correction predecessor does not match its immutable source"
        );
        cursor = prior.mission_id;
        head.clone_from(&prior.commit_sha);
        result = prior.source_deliverable_id;
        run = prior.run_id;
        predecessors.push(prior.clone());
    }
    for (index, prior) in predecessors.iter().enumerate() {
        ensure!(
            prior.supersedes_publication_id == predecessors.get(index + 1).map(|parent| parent.id),
            "publication history has a missing or substituted ancestor"
        );
    }
    if let Some(current) = context.get("publication").filter(|value| !value.is_null()) {
        let persisted_parent: Option<Uuid> = serde_json::from_value(
            current
                .get("supersedes_publication_id")
                .cloned()
                .unwrap_or(Value::Null),
        )?;
        ensure!(
            persisted_parent == predecessors.first().map(|prior| prior.id),
            "current publication lost its exact succession authority"
        );
    } else if selected_revision.is_none() && !history.is_empty() {
        bail!("another publication exists without an adopted correction lineage");
    }
    Ok((selected_revision, predecessors))
}

pub(super) fn validate_predecessors(
    args: &FactoryPublishArgs,
    plan: &PublicationPlan,
    repository: &Path,
) -> Result<()> {
    for prior in &plan.review_predecessors {
        let mut original = plan.clone();
        original.branch.clone_from(&prior.branch);
        original.commit_sha.clone_from(&prior.commit_sha);
        original.title.clone_from(&prior.title);
        original.body.clone_from(&prior.body);
        let base = prior
            .pull_request_base_ref
            .as_deref()
            .context("predecessor omitted durable PR base")?;
        let remote = find_pull_request(args, &original, base)?
            .context("published predecessor PR drifted or disappeared")?;
        ensure_remote_pull_request_matches(&remote, &original, base)?;
        ensure_pull_request_matches_publication(&remote, prior)?;
        ensure_remote_branch(repository, &original)?;
    }
    Ok(())
}

pub(super) fn validate_completed(
    args: &FactoryPublishArgs,
    plan: &PublicationPlan,
    publication: &PullRequestPublication,
) -> Result<()> {
    ensure_publication_matches_plan(publication, plan)?;
    let workspace = TemporaryPublisherWorkspace::create()?;
    source_git_output(&workspace.repository, &["init", "--bare"])?;
    add_publication_remote(&workspace.repository, &plan.target_repository)?;
    revalidate_durable_pull_request(
        args,
        plan,
        &workspace.repository,
        publication
            .pull_request_base_ref
            .as_deref()
            .context("completed publication omitted durable PR base")?,
        publication,
    )
}
