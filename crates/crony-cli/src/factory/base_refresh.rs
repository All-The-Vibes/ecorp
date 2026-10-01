//! Operator control over the native base-refresh aggregate. This client never
//! supplies replacement checks, executes a provider, or mutates a source checkout.
use super::*;
use anyhow::ensure;
use clap::Subcommand;
use crony_domain::{
    AuthorizeFactoryBaseRefresh, FactoryBaseRefresh, FactoryWorkItem, SettleFactoryBaseRefresh,
    WorkspaceSetupOperation, WorkspaceSetupStatus,
};

#[derive(Debug, Args)]
pub(crate) struct BaseRefreshArgs {
    corp_id: Uuid,
    actor_id: Uuid,
    work_item_id: Uuid,
    #[arg(long, env = "ECORP_GITHUB_CLI", default_value = "gh", global = true)]
    github_cli: PathBuf,
    /// Bound the native connection check; a timeout does not authorize a refresh.
    #[arg(long, default_value_t = 60, value_parser = clap::value_parser!(u64).range(1..=300), global = true)]
    wait_seconds: u64,
    #[command(subcommand)]
    operation: Operation,
}

#[derive(Debug, Subcommand)]
enum Operation {
    /// Read the selected source, current version, and durable refresh history.
    List,
    /// Reconstruct the exact verified delta and rerun its complete saved policy.
    Authorize {
        #[command(flatten)]
        control: Control,
        #[arg(long)]
        source_deliverable_id: Uuid,
        /// Full immutable lowercase Git object ID of the advanced publication base.
        #[arg(long)]
        new_base_commit: String,
    },
    /// Select the refreshed result only after verification and independent review.
    Adopt {
        refresh_id: Uuid,
        #[command(flatten)]
        control: Control,
    },
    /// Release the publication fence after the refresh run has become terminal.
    Abandon {
        refresh_id: Uuid,
        #[command(flatten)]
        control: Control,
    },
}

#[derive(Debug, Args)]
struct Control {
    /// Prefer ECORP_FACTORY_CLAIM_TOKEN so the token stays out of shell history.
    #[arg(long, env = "ECORP_FACTORY_CLAIM_TOKEN", hide_env_values = true)]
    claim_token: Uuid,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    expected_version: i64,
    /// Reuse this UUID and every original argument when retrying a lost response.
    #[arg(long)]
    operation_key: Uuid,
    #[arg(long)]
    observed_source_revision: String,
    #[arg(long)]
    reason: String,
}

impl Control {
    fn settlement(&self, actor_id: Uuid) -> SettleFactoryBaseRefresh {
        SettleFactoryBaseRefresh {
            actor_id,
            claim_token: self.claim_token,
            expected_version: self.expected_version,
            idempotency_key: self.operation_key,
            observed_source_revision: self.observed_source_revision.clone(),
            reason: self.reason.clone(),
        }
    }
}

async fn context(client: &Client, server: &str, args: &BaseRefreshArgs) -> Result<Value> {
    server_json(
        client,
        Method::GET,
        format!(
            "{server}/api/corps/{}/factory/work-items/{}/publication-context?actor_id={}",
            args.corp_id, args.work_item_id, args.actor_id
        ),
        None,
    )
    .await
}

