//! A bounded, credential-owning draft publisher. Native Git and GitHub own the
//! remote effects; ECorp owns scope, immutable source evidence and restart leases.
use super::*;
use crony_domain::{
    ActiveCheckpointAction, ActiveCheckpointFailureReason, ActiveCheckpointOutcome,
    ActiveCheckpointPolicy, ActiveCheckpointPublication, ActiveCheckpointRequest, FactoryWorkItem,
};

#[derive(Debug, Args)]
pub struct FactoryCheckpointArgs {
    pub corp_id: Uuid,
    pub actor_id: Uuid,
    pub work_item_id: Uuid,
    #[arg(long, env = "ECORP_PUBLICATION_PUBLISHER_ID")]
    pub publisher_id: Option<String>,
    #[arg(long, env = "ECORP_PUBLICATION_PUBLISHER_CREDENTIAL_FILE")]
    pub publisher_credential_file: Option<PathBuf>,
    #[arg(long, env = "ECORP_GITHUB_CLI", default_value = "gh")]
    pub github_cli: PathBuf,
    /// Continue refreshing persisted gate evidence until this bounded deadline.
    #[arg(long, default_value_t = 900, value_parser = clap::value_parser!(u64).range(1..=86400))]
    pub wait_seconds: u64,
    #[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u64).range(1..=30))]
    pub poll_seconds: u64,
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
struct CheckpointContext {
    work_item: FactoryWorkItem,
    publication: Option<ActiveCheckpointPublication>,
    desired_body: Option<String>,
    final_publication_started: bool,
    artifacts: Vec<CheckpointArtifact>,
}

#[derive(Debug, Deserialize)]
struct CheckpointArtifact {
    id: Uuid,
}

pub async fn run(client: &Client, server: &str, args: FactoryCheckpointArgs) -> Result<Value> {
    if !(1..=86_400).contains(&args.wait_seconds) || !(1..=30).contains(&args.poll_seconds) {
        bail!("checkpoint watcher requires a bounded wait and polling interval");
    }
    if !args.dry_run && args.publisher_credential_file.is_none() {
        bail!("checkpoint publication requires a trusted publisher credential file");
    }
    let deadline = Instant::now() + Duration::from_secs(args.wait_seconds);
    loop {
        let context: CheckpointContext = serde_json::from_value(
            server_json(
                client,
                Method::GET,
                format!(
                    "{server}/api/corps/{}/factory/work-items/{}/active-checkpoint?actor_id={}",
                    args.corp_id, args.work_item_id, args.actor_id
                ),
                None,
            )
            .await?,
        )
        .context("decode active checkpoint context")?;
        if context.work_item.id != args.work_item_id || context.work_item.corp_id != args.corp_id {
            bail!("checkpoint context belongs to another work item or Corp");
        }
        ActiveCheckpointPolicy::validate_factory_policy(&context.work_item.policy)
            .map_err(anyhow::Error::msg)?
            .context("factory policy did not authorize active checkpoints")?;
        if context.final_publication_started {
            return Ok(
                json!({"status":"final_publication_owns_branch","work_item_id":args.work_item_id}),
            );
        }
        let artifact_id = selected_artifact(&context);
        if args.dry_run {
            return Ok(json!({"status":"dry_run","artifact_id":artifact_id,
                "publication":context.publication,"auto_merge":false}));
        }
        if let Some(artifact_id) = artifact_id {
            let prior = context
                .publication
                .as_ref()
                .filter(|p| p.artifact_id == artifact_id);
            let mut outcome = mutate(
                client,
                server,
                &args,
                artifact_id,
                prior,
                None,
                ActiveCheckpointAction::Acquire,
            )
            .await?;
            if let Some(token) = outcome.publisher_token {
                let mut failure = ActiveCheckpointFailureReason::SourcePreparation;
                if let Err(error) = execute(
                    client,
                    server,
                    &args,
                    &context.work_item,
                    &mut outcome,
                    token,
                    &mut failure,
                )
                .await
                {
                    // A fixed classification is durable; child output never enters the ledger.
                    let _ = advance(
                        client,
                        server,
                        &args,
                        &mut outcome,
                        token,
                        ActiveCheckpointAction::Failed { reason: failure },
                    )
                    .await;
                    return Err(error);
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(
                json!({"status":"watch_deadline","work_item_id":args.work_item_id,
                "message":"Resume factory-checkpoint to reconcile remote effects and refresh gates."}),
            );
        }
        tokio::time::sleep(std::cmp::min(
            Duration::from_secs(args.poll_seconds),
            deadline.saturating_duration_since(Instant::now()),
        ))
        .await;
    }
}

fn selected_artifact(context: &CheckpointContext) -> Option<Uuid> {
    if let Some(publication) = &context.publication {
        // Resume partial remote effects and stale gate bodies before advancing source.
        if !publication.gates_synchronized()
            || publication.failure_detail.is_some()
            || context.desired_body.as_deref() != Some(publication.body.as_str())
        {
            return Some(publication.artifact_id);
        }
        if context
            .artifacts
            .first()
            .is_some_and(|a| a.id == publication.artifact_id)
        {
            return None;
        }
    }
    context.artifacts.first().map(|artifact| artifact.id)
}

async fn mutate(
    client: &Client,
    server: &str,
    args: &FactoryCheckpointArgs,
    artifact_id: Uuid,
    publication: Option<&ActiveCheckpointPublication>,
    token: Option<Uuid>,
    action: ActiveCheckpointAction,
) -> Result<ActiveCheckpointOutcome> {
    let request = ActiveCheckpointRequest {
        actor_id: args.actor_id,
        artifact_id,
        publisher_id: args
            .publisher_id
            .clone()
            .unwrap_or_else(default_publisher_id),
        idempotency_key: Uuid::new_v4(),
        expected_version: publication.map(|p| p.version),
        publisher_token: token,
        action,
    };
    let url = format!(
        "{server}/api/corps/{}/factory/work-items/{}/active-checkpoint",
        args.corp_id, args.work_item_id
    );
    // Re-send the exact request after a lost response. Restart recovery instead
    // reacquires the latest expired lease; it never guesses a new generation.
    let body = serde_json::to_value(&request)?;
    let first = publisher_request(
        client,
        Method::POST,
        url.clone(),
        Some(body.clone()),
        args.publisher_credential_file.as_deref(),
    )
    .await;
    let value = match first {
        Ok(value) => value,
        Err(_) => {
            publisher_request(
                client,
                Method::POST,
                url,
                Some(body),
                args.publisher_credential_file.as_deref(),
            )
            .await?
        }
    };
    let result: ActiveCheckpointOutcome =
        serde_json::from_value(value).context("decode checkpoint publication lease")?;
    if result.publication.corp_id != args.corp_id
        || result.publication.work_item_id != args.work_item_id
        || result.publication.artifact_id != artifact_id
    {
        bail!("checkpoint mutation returned another source or Corp");
    }
    Ok(result)
}

async fn advance(
    client: &Client,
    server: &str,
    args: &FactoryCheckpointArgs,
    outcome: &mut ActiveCheckpointOutcome,
    token: Uuid,
    action: ActiveCheckpointAction,
) -> Result<()> {
    *outcome = mutate(
        client,
        server,
        args,
        outcome.publication.artifact_id,
        Some(&outcome.publication),
        Some(token),
        action,
    )
    .await?;
    Ok(())
}

fn target(item: &FactoryWorkItem, p: &ActiveCheckpointPublication) -> Result<PublicationTarget> {
    let policy = &item.policy["publication"];
    let expected_repository = normalize_publication_repository(&format!(
        "{}/{}",
        item.source_repository_owner, item.source_repository_name
    ))?;
    if p.work_item_id != item.id
        || p.corp_id != item.corp_id
        || Some(p.mission_id) != item.mission_id
        || p.target_repository != expected_repository
        || p.branch != checkpoint_branch(&item.policy, item.source_issue_number, item.id)?
    {
        bail!("checkpoint target does not match its factory authority");
    }
    validate_publication_branch(&p.branch)?;
    Ok(PublicationTarget {
        target_repository: expected_repository,
        base_ref: p.base_ref.clone(),
        verified_base_commit: value_string(&p.metadata, "/base_commit")?,
        branch: p.branch.clone(),
        commit_sha: p.commit_sha.clone(),
        title: p.title.clone(),
        body: p.body.clone(),
        project_owner: item.source_project_owner.clone(),
        project_number: item.source_project_number,
        project_item_id: item.source_project_item_id.clone(),
        project_status_before: value_string(policy, "/status_before")?,
        project_review_status: value_string(policy, "/review_status")?,
    })
}

pub(super) fn checkpoint_branch(policy: &Value, issue: i64, item: Uuid) -> Result<String> {
    ActiveCheckpointPolicy::validate_factory_policy(policy)
        .map_err(anyhow::Error::msg)?
        .context("factory policy did not opt into active checkpoints")?;
    let prefix = value_string(policy, "/publication/branch_prefix")?;
    let branch = format!("{prefix}issue-{issue}-{}", &item.to_string()[..8]);
    validate_publication_branch(&branch)?;
    Ok(branch)
}

fn validate_document(
    bytes: &[u8],
    p: &ActiveCheckpointPublication,
) -> Result<(CommitBranchDocument, Vec<u8>)> {
    if hex::encode(Sha256::digest(bytes)) != p.artifact_sha256 {
        bail!("checkpoint bytes differ from the authenticated stored artifact");
    }
    let envelope: Value = serde_json::from_slice(bytes).context("decode checkpoint artifact")?;
    let document: CommitBranchDocument = serde_json::from_value(envelope.clone())?;
    if document.schema_version != 1
        || document.form != "commit_branch"
        || document.head_commit != p.commit_sha
        || envelope["purpose"] != "active_checkpoint"
        || envelope["publication_ready"] != false
    {
        bail!("checkpoint artifact is not the authorized draft source");
    }
    for field in [
        "base_commit",
        "head_commit",
        "branch",
        "verification_sha256",
        "git_bundle_sha256",
        "source_verification",
        "verified_tree",
        "checkpoint_policy",
        "verification_policy",
        "checkpoint_report",
        "parent_commit",
    ] {
        if envelope.get(field).is_none_or(Value::is_null)
            || envelope.get(field) != p.metadata.get(field)
        {
            bail!("checkpoint artifact does not match its authenticated {field}");
        }
    }
    let source = SourceVerification::from_payload(&envelope).map_err(anyhow::Error::msg)?;
    let report = &envelope["checkpoint_report"];
    let checkpoint: crony_domain::ActiveCheckpointPolicy =
        serde_json::from_value(envelope["checkpoint_policy"].clone())?;
    let full: crony_domain::VerificationPolicy =
        serde_json::from_value(envelope["verification_policy"].clone())?;
    checkpoint
        .validate_report(&full, report)
        .map_err(anyhow::Error::msg)?;
    if report["source"] != serde_json::to_value(source)?
        || report["passed"] != true
        || document.verification_sha256 != hex::encode(Sha256::digest(serde_json::to_vec(report)?))
    {
        bail!("checkpoint focused report does not match the canonical source identity");
    }
    let bundle = BASE64
        .decode(&document.git_bundle_base64)
        .context("decode checkpoint bundle")?;
    if bundle.is_empty() || hex::encode(Sha256::digest(&bundle)) != document.git_bundle_sha256 {
        bail!("checkpoint Git bundle digest does not match");
    }
    Ok((document, bundle))
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    client: &Client,
    server: &str,
    args: &FactoryCheckpointArgs,
    item: &FactoryWorkItem,
    outcome: &mut ActiveCheckpointOutcome,
    token: Uuid,
    failure: &mut ActiveCheckpointFailureReason,
) -> Result<()> {
    let plan = target(item, &outcome.publication)?;
    advance(
        client,
        server,
        args,
        outcome,
        token,
        ActiveCheckpointAction::Renew,
    )
    .await?;
    let bytes = download_deliverable(
        client,
        server,
        args.corp_id,
        args.actor_id,
        outcome.publication.artifact_id,
    )
    .await?;
    let (document, bundle) = validate_document(&bytes, &outcome.publication)?;
    let workspace = TemporaryPublisherWorkspace::create()?;
    fs::write(&workspace.bundle, bundle)?;
    fs::write(&workspace.body, plan.body.as_bytes())?;
    let base = prepare_repository(&workspace, &plan, &document)?;
    ensure_distinct_publication_branch(&plan.branch, &base.pull_request_base_ref)?;
    if outcome
        .publication
        .pull_request_base_ref
        .as_ref()
        .is_some_and(|old| old != &base.pull_request_base_ref)
    {
        bail!("checkpoint remote base changed after its first publication");
    }
    *failure = ActiveCheckpointFailureReason::BranchPublication;
    if outcome.publication.phase == "pending" {
        advance(
            client,
            server,
            args,
            outcome,
            token,
            ActiveCheckpointAction::Renew,
        )
        .await?;
        if let Some(previous) = known_pull_request(&outcome.publication) {
            let remote = read_known_pull_request(&args.github_cli, &plan, previous)?;
            validate_draft(
                &remote,
                &plan,
                &base.pull_request_base_ref,
                &outcome.publication,
                true,
            )?;
        }
        ensure_remote_base(&workspace.repository, &plan, &document.base_commit)?;
        push_checkpoint(
            &workspace.repository,
            &plan,
            outcome.publication.previous_commit_sha.as_deref(),
        )?;
        test_crash("after_active_checkpoint_branch_remote");
        advance(
            client,
            server,
            args,
            outcome,
            token,
            ActiveCheckpointAction::BranchPushed {
                commit_sha: plan.commit_sha.clone(),
                base_ref: base.pull_request_base_ref.clone(),
            },
        )
        .await?;
    } else {
        ensure_remote_branch(&workspace.repository, &plan)?;
    }
    *failure = ActiveCheckpointFailureReason::DraftPublication;
    if matches!(
        outcome.publication.phase.as_str(),
        "branch_pushed" | "project_synchronized"
    ) {
        advance(
            client,
            server,
            args,
            outcome,
            token,
            ActiveCheckpointAction::Renew,
        )
        .await?;
        let existing = find_checkpoint_pull_request(&args.github_cli, &plan, &outcome.publication)?;
        if let Some(remote) = &existing {
            validate_draft(
                remote,
                &plan,
                &base.pull_request_base_ref,
                &outcome.publication,
                false,
            )?;
        }
        if existing.is_none() {
            let creation = gh_output(
                &args.github_cli,
                &[
                    "pr",
                    "create",
                    "--repo",
                    &plan.target_repository,
                    "--head",
                    &plan.branch,
                    "--base",
                    &base.pull_request_base_ref,
                    "--draft",
                    "--title",
                    &plan.title,
                    "--body-file",
                    path_text(&workspace.body)?,
                ],
            );
            if let Err(error) = creation
                && find_checkpoint_pull_request(&args.github_cli, &plan, &outcome.publication)?
                    .is_none()
            {
                return Err(error).context("create checkpoint draft");
            }
        } else if existing
            .as_ref()
            .is_some_and(|pr| pr.title != plan.title || pr.body != plan.body)
        {
            advance(
                client,
                server,
                args,
                outcome,
                token,
                ActiveCheckpointAction::Renew,
            )
            .await?;
            let remote =
                find_checkpoint_pull_request(&args.github_cli, &plan, &outcome.publication)?
                    .context("checkpoint draft disappeared before updating its gates")?;
            validate_draft(
                &remote,
                &plan,
                &base.pull_request_base_ref,
                &outcome.publication,
                false,
            )?;
            let edit = edit_pull_request(&args.github_cli, &plan, remote.number, &workspace.body);
            let observed = read_pull_request(&args.github_cli, &plan, remote.number)?;
            if let Err(error) = edit
                && (observed.title != plan.title || observed.body != plan.body)
            {
                return Err(error);
            }
        }
        let remote = find_checkpoint_pull_request(&args.github_cli, &plan, &outcome.publication)?
            .context("remote checkpoint draft was not created")?;
        validate_draft(
            &remote,
            &plan,
            &base.pull_request_base_ref,
            &outcome.publication,
            false,
        )?;
        if remote.title != plan.title || remote.body != plan.body {
            bail!("remote checkpoint gates differ from desired evidence");
        }
        ensure_remote_branch(&workspace.repository, &plan)?;
        test_crash("after_active_checkpoint_draft_remote");
        advance(client, server, args, outcome, token, draft_action(&remote)).await?;
    }
    if outcome.publication.gates_synchronized() {
        return Ok(());
    }
    *failure = ActiveCheckpointFailureReason::ProjectSynchronization;
    advance(
        client,
        server,
        args,
        outcome,
        token,
        ActiveCheckpointAction::Renew,
    )
    .await?;
    let remote = find_checkpoint_pull_request(&args.github_cli, &plan, &outcome.publication)?
        .context("persisted checkpoint draft disappeared")?;
    validate_draft(
        &remote,
        &plan,
        &base.pull_request_base_ref,
        &outcome.publication,
        false,
    )?;
    if remote.body != plan.body || remote.title != plan.title {
        bail!("checkpoint draft gates changed before Project synchronization");
    }
    // Intake already placed the item In Progress. Do not overwrite a human's
    // status change or advance it into review under draft-only authority.
    let (_, field_id, option_id, status) =
        project_status(&args.github_cli, &plan, &plan.project_status_before)?;
    if status != plan.project_status_before {
        bail!("Project status changed after factory intake; preserve the draft");
    }
    let remote = find_checkpoint_pull_request(&args.github_cli, &plan, &outcome.publication)?
        .context("checkpoint draft disappeared during Project synchronization")?;
    validate_draft(
        &remote,
        &plan,
        &base.pull_request_base_ref,
        &outcome.publication,
        false,
    )?;
    test_crash("after_active_checkpoint_project_observation");
    advance(
        client,
        server,
        args,
        outcome,
        token,
        ActiveCheckpointAction::ProjectSynchronized {
            status,
            field_id,
            option_id,
        },
    )
    .await
}

fn push_checkpoint(
    repository: &Path,
    plan: &PublicationTarget,
    previous: Option<&str>,
) -> Result<()> {
    let reference = format!("refs/heads/{}", plan.branch);
    match remote_reference_commit(repository, &reference)? {
        Some(existing) if existing == plan.commit_sha => return Ok(()),
        Some(existing) if Some(existing.as_str()) == previous => {
            source_git_output(
                repository,
                &["merge-base", "--is-ancestor", &existing, &plan.commit_sha],
            )
            .context("new checkpoint must retain the previous published commit")?;
        }
        Some(_) => bail!(
            "checkpoint branch changed outside the persisted generation; preserve both sources"
        ),
        None if previous.is_some() => bail!("previously published checkpoint branch was removed"),
        None => {}
    }
    let refspec = format!("{}:{reference}", plan.commit_sha);
    let pushed = source_git_output(repository, &["push", "origin", &refspec]);
    if let Err(error) = pushed
        && ensure_remote_branch(repository, plan).is_err()
    {
        return Err(error).context("push checkpoint without force");
    }
    ensure_remote_branch(repository, plan)
}

const PR_FIELDS: &str = "number,id,url,state,isDraft,title,body,headRefName,baseRefName,headRefOid,headRepositoryOwner,isCrossRepository,autoMergeRequest";

fn known_pull_request(p: &ActiveCheckpointPublication) -> Option<&Value> {
    p.pull_request.as_ref().or(p.previous_pull_request.as_ref())
}

fn read_pull_request(
    github_cli: &Path,
    plan: &PublicationTarget,
    number: i64,
) -> Result<PullRequestView> {
    if number <= 0 {
        bail!("checkpoint PR number is invalid");
    }
    serde_json::from_value(gh_json(
        github_cli,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            &plan.target_repository,
            "--json",
            PR_FIELDS,
        ],
    )?)
    .context("read checkpoint PR")
}

fn read_known_pull_request(
    github_cli: &Path,
    plan: &PublicationTarget,
    known: &Value,
) -> Result<PullRequestView> {
    let pr = read_pull_request(github_cli, plan, value_i64(known, "/number")?)?;
    if known["node_id"] != pr.id || known["url"] != pr.url {
        bail!("checkpoint PR identity changed");
    }
    Ok(pr)
}

fn find_checkpoint_pull_request(
    github_cli: &Path,
    plan: &PublicationTarget,
    p: &ActiveCheckpointPublication,
) -> Result<Option<PullRequestView>> {
    if let Some(known) = known_pull_request(p) {
        // A missing or edited known PR is a blocker, never permission to create another.
        return read_known_pull_request(github_cli, plan, known).map(Some);
    }
    let mut prs: Vec<PullRequestView> = serde_json::from_value(gh_json(
        github_cli,
        &[
            "pr",
            "list",
            "--repo",
            &plan.target_repository,
            "--state",
            "all",
            "--head",
            &plan.branch,
            "--limit",
            "100",
            "--json",
            PR_FIELDS,
        ],
    )?)
    .context("find checkpoint PR")?;
    if prs.len() > 1 {
        bail!("checkpoint branch has multiple PRs; identity is ambiguous");
    }
    Ok(prs.pop())
}

fn validate_identity(pr: &PullRequestView, plan: &PublicationTarget, base: &str) -> Result<()> {
    let owner = plan.target_repository.split('/').next().unwrap_or_default();
    let url = format!(
        "https://github.com/{}/pull/{}",
        plan.target_repository, pr.number
    );
    if pr.number <= 0
        || pr.id.is_empty()
        || !pr.url.eq_ignore_ascii_case(&url)
        || pr.state != "OPEN"
        || pr.head_ref_name != plan.branch
        || pr.base_ref_name != base
        || !pr.head_repository_owner.login.eq_ignore_ascii_case(owner)
        || pr.is_cross_repository
        || pr.auto_merge_request.is_some()
    {
        bail!("checkpoint PR no longer has the exact open non-merging target identity");
    }
    Ok(())
}

fn content_matches(pr: &PullRequestView, value: &Value) -> bool {
    value["title"].as_str() == Some(pr.title.as_str())
        && value["body"].as_str() == Some(pr.body.as_str())
}

fn validate_draft(
    pr: &PullRequestView,
    plan: &PublicationTarget,
    base: &str,
    p: &ActiveCheckpointPublication,
    allow_previous_head: bool,
) -> Result<()> {
    validate_identity(pr, plan, base)?;
    let prior_head =
        allow_previous_head && p.previous_commit_sha.as_deref() == Some(pr.head_ref_oid.as_str());
    let desired_content = pr.title == plan.title && pr.body == plan.body;
    if !pr.is_draft
        || (pr.head_ref_oid != plan.commit_sha && !prior_head)
        || (!desired_content && !known_pull_request(p).is_some_and(|v| content_matches(pr, v)))
    {
        bail!(
            "checkpoint draft source or text changed outside the persisted publication; preserve the human edit"
        );
    }
    Ok(())
}

fn edit_pull_request(
    github_cli: &Path,
    plan: &PublicationTarget,
    number: i64,
    body_file: &Path,
) -> Result<()> {
    gh_run(
        github_cli,
        &[
            "pr",
            "edit",
            &number.to_string(),
            "--repo",
            &plan.target_repository,
            "--title",
            &plan.title,
            "--body-file",
            path_text(body_file)?,
        ],
    )
}

fn draft_action(pr: &PullRequestView) -> ActiveCheckpointAction {
    ActiveCheckpointAction::DraftPublished {
        number: pr.number,
        node_id: pr.id.clone(),
        url: pr.url.clone(),
        head_sha: pr.head_ref_oid.clone(),
        head_ref: pr.head_ref_name.clone(),
        base_ref: pr.base_ref_name.clone(),
        head_repository_owner: pr.head_repository_owner.login.clone(),
        is_cross_repository: pr.is_cross_repository,
        draft: pr.is_draft,
        state: pr.state.clone(),
        auto_merge_enabled: pr.auto_merge_request.is_some(),
        title: pr.title.clone(),
        body: pr.body.clone(),
    }
}

/// Promotion only runs inside the existing verifier/review-authorized final lease.
pub(super) async fn promote(
    client: &Client,
    server: &str,
    args: &FactoryPublishArgs,
    plan: &PublicationPlan,
    response: &mut PullRequestPublicationResponse,
    base: &str,
    workspace: &TemporaryPublisherWorkspace,
) -> Result<PullRequestView> {
    let token = response
        .publisher_token
        .context("publication has no active trusted-publisher token")?;
    let checkpoint: ActiveCheckpointPublication =
        serde_json::from_value(response.publication.provenance["active_checkpoint"].clone())
            .context("final publication omitted its adopted checkpoint")?;
    let known = checkpoint
        .pull_request
        .as_ref()
        .context("adopted checkpoint omitted its draft PR")?;
    let mut pr = read_known_pull_request(&args.github_cli, plan, known)?;
    validate_promotion(&pr, plan, base, known)?;
    if pr.title != plan.title || pr.body != plan.body {
        renew_publication(
            client,
            server,
            args,
            plan,
            response,
            token,
            "checkpoint-final-body",
        )
        .await?;
        ensure_remote_branch(&workspace.repository, plan)?;
        pr = read_known_pull_request(&args.github_cli, plan, known)?;
        validate_promotion(&pr, plan, base, known)?;
        let edit = edit_pull_request(&args.github_cli, plan, pr.number, &workspace.body);
        pr = read_known_pull_request(&args.github_cli, plan, known)?;
        if let Err(error) = edit
            && (pr.title != plan.title || pr.body != plan.body)
        {
            return Err(error);
        }
        validate_promotion(&pr, plan, base, known)?;
        test_crash("after_checkpoint_final_body");
    }
    if pr.title != plan.title || pr.body != plan.body {
        bail!("final PR text does not match authorized completion evidence");
    }
    if pr.is_draft {
        renew_publication(
            client,
            server,
            args,
            plan,
            response,
            token,
            "checkpoint-ready-for-review",
        )
        .await?;
        ensure_remote_branch(&workspace.repository, plan)?;
        pr = read_known_pull_request(&args.github_cli, plan, known)?;
        validate_promotion(&pr, plan, base, known)?;
        if pr.title != plan.title || pr.body != plan.body {
            bail!("final PR text changed before promotion");
        }
        let ready = gh_run(
            &args.github_cli,
            &[
                "pr",
                "ready",
                &pr.number.to_string(),
                "--repo",
                &plan.target_repository,
            ],
        );
        pr = read_known_pull_request(&args.github_cli, plan, known)?;
        if let Err(error) = ready
            && pr.is_draft
        {
            return Err(error);
        }
        test_crash("after_checkpoint_ready_remote");
    }
    ensure_remote_pull_request_matches(&pr, plan, base)?;
    Ok(pr)
}

fn validate_promotion(
    pr: &PullRequestView,
    plan: &PublicationTarget,
    base: &str,
    known: &Value,
) -> Result<()> {
    validate_identity(pr, plan, base)?;
    let final_content = pr.title == plan.title && pr.body == plan.body;
    if pr.head_ref_oid != plan.commit_sha
        || (!final_content && (!pr.is_draft || !content_matches(pr, known)))
    {
        bail!("adopted draft was changed outside final publication authority");
    }
    Ok(())
}
