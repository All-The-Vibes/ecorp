//! Shared PR text has no native conditional update. Evidence is append-only;
//! retries discover an exact authored comment before creating another one.
use super::*;
use crony_domain::{PublicationEvidenceComment, PublicationPullRequestSnapshot};

#[derive(Deserialize)]
struct GithubActor {
    id: i64,
    login: String,
}

#[derive(Deserialize)]
struct GithubComment {
    id: i64,
    node_id: String,
    html_url: String,
    user: GithubActor,
    body: String,
}

fn authored_comments(
    github_cli: &Path,
    repository: &str,
    number: i64,
) -> Result<Vec<PublicationEvidenceComment>> {
    let actor: GithubActor = serde_json::from_value(gh_json(github_cli, &["api", "user"])?)
        .context("read authenticated GitHub publisher identity")?;
    if actor.id <= 0 || actor.login.is_empty() || number <= 0 {
        bail!("GitHub publisher or PR identity is missing");
    }
    let mut result = Vec::new();
    // Fail closed if an exceptional discussion cannot be inspected within this
    // bounded operation. Never treat a truncated inventory as an absent comment.
    for page in 1..=100 {
        let endpoint =
            format!("repos/{repository}/issues/{number}/comments?per_page=100&page={page}");
        let comments: Vec<GithubComment> =
            serde_json::from_value(gh_json(github_cli, &["api", &endpoint])?)
                .context("read publication evidence comment page")?;
        let complete = comments.len() < 100;
        result.extend(
            comments
                .into_iter()
                .filter(|comment| {
                    comment.user.id == actor.id
                        && comment.user.login.eq_ignore_ascii_case(&actor.login)
                })
                .map(|comment| PublicationEvidenceComment {
                    id: comment.id,
                    node_id: comment.node_id,
                    url: comment.html_url,
                    author_id: comment.user.id,
                    author_login: comment.user.login,
                    body: comment.body,
                }),
        );
        if complete {
            return Ok(result);
        }
    }
    bail!("publication comment inventory exceeds the bounded inspection limit; no comment written")
}

fn find(
    github_cli: &Path,
    repository: &str,
    number: i64,
    body: &str,
) -> Result<Option<PublicationEvidenceComment>> {
    Ok(authored_comments(github_cli, repository, number)?
        .into_iter()
        .find(|comment| comment.validate(repository, number, body).is_ok()))
}

pub(super) fn verify(
    github_cli: &Path,
    repository: &str,
    number: i64,
    expected: &PublicationEvidenceComment,
    body: &str,
) -> Result<()> {
    expected
        .validate(repository, number, body)
        .map_err(anyhow::Error::msg)?;
    if !authored_comments(github_cli, repository, number)?
        .iter()
        .any(|comment| comment == expected)
    {
        bail!(
            "persisted publication comment changed, disappeared or has another authenticated author"
        );
    }
    Ok(())
}

pub(super) fn append_or_observe(
    github_cli: &Path,
    repository: &str,
    pr: &PullRequestView,
    body: &str,
    workspace: &TemporaryPublisherWorkspace,
) -> Result<PublicationEvidenceComment> {
    if body.len() > 65_536 || body.contains('\0') {
        bail!("publication evidence exceeds native GitHub comment bounds");
    }
    let expected = PublicationPullRequestSnapshot::from(pr);
    let before =
        active_checkpoint::read_repository_pull_request(github_cli, repository, pr.number)?;
    if PublicationPullRequestSnapshot::from(&before) != expected {
        bail!("PR source or shared text changed before appending evidence");
    }
    let comment = match find(github_cli, repository, pr.number, body)? {
        Some(comment) => comment,
        None => {
            let file = workspace.root.join("publication-evidence.md");
            fs::write(&file, body.as_bytes()).context("write source-bound publication evidence")?;
            let result = gh_run(
                github_cli,
                &[
                    "pr",
                    "comment",
                    &pr.number.to_string(),
                    "--repo",
                    repository,
                    "--body-file",
                    path_text(&file)?,
                ],
            );
            // A lost response can be reconciled by exact authored content. A
            // still in-flight request may later duplicate a comment: GitHub
            // supplies no idempotency key, so no stronger guarantee is claimed.
            match find(github_cli, repository, pr.number, body)? {
                Some(comment) => comment,
                None => {
                    result.context("append publication evidence comment")?;
                    bail!("GitHub did not expose the appended publication evidence");
                }
            }
        }
    };
    let after = active_checkpoint::read_repository_pull_request(github_cli, repository, pr.number)?;
    if PublicationPullRequestSnapshot::from(&after) != expected {
        bail!(
            "PR source or shared text changed while appending evidence; preserve collaborator changes"
        );
    }
    Ok(comment)
}
