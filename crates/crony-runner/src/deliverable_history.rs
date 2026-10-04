//! Checkpoint bundles retain provider commits, including merged side histories.
//! Validate every retained tree against the authorized base before any verification or export.

use std::{collections::BTreeSet, ffi::OsString};

use anyhow::{Context, Result, anyhow, bail};
use tokio::{process::Command, time::Instant};

use super::{GIT_TIMEOUT, PreparedDeliverable, verification};

const MAX_COMMITS: usize = 256;

pub(super) async fn validate(prepared: &PreparedDeliverable, write_scope: &[String]) -> Result<()> {
    let deadline = Instant::now() + GIT_TIMEOUT;
    let base = &prepared.workspace.base_commit;
    if git(
        prepared,
        &["rev-parse".into(), "--is-shallow-repository".into()],
        &[],
        deadline,
    )
    .await?
        != b"false\n"
    {
        bail!("checkpoint history requires a complete, non-shallow repository");
    }
    git(
        prepared,
        &[
            "merge-base".into(),
            "--is-ancestor".into(),
            base.into(),
            prepared.original_head.clone().into(),
        ],
        &[],
        deadline,
    )
    .await
    .context("original checkpoint HEAD must descend from its authorized base")?;
    let commits = git(
        prepared,
        &[
            "rev-list".into(),
            format!("--max-count={}", MAX_COMMITS + 1).into(),
            prepared.original_head.clone().into(),
            format!("^{base}").into(),
            "--".into(),
        ],
        &[],
        deadline,
    )
    .await?;
    let commits = std::str::from_utf8(&commits)?.lines().collect::<Vec<_>>();
    if commits.len() > MAX_COMMITS {
        bail!(
            "checkpoint retains more than {MAX_COMMITS} commits; bounded history validation cannot accept it"
        );
    }
    if commits.is_empty() {
        return Ok(());
    }
    let mut input = String::new();
    for commit in commits {
        if !matches!(commit.len(), 40 | 64)
            || commit.len() != base.len()
            || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("native history enumeration returned an invalid commit identity");
        }
        // Native diff-tree --stdin treats the second commit as the first commit's parent.
        // Compare every retained commit against the same base; never simplify to first-parent
        // or the final tree, which would omit added-then-deleted excluded contents.
        input.push_str(&format!("{commit} {base}\n"));
    }
    let output = git(
        prepared,
        &[
            "diff-tree",
            "--stdin",
            "--no-commit-id",
            "--raw",
            "-r",
            "-z",
            "-m",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-abbrev",
        ]
        .map(OsString::from),
        input.as_bytes(),
        deadline,
    )
    .await?;
    let excluded = provider_paths(prepared, deadline).await?;
    validate_changes(&output, &prepared.spec, write_scope, &excluded)
}

fn validate_changes(
    output: &[u8],
    spec: &crony_domain::DeliverableSpec,
    write_scope: &[String],
    excluded: &BTreeSet<String>,
) -> Result<()> {
    if output.is_empty() {
        return super::reject_out_of_scope_changes(&[], write_scope);
    }
    let mut fields = output
        .strip_suffix(&[0])
        .context("native history diff is not NUL-terminated")?
        .split(|byte| *byte == 0);
    let mut changes = Vec::new();
    while let Some(header) = fields.next() {
        let parts = std::str::from_utf8(header)?
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if parts.len() != 5
            || !parts[0].starts_with(':')
            || !matches!(parts[4], "A" | "D" | "M" | "T")
        {
            bail!("native history diff contains an unsupported record");
        }
        let path = std::str::from_utf8(
            fields
                .next()
                .context("native history diff omitted its path")?,
        )?;
        super::validate_relative(path)?;
        if !super::path_is_selected(spec, path) {
            bail!("retained history contains an unselected deliverable path: {path}");
        }
        if super::sensitive_path(path) || excluded.contains(&exclusion_key(path)) {
            bail!("retained history contains an excluded path: {path}");
        }
        if !matches!(parts[1], "100644" | "100755") && !(parts[4] == "D" && parts[1] == "000000") {
            bail!(
                "retained history contains an unsafe file mode {}: {path}",
                parts[1]
            );
        }
        changes.push((parts[4].to_owned(), path.to_owned()));
    }
    super::reject_out_of_scope_changes(&changes, write_scope)
}

fn exclusion_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

async fn provider_paths(
    prepared: &PreparedDeliverable,
    deadline: Instant,
) -> Result<BTreeSet<String>> {
    let mut excluded = BTreeSet::new();
    for artifact in &prepared.provider_artifacts {
        // Keep lexical names even when a provider file or one of its directories was deleted.
        // Also resolve existing aliases so an alternate spelling cannot hide an exclusion.
        let path = if artifact.path.is_absolute() {
            artifact.path.clone()
        } else {
            prepared.workspace_root.join(&artifact.path)
        };
        let mut candidates = vec![crate::workspace::normalize_path(path.clone())];
        let mut ancestor = path.as_path();
        let mut missing = Vec::new();
        loop {
            match tokio::time::timeout_at(deadline, tokio::fs::canonicalize(ancestor))
                .await
                .context("checkpoint history path resolution timed out")?
            {
                Ok(mut resolved) => {
                    for name in missing.iter().rev() {
                        resolved.push(name);
                    }
                    candidates.push(crate::workspace::normalize_path(resolved));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let Some(name) = ancestor.file_name() else {
                        break;
                    };
                    missing.push(name.to_owned());
                    let Some(parent) = ancestor.parent() else {
                        break;
                    };
                    ancestor = parent;
                }
                Err(error) => return Err(error).context("resolve excluded provider history path"),
            }
        }
        for candidate in candidates {
            for root in [&prepared.workspace_root, &prepared.workspace.path] {
                let root = crate::workspace::normalize_path(root.clone());
                if let Ok(relative) = candidate.strip_prefix(root) {
                    excluded.insert(exclusion_key(&super::portable_path(relative)?));
                }
            }
        }
    }
    Ok(excluded)
}

async fn git(
    prepared: &PreparedDeliverable,
    args: &[OsString],
    input: &[u8],
    deadline: Instant,
) -> Result<Vec<u8>> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .context("checkpoint history validation timed out")?;
    let mut command = Command::new("git");
    verification::isolate_git_environment(&mut command);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
        .current_dir(&prepared.workspace_root)
        .args(args)
        .kill_on_drop(true);
    let output = verification::run_private_git(&mut command, input, remaining).await?;
    // diff-tree can report malformed stdin on stderr while returning zero. Fail closed.
    if !output.status.success() || !output.stderr.is_empty() {
        return Err(anyhow!(
            "native checkpoint history command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}