pub(crate) async fn run(client: &Client, server: &str, args: BaseRefreshArgs) -> Result<Value> {
    let server = server.trim_end_matches('/');
    let endpoint = format!(
        "{server}/api/corps/{}/factory/work-items/{}/base-refreshes",
        args.corp_id, args.work_item_id
    );
    let refreshes: Vec<FactoryBaseRefresh> = serde_json::from_value(
        server_json(
            client,
            Method::GET,
            format!("{endpoint}?actor_id={}", args.actor_id),
            None,
        )
        .await?,
    )
    .context("decode authorized base-refresh history")?;
    ensure!(
        refreshes
            .iter()
            .all(|refresh| refresh.corp_id == args.corp_id
                && refresh.factory_work_item_id == args.work_item_id),
        "base-refresh response scope mismatch"
    );
    let (control, request, endpoint, replayed) = match &args.operation {
        Operation::List => {
            return Ok(json!({
                "context": context(client, server, &args).await?,
                "base_refreshes": refreshes,
            }));
        }
        Operation::Authorize {
            control,
            source_deliverable_id,
            new_base_commit,
        } => {
            validate_source_base_commit(new_base_commit)?;
            ensure!(
                new_base_commit == &new_base_commit.to_ascii_lowercase(),
                "base commit must be lowercase"
            );
            let request = AuthorizeFactoryBaseRefresh {
                actor_id: args.actor_id,
                claim_token: control.claim_token,
                expected_version: control.expected_version,
                idempotency_key: control.operation_key,
                source_deliverable_id: *source_deliverable_id,
                new_base_commit: new_base_commit.clone(),
                observed_source_revision: control.observed_source_revision.clone(),
                reason: control.reason.clone(),
            };
            let replayed = refreshes.iter().any(|refresh| {
                refresh.authorized_by == args.actor_id
                    && refresh.idempotency_key == control.operation_key
            });
            (control, serde_json::to_value(request)?, endpoint, replayed)
        }
        Operation::Adopt {
            refresh_id,
            control,
        }
        | Operation::Abandon {
            refresh_id,
            control,
        } => {
            let action = if matches!(&args.operation, Operation::Adopt { .. }) {
                "adopt"
            } else {
                "abandon"
            };
            let replayed = refreshes.iter().any(|refresh| {
                refresh.id == *refresh_id
                    && refresh.settled_by == Some(args.actor_id)
                    && refresh.settlement_key == Some(control.operation_key)
            });
            (
                control,
                serde_json::to_value(control.settlement(args.actor_id))?,
                format!("{endpoint}/{refresh_id}/{action}"),
                replayed,
            )
        }
    };
    ensure!(
        !control.operation_key.is_nil(),
        "operation key must not be nil"
    );
    // A saved identifier is only a replay hint. The server still compares every
    // original argument and rechecks caller authorization before returning it.
    if !replayed {
        let context = context(client, server, &args).await?;
        let item: FactoryWorkItem = serde_json::from_value(context["work_item"].clone())
            .context("decode selected Factory work item")?;
        ensure!(
            item.corp_id == args.corp_id
                && item.id == args.work_item_id
                && item.claim_owner_id == args.actor_id
                && item.version == control.expected_version,
            "current Factory claim or version differs from the explicit request"
        );
        if !matches!(&args.operation, Operation::Abandon { .. }) {
            check_issue(&args.github_cli, &item, &control.observed_source_revision)?;
        }
        if let Operation::Authorize {
            new_base_commit, ..
        } = &args.operation
        {
            let repository = repository(&item)?;
            let (source_ref, base_ref) = base_refs(&item)?;
            crate::publish::preflight_publication_base(&repository, base_ref, new_base_commit)?;
            if let Some(connection) = value_optional_uuid(&item.policy, "/workspace_connection_id")?
            {
                check_connection(
                    client,
                    server,
                    &args,
                    connection,
                    &repository,
                    source_ref,
                    new_base_commit,
                )
                .await?;
            }
            // A native connection check may take time. Re-read issue authority
            // and the remote base immediately before the durable authorization.
            check_issue(&args.github_cli, &item, &control.observed_source_revision)?;
            crate::publish::preflight_publication_base(&repository, base_ref, new_base_commit)?;
        }
    }
    server_json(client, Method::POST, endpoint, Some(request)).await
}

fn base_refs(item: &FactoryWorkItem) -> Result<(&str, &str)> {
    let source = item
        .policy
        .get("source_base_ref")
        .and_then(Value::as_str)
        .context("source base missing from Factory policy")?;
    validate_source_base_ref(source)?;
    let publication = item
        .policy
        .pointer("/publication/base_ref")
        .and_then(Value::as_str)
        .context("publication base missing from Factory policy")?;
    publication_base_branch(publication)?;
    Ok((source, publication))
}

fn repository(item: &FactoryWorkItem) -> Result<String> {
    let owner = normalize_github_component(&item.source_repository_owner, "repository owner")?;
    let name = normalize_github_component(&item.source_repository_name, "repository name")?;
    Ok(format!("{owner}/{name}"))
}

fn check_issue(github_cli: &Path, item: &FactoryWorkItem, revision: &str) -> Result<()> {
    let repository = repository(item)?;
    let issue = load_issue(
        github_cli,
        &repository,
        item.source_issue_number,
        &quota::BudgetState::default(),
    )?;
    validate_issue(item, &repository, revision, &issue)
}

fn validate_issue(
    item: &FactoryWorkItem,
    repository: &str,
    revision: &str,
    issue: &IssueView,
) -> Result<()> {
    ensure!(
        issue.state == "OPEN"
            && issue.number == item.source_issue_number
            && issue.id == item.source_issue_node_id
            && issue.updated_at == revision
            && factory_issue_url_matches(&issue.url, repository, issue.number)
            && factory_issue_url_matches(&item.source_issue_url, repository, issue.number),
        "GitHub issue is no longer open at the explicitly observed revision and repository identity"
    );
    Ok(())
}

async fn check_connection(
    client: &Client,
    server: &str,
    args: &BaseRefreshArgs,
    connection: Uuid,
    repository: &str,
    base_ref: &str,
    base: &str,
) -> Result<()> {
    let result = server_json(client, Method::POST,
        format!("{server}/api/corps/{}/connections/{connection}/check", args.corp_id),
        Some(json!({"actor_id":args.actor_id,"idempotency_key":format!("base-refresh-check:{}", Uuid::new_v4())})),
    ).await?;
    let mut operation: WorkspaceSetupOperation =
        serde_json::from_value(result["operation"].clone())
            .context("decode native connection check")?;
    let operation_id = operation.id;
    let deadline = Instant::now() + Duration::from_secs(args.wait_seconds);
    loop {
        ensure!(
            operation.id == operation_id
                && operation.corp_id == args.corp_id
                && operation.actor_id == args.actor_id
                && operation.connection_id == Some(connection)
                && operation.kind == "test",
            "native connection check scope mismatch"
        );
        match operation.status {
            WorkspaceSetupStatus::Succeeded | WorkspaceSetupStatus::Failed => {
                let report = operation
                    .report
                    .context("native connection check omitted its result")?;
                // Setup separately reports provider readiness. A terminal
                // native receipt with this exact source is sufficient for a
                // verification-only refresh, including a signed-out model.
                ensure!(
                    report.status == operation.status
                        && report.sign_in.is_none()
                        && report.source.as_ref().is_some_and(|source| {
                            source.repository.eq_ignore_ascii_case(repository)
                                && source.base_ref == base_ref
                                && source.base_commit == base
                        }),
                    "native connection has no completed source check at the authorized immutable base"
                );
                return Ok(());
            }
            WorkspaceSetupStatus::Queued | WorkspaceSetupStatus::Running => {
                ensure!(
                    Instant::now() < deadline && operation.expires_at > Utc::now(),
                    "native connection check {operation_id} is still pending or expired; no refresh was authorized"
                );
            }
            _ => bail!(
                "native connection check {operation_id} ended as {}; no refresh was authorized",
                operation.status.as_str()
            ),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        operation = serde_json::from_value(
            server_json(
                client,
                Method::GET,
                format!(
                    "{server}/api/corps/{}/setup-operations/{operation_id}?actor_id={}",
                    args.corp_id, args.actor_id
                ),
                None,
            )
            .await?,
        )
        .context("decode native connection check progress")?;
    }
}

#[cfg(test)]
#[path = "base_refresh_tests.rs"]
mod tests;
