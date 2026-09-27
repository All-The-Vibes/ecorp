//! Verify native Git blobs, not the potentially differently normalized physical worktree.
//! The provider harness has already stopped; its execution/permission engine is not duplicated.

use std::{
    collections::BTreeSet,
    ffi::OsString,
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Output, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, Metadata, OpenOptions};
use crony_domain::{VerificationPolicy, VerifierCheck};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::watch,
};

use super::{PreparedDeliverable, git_output, git_text_with_env, portable_path, sensitive_path};
use crate::{
    adapter::AdapterArtifact,
    verifier::{self, CancellableCheckResult, SourceVerification, VerificationReport},
    workspace::{self, VerificationSnapshot},
};

#[cfg(windows)]
use crate::adapter::process_tree::{OwnedProcessTree, OwnedProcessTreeSpawn};

const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_GIT_OUTPUT: u64 = 16 * 1024 * 1024;
// Candidate and base blobs, plus bounded tree/commit/pack framing. Never buffer a pack in memory.
const MAX_GIT_PACK_BYTES: u64 = 2 * MAX_BYTES + 64 * 1024 * 1024;

#[derive(Debug)]
struct SourceFile {
    path: String,
    mode: String,
    object: String,
    bytes: u64,
    sha256: String,
}

pub(super) async fn verify(
    prepared: &PreparedDeliverable,
    policy: &VerificationPolicy,
    artifacts: &[AdapterArtifact],
    cancellation: &mut watch::Receiver<bool>,
) -> Result<Option<VerificationReport>> {
    if *cancellation.borrow() {
        return Ok(None);
    }
    let mut baseline = workspace::empty_verification_snapshot(prepared.run_id).await?;
    let mut active = None;
    let result = verify_inner(
        prepared,
        policy,
        artifacts,
        cancellation,
        &baseline,
        &mut active,
    )
    .await;
    // Await cleanup even on rejection/cancellation. Drop is only an emergency fallback.
    let check_cleanup = match active.as_mut() {
        Some(snapshot) => snapshot.cleanup().await,
        None => Ok(()),
    };
    let baseline_cleanup = baseline.cleanup().await;
    let cleanup_errors = [check_cleanup.err(), baseline_cleanup.err()]
        .into_iter()
        .flatten()
        .map(|error| format!("{error:#}"))
        .collect::<Vec<_>>();
    if cleanup_errors.is_empty() {
        result
    } else {
        let detail = format!(
            "canonical verification cleanup also failed: {}",
            cleanup_errors.join("; ")
        );
        match result {
            Err(error) => Err(error.context(detail)),
            Ok(_) => bail!(detail),
        }
    }
}

async fn verify_inner(
    prepared: &PreparedDeliverable,
    policy: &VerificationPolicy,
    artifacts: &[AdapterArtifact],
    cancellation: &mut watch::Receiver<bool>,
    baseline: &VerificationSnapshot,
    active: &mut Option<VerificationSnapshot>,
) -> Result<Option<VerificationReport>> {
    let candidate_commit = git_text_with_env(
        &prepared.workspace_root,
        &prepared.index,
        &[
            "commit-tree".into(),
            prepared.tree.clone().into(),
            "-p".into(),
            prepared.workspace.base_commit.clone().into(),
            "-m".into(),
            "ECorp temporary verification candidate (tree identity only)".into(),
        ],
        &[
            ("GIT_AUTHOR_NAME", "ECorp Runner"),
            ("GIT_AUTHOR_EMAIL", "runner@ecorp.invalid"),
            ("GIT_COMMITTER_NAME", "ECorp Runner"),
            ("GIT_COMMITTER_EMAIL", "runner@ecorp.invalid"),
        ],
    )
    .await?;
    // Independent objects, index, config and HEAD. Never borrow source .git, alternates or hooks.
    private_git(
        baseline.path(),
        &[
            "init".into(),
            "--quiet".into(),
            "--template=".into(),
            format!(
                "--object-format={}",
                if prepared.tree.len() == 64 {
                    "sha256"
                } else {
                    "sha1"
                }
            )
            .into(),
        ],
        &[],
    )
    .await?;
    transfer_canonical_objects(prepared, baseline.path(), &candidate_commit).await?;
    tokio::fs::write(
        baseline.path().join(".git/shallow"),
        format!("{}\n", prepared.workspace.base_commit),
    )
    .await
    .context("record private canonical history boundary")?;
    private_git(
        baseline.path(),
        &[
            "update-ref".into(),
            "--no-deref".into(),
            "HEAD".into(),
            candidate_commit.clone().into(),
        ],
        &[],
    )
    .await?;
    private_git(
        baseline.path(),
        &["read-tree".into(), prepared.tree.clone().into()],
        &[],
    )
    .await?;
    let mut files = tree_files(baseline.path(), &prepared.tree).await?;
    let mut links = materialize(baseline.path(), &mut files).await?;
    if *cancellation.borrow() {
        return Ok(None);
    }
    let (ignored_input_sha256, ignored_input_count, ignored_input_bytes) =
        copy_ignored_inputs(prepared, baseline.path(), &files, &mut links).await?;
    materialize_links(baseline.path(), links)?;
    let source = SourceVerification {
        tree: prepared.tree.clone(),
        base_commit: prepared.workspace.base_commit.clone(),
        candidate_commit,
        ignored_input_sha256,
        ignored_input_count,
        ignored_input_bytes,
    };
    let mut checks = Vec::with_capacity(policy.checks.len());
    for (index, check) in policy.checks.iter().enumerate() {
        if *cancellation.borrow() {
            return Ok(None);
        }
        let mut result = if matches!(
            check,
            VerifierCheck::Command { .. } | VerifierCheck::Test { .. }
        ) {
            *active =
                Some(workspace::canonical_verification_snapshot(baseline, prepared.run_id).await?);
            let snapshot = active
                .as_mut()
                .context("canonical check snapshot is missing")?;
            let result = verifier::run_canonical_check_cancellable(
                index as i32,
                check,
                snapshot.path(),
                artifacts,
                cancellation,
            )
            .await;
            let integrity =
                check_source_integrity(baseline.path(), snapshot.path(), &files, &source).await;
            snapshot
                .cleanup()
                .await
                .context("clean completed canonical check snapshot")?;
            *active = None;
            match result {
                CancellableCheckResult::Cancelled => return Ok(None),
                CancellableCheckResult::Completed(mut result) => {
                    if let Err(error) = integrity {
                        result.passed = false;
                        result.summary =
                            format!("canonical source changed during verification: {error:#}");
                        result.payload["source_integrity_error"] = json!(format!("{error:#}"));
                    }
                    result
                }
            }
        } else {
            match verifier::run_check_cancellable(
                index as i32,
                check,
                baseline.path(),
                artifacts,
                cancellation,
            )
            .await
            {
                CancellableCheckResult::Cancelled => return Ok(None),
                CancellableCheckResult::Completed(result) => result,
            }
        };
        result.payload["source"] = serde_json::to_value(&source)?;
        checks.push(result);
    }
    let mut report = verifier::verification_report(policy, checks);
    report.source = Some(source);
    Ok(Some(report))
}

async fn transfer_canonical_objects(
    prepared: &PreparedDeliverable,
    snapshot: &Path,
    candidate_commit: &str,
) -> Result<()> {
    // A named pack makes Git finalize files from the source object database. That rename
    // fails when checkout and snapshot are on different volumes. Stream to an exclusively
    // created snapshot file, await the producer, then let native index-pack install locally.
    // Only candidate + base history enters; source config, refs, hooks and alternates do not.
    let transfer_path = snapshot.join(".git/ecorp-transfer.pack");
    let mut transfer = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&transfer_path)
        .await
        .context("create owned canonical pack transfer")?;
    let revisions = format!(
        "--shallow {}\n{}\n",
        prepared.workspace.base_commit, candidate_commit
    );
    let mut pack = git_command(&prepared.workspace_root);
    pack.args([
        "pack-objects",
        "--revs",
        "--shallow",
        "--quiet",
        // Temporary snapshots need neither delta searches nor recompression.
        "--window=0",
        "--compression=0",
        "--stdout",
    ]);
    let (status, errors) = run_private_git_stream(
        &mut pack,
        revisions.as_bytes(),
        &mut transfer,
        MAX_GIT_PACK_BYTES,
        super::GIT_TIMEOUT,
    )
    .await
    .context("pack independent canonical source objects")?;
    if !status.success() {
        bail!(
            "pack canonical objects failed: {}",
            String::from_utf8_lossy(&errors).trim()
        );
    }
    drop(transfer);
    let input = tokio::fs::File::open(&transfer_path).await?;
    let mut index = git_command(snapshot);
    index.args(["index-pack", "--stdin", "--threads=1"]);
    let (status, errors) = run_private_git_stream(
        &mut index,
        input,
        &mut Vec::new(),
        MAX_GIT_OUTPUT,
        super::GIT_TIMEOUT,
    )
    .await
    .context("install independent canonical source objects")?;
    if !status.success() {
        bail!(
            "index canonical objects failed: {}",
            String::from_utf8_lossy(&errors).trim()
        );
    }
    // Every process and file handle is released before removing this snapshot-owned scratch.
    tokio::fs::remove_file(transfer_path)
        .await
        .context("remove canonical pack transfer")?;
    Ok(())
}

/// Sanitize Git routing/config only. This is not a verifier command or an OS sandbox.
pub(super) fn clear_git_environment(command: &mut Command) {
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
}

pub(crate) fn isolate_git_environment(command: &mut Command) {
    clear_git_environment(command);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    isolate_git_environment(&mut command);
    command
        .current_dir(root)
        .args([
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "gc.auto=0",
        ])
        .kill_on_drop(true);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
}

async fn private_git(root: &Path, args: &[OsString], input: &[u8]) -> Result<Vec<u8>> {
    private_git_with_index(root, args, input, None).await
}

async fn private_git_with_index(
    root: &Path,
    args: &[OsString],
    input: &[u8],
    index: Option<&Path>,
) -> Result<Vec<u8>> {
    let mut command = git_command(root);
    if let Some(index) = index {
        command.env(
            "GIT_INDEX_FILE",
            workspace::normalize_path(index.to_path_buf()),
        );
    }
    command.args(args);
    let output = run_private_git(&mut command, input, super::GIT_TIMEOUT).await?;
    // check-ignore returns 1 for a successful query with no ignored paths.
    if !output.status.success()
        && !(args.first().is_some_and(|arg| arg == "check-ignore")
            && output.status.code() == Some(1))
    {
        bail!(
            "private Git operation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

/// Own trusted Git children until their pipes and workspace handles are released.
/// Windows reuses the runner's native Job Object adapter; this adds no harness permissions.
struct PrivateGitProcess {
    #[cfg(windows)]
    tree: OwnedProcessTree,
    #[cfg(not(windows))]
    child: tokio::process::Child,
}

impl PrivateGitProcess {
    async fn spawn(command: &mut Command) -> Result<Self> {
        #[cfg(windows)]
        {
            let tree = match OwnedProcessTree::spawn(command)? {
                OwnedProcessTreeSpawn::Ready(tree) => tree,
                OwnedProcessTreeSpawn::CleanupRequired { mut tree, error } => {
                    let cleanup = tree.terminate_and_wait().await;
                    return Err(match cleanup {
                        Ok(_) => anyhow::Error::new(error)
                            .context("private Git process ownership setup failed"),
                        Err(cleanup) => anyhow::Error::new(error).context(format!(
                            "private Git process ownership setup failed and cleanup was unverified: {cleanup}"
                        )),
                    });
                }
            };
            Ok(Self { tree })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child: command.kill_on_drop(true).spawn()?,
            })
        }
    }

    fn child_mut(&mut self) -> &mut tokio::process::Child {
        #[cfg(windows)]
        {
            self.tree.child_mut()
        }
        #[cfg(not(windows))]
        {
            &mut self.child
        }
    }

    async fn finish<T>(&mut self, result: Result<T>) -> Result<T> {
        #[cfg(windows)]
        let cleanup = self.tree.terminate_and_wait().await.map(|_| ());
        #[cfg(not(windows))]
        let cleanup = async {
            if self.child.try_wait()?.is_none() {
                self.child.start_kill()?;
                tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await??;
            }
            Ok::<_, std::io::Error>(())
        }
        .await;
        match (result, cleanup) {
            (Err(error), Err(cleanup)) => {
                Err(error.context(format!("private Git cleanup also failed: {cleanup}")))
            }
            (Ok(_), Err(cleanup)) => {
                Err(anyhow::Error::new(cleanup).context("private Git cleanup failed"))
            }
            (result, Ok(())) => result,
        }
    }
}

pub(super) async fn run_private_git(
    command: &mut Command,
    input: &[u8],
    timeout: Duration,
) -> Result<Output> {
    let mut output = Vec::new();
    let (status, stderr) =
        run_private_git_stream(command, input, &mut output, MAX_GIT_OUTPUT, timeout).await?;
    Ok(Output {
        status,
        stdout: output,
        stderr,
    })
}

async fn run_private_git_stream(
    command: &mut Command,
    input: impl AsyncRead + Unpin,
    output: &mut (impl AsyncWrite + Unpin),
    output_limit: u64,
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>)> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = PrivateGitProcess::spawn(command)
        .await
        .context("start private Git operation")?;
    let result =
        collect_private_git(process.child_mut(), input, output, output_limit, timeout).await;
    process.finish(result).await
}

async fn collect_private_git(
    child: &mut tokio::process::Child,
    mut input: impl AsyncRead + Unpin,
    output: &mut (impl AsyncWrite + Unpin),
    output_limit: u64,
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>)> {
    let mut stdin = child.stdin.take().context("Git stdin")?;
    let mut stdout = child
        .stdout
        .take()
        .context("Git stdout")?
        .take(output_limit + 1);
    let mut stderr = child.stderr.take().context("Git stderr")?.take(64 * 1024);
    let mut errors = Vec::new();
    let (status, _, _, _) = tokio::time::timeout(timeout, async {
        tokio::try_join!(
            child.wait(),
            async move {
                tokio::io::copy(&mut input, &mut stdin).await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            },
            async {
                if tokio::io::copy(&mut stdout, output).await? > output_limit {
                    return Err(std::io::Error::other(
                        "private Git output exceeds its bound",
                    ));
                }
                output.flush().await
            },
            stderr.read_to_end(&mut errors),
        )
    })
    .await
    .context("private Git operation timed out")?
    .context("private Git I/O failed")?;
    Ok((status, errors))
}

async fn tree_files(root: &Path, tree: &str) -> Result<Vec<SourceFile>> {
    let output = private_git(
        root,
        &[
            "ls-tree".into(),
            "-rzl".into(),
            "--full-tree".into(),
            tree.into(),
        ],
        &[],
    )
    .await?;
    let mut files = Vec::new();
    let mut total = 0_u64;
    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let text = std::str::from_utf8(entry).context("canonical Git path is not UTF-8")?;
        let (metadata, path) = text
            .split_once('\t')
            .context("Git tree entry has no path")?;
        super::validate_relative(path)?;
        if path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            bail!("Git control path in canonical source");
        }
        let parts = metadata.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 4
            || parts[1] != "blob"
            || !matches!(parts[0], "100644" | "100755" | "120000")
        {
            bail!("unsupported canonical Git entry: {path}");
        }
        let bytes = parts[3].parse::<u64>().context("Git blob size")?;
        total = total
            .checked_add(bytes)
            .context("canonical byte count overflow")?;
        if files.len() >= MAX_ENTRIES || total > MAX_BYTES {
            bail!("canonical source exceeds snapshot bounds");
        }
        files.push(SourceFile {
            path: path.to_owned(),
            mode: parts[0].to_owned(),
            object: parts[2].to_owned(),
            bytes,
            sha256: String::new(),
        });
    }
    Ok(files)
}

async fn materialize(root: &Path, files: &mut [SourceFile]) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut command = git_command(root);
    command
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut process = PrivateGitProcess::spawn(&mut command)
        .await
        .context("start raw Git blob reader")?;
    let result = materialize_blobs(process.child_mut(), root, files).await;
    process.finish(result).await
}

async fn materialize_blobs(
    child: &mut tokio::process::Child,
    root: &Path,
    files: &mut [SourceFile],
) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut stdin = child.stdin.take().context("blob reader stdin")?;
    let mut stdout = BufReader::new(child.stdout.take().context("blob reader stdout")?);
    let mut links = Vec::new();
    for file in files {
        let path = root.join(&file.path);
        tokio::fs::create_dir_all(path.parent().context("canonical file parent")?).await?;
        let (digest, link) = tokio::time::timeout(super::GIT_TIMEOUT, async {
            stdin
                .write_all(format!("{}\n", file.object).as_bytes())
                .await?;
            stdin.flush().await?;
            let mut header = Vec::new();
            (&mut stdout)
                .take(256)
                .read_until(b'\n', &mut header)
                .await?;
            if header != format!("{} blob {}\n", file.object, file.bytes).as_bytes() {
                bail!("unexpected raw Git blob header");
            }
            let is_link = file.mode == "120000";
            if is_link && file.bytes > 4096 {
                bail!("canonical symlink target is too long");
            }
            let mut output = if is_link {
                None
            } else {
                Some(
                    tokio::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&path)
                        .await?,
                )
            };
            let mut link = Vec::new();
            let mut digest = Sha256::new();
            let mut remaining = file.bytes;
            let mut buffer = vec![0_u8; 64 * 1024];
            while remaining > 0 {
                let count = remaining.min(buffer.len() as u64) as usize;
                stdout.read_exact(&mut buffer[..count]).await?;
                digest.update(&buffer[..count]);
                if let Some(output) = output.as_mut() {
                    output.write_all(&buffer[..count]).await?;
                } else {
                    link.extend_from_slice(&buffer[..count]);
                }
                remaining -= count as u64;
            }
            if stdout.read_u8().await? != b'\n' {
                bail!("raw Git blob omitted terminator");
            }
            Ok::<_, anyhow::Error>((hex::encode(digest.finalize()), is_link.then_some(link)))
        })
        .await
        .context("raw Git blob read timed out")??;
        file.sha256 = digest;
        if let Some(link) = link {
            let target = String::from_utf8(link).context("canonical link target is not UTF-8")?;
            #[cfg(windows)]
            if target.contains('\\') {
                bail!("canonical link target cannot be represented by Git for Windows");
            }
            links.push((path, PathBuf::from(target)));
        } else {
            #[cfg(unix)]
            tokio::fs::set_permissions(
                &path,
                std::os::unix::fs::PermissionsExt::from_mode(if file.mode == "100755" {
                    0o755
                } else {
                    0o644
                }),
            )
            .await?;
        }
    }
    drop(stdin);
    if !tokio::time::timeout(super::GIT_TIMEOUT, child.wait())
        .await??
        .success()
    {
        bail!("raw Git blob reader failed");
    }
    for (_, target) in &links {
        if target.is_absolute()
            || target
                .components()
                .any(|part| matches!(part, Component::Prefix(_) | Component::RootDir))
        {
            bail!("absolute canonical symlink target");
        }
    }
    Ok(links)
}

async fn copy_ignored_inputs(
    prepared: &PreparedDeliverable,
    root: &Path,
    files: &[SourceFile],
    links: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(String, usize, u64)> {
    let mut excluded = files
        .iter()
        .map(|file| file.path.clone())
        .collect::<BTreeSet<_>>();
    for revision in [&prepared.workspace.base_commit, &prepared.original_head] {
        let output = git_output(
            &prepared.workspace_root,
            &prepared.index,
            &[
                "ls-tree".into(),
                "-rz".into(),
                "--name-only".into(),
                revision.into(),
            ],
        )
        .await?;
        add_paths(&output.stdout, &mut excluded)?;
    }
    // Also exclude newly staged source omitted from this candidate, even if a canonical ignore
    // rule happens to match it. The real index is read only and never copied or refreshed here.
    let output = private_git(
        &prepared.workspace_root,
        &["ls-files".into(), "-z".into()],
        &[],
    )
    .await?;
    add_paths(&output, &mut excluded)?;
    for artifact in &prepared.provider_artifacts {
        if let Ok(path) = tokio::fs::canonicalize(&artifact.path).await
            && let Ok(relative) = path.strip_prefix(&prepared.workspace_root)
        {
            excluded.insert(portable_path(relative)?);
        }
    }
    let directory = prepared.workspace_directory.try_clone()?;
    let candidates = tokio::task::spawn_blocking(move || {
        let mut paths = Vec::new();
        collect_input_paths(&directory, "", &excluded, &mut paths, &mut 0)?;
        paths.sort();
        Ok::<_, anyhow::Error>(paths)
    })
    .await
    .context("join ignored-input enumeration")??;
    let input = candidates
        .iter()
        .flat_map(|path| path.bytes().chain([0]))
        .collect::<Vec<_>>();
    let ignored = private_git(
        root,
        &[
            "check-ignore".into(),
            "--no-index".into(),
            "--stdin".into(),
            "-z".into(),
        ],
        &input,
    )
    .await?;
    let mut paths = BTreeSet::new();
    add_paths(&ignored, &mut paths)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let source_bytes = files.iter().map(|file| file.bytes).sum::<u64>();
    let source_directory = &prepared.workspace_directory;
    for path in &paths {
        let destination = root.join(path);
        // Native directory capabilities and no-follow opens keep source reads inside this
        // workspace even if an ancestor is replaced after enumeration. Hold all ancestors
        // until the copy is finished; no original Git config or credential files are borrowed.
        let mut directories = vec![source_directory.try_clone()?];
        let components = path.split('/').collect::<Vec<_>>();
        for component in &components[..components.len() - 1] {
            directories.push(open_input_directory(
                directories.last().context("input root")?,
                component,
            )?);
        }
        let parent = directories.last().context("input parent")?;
        let name = components.last().context("input name")?;
        let metadata = parent.symlink_metadata(name)?;
        tokio::fs::create_dir_all(destination.parent().context("ignored-input parent")?).await?;
        let (sha256, bytes) = if input_is_link(&metadata) {
            // Read the target without following it. read_link rejects all absolute targets,
            // including internal Windows junctions; the rebasing step below checks containment.
            let target = relative_input_link_target(
                &prepared.workspace_root,
                path,
                &parent.read_link_contents(name)?,
            )?;
            let value = target
                .to_str()
                .context("ignored-input link target is not UTF-8")?;
            links.push((destination, target.clone()));
            (
                hex::encode(Sha256::digest(value.as_bytes())),
                value.len() as u64,
            )
        } else {
            if !metadata.is_file() {
                bail!("ignored input changed type: {path}");
            }
            if source_bytes
                .saturating_add(total)
                .saturating_add(metadata.len())
                > MAX_BYTES
            {
                bail!("ignored inputs exceed snapshot bounds");
            }
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            #[cfg(windows)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.share_mode(1);
            }
            let opened_file = parent.open_with(name, &options)?;
            let opened = opened_file.metadata()?;
            if !opened.is_file()
                || input_is_link(&opened)
                || (opened.dev(), opened.ino(), opened.len())
                    != (metadata.dev(), metadata.ino(), metadata.len())
            {
                bail!("ignored input changed while opening: {path}");
            }
            let source_std = opened_file.into_std();
            let permissions = source_std.metadata()?.permissions();
            let mut source_file = tokio::fs::File::from_std(source_std);
            let mut destination_file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .await?;
            let copied = tokio::io::copy(
                &mut (&mut source_file).take(metadata.len() + 1),
                &mut destination_file,
            )
            .await?;
            if copied != metadata.len() {
                bail!("ignored input changed size during copy: {path}");
            }
            drop(destination_file);
            tokio::fs::set_permissions(&destination, permissions).await?;
            (file_digest(&destination, metadata.len()).await?, copied)
        };
        total = total
            .checked_add(bytes)
            .context("ignored-input size overflow")?;
        if total.saturating_add(source_bytes) > MAX_BYTES {
            bail!("verification inputs exceed snapshot bounds");
        }
        #[cfg(unix)]
        let permissions = {
            use cap_std::fs::PermissionsExt;
            json!({"unix_mode": metadata.permissions().mode() & 0o777})
        };
        #[cfg(windows)]
        let permissions = json!({"windows_readonly": metadata.permissions().readonly()});
        digest.update(serde_json::to_vec(&json!({"path":path, "sha256":sha256, "bytes":bytes, "link":input_is_link(&metadata), "permissions": permissions}))?);
        digest.update([0]);
    }
    Ok((hex::encode(digest.finalize()), paths.len(), total))
}

/// pnpm uses absolute internal junctions on Windows. Rebase only ignored inputs,
/// never canonical Git symlinks; the materialized target is included in the input digest.
fn relative_input_link_target(source: &Path, path: &str, target: &Path) -> Result<PathBuf> {
    if !target.is_absolute() {
        return Ok(target.to_owned());
    }
    let resolved = workspace::normalize_path(std::fs::canonicalize(target)?);
    let source = workspace::normalize_path(source.to_owned());
    let relative = resolved
        .strip_prefix(&source)
        .context("absolute ignored-input link escapes its source workspace")?;
    if sensitive_path(&portable_path(relative)?) {
        bail!("ignored-input link targets a sensitive path");
    }
    let parent = Path::new(path).parent().context("ignored-input parent")?;
    let left = parent.components().collect::<Vec<_>>();
    let right = relative.components().collect::<Vec<_>>();
    let shared = left
        .iter()
        .zip(&right)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = PathBuf::new();
    for _ in shared..left.len() {
        result.push("..");
    }
    for component in &right[shared..] {
        result.push(component);
    }
    Ok(result)
}

fn materialize_links(root: &Path, mut links: Vec<(PathBuf, PathBuf)>) -> Result<()> {
    // Create targets first, so Windows can preserve file/directory link type.
    // A bounded number of passes rejects cycles, dangling targets and excessive depth.
    for _ in 0..40 {
        if links.is_empty() {
            return Ok(());
        }
        let mut pending = Vec::new();
        let count = links.len();
        for (path, target) in links {
            if path.parent().context("link parent")?.join(&target).exists() {
                create_input_link(root, &path, &target)?;
                workspace::validated_snapshot_symlink_target(root, &path)?;
            } else {
                pending.push((path, target));
            }
        }
        if pending.len() == count {
            bail!("canonical input link has a missing or cyclic target");
        }
        if pending.is_empty() {
            return Ok(());
        }
        links = pending;
    }
    bail!("canonical input links exceed the depth bound")
}

fn input_is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn open_input_directory(parent: &Dir, name: &str) -> Result<Dir> {
    let before = parent.symlink_metadata(name)?;
    if !before.is_dir() || input_is_link(&before) {
        bail!("ignored-input ancestor is not a plain directory");
    }
    let dir = parent.open_dir_nofollow(name)?;
    let after = dir.dir_metadata()?;
    if !after.is_dir()
        || input_is_link(&after)
        || (before.dev(), before.ino()) != (after.dev(), after.ino())
    {
        bail!("ignored-input ancestor changed during opening");
    }
    Ok(dir)
}

fn create_input_link(root: &Path, path: &Path, target: &Path) -> Result<()> {
    let parent = path.parent().context("ignored-input link parent")?;
    let mut resolved = parent.strip_prefix(root)?.to_owned();
    for component in target.components() {
        match component {
            Component::Normal(name) => resolved.push(name),
            Component::CurDir => {}
            Component::ParentDir if resolved.pop() => {}
            _ => bail!("ignored-input link escapes canonical snapshot"),
        }
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, path)?;
    #[cfg(windows)]
    {
        // Match Git for Windows: reparse targets need native separators to be followed,
        // while the Git blob and its integrity digest retain portable '/' separators.
        let target = target
            .to_str()
            .context("input link target is not UTF-8")?
            .replace('/', "\\");
        if root.join(resolved).is_dir() {
            std::os::windows::fs::symlink_dir(&target, path)?;
        } else {
            std::os::windows::fs::symlink_file(&target, path)?;
        }
    }
    Ok(())
}

fn add_paths(bytes: &[u8], paths: &mut BTreeSet<String>) -> Result<()> {
    for path in bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = std::str::from_utf8(path).context("verification input path is not UTF-8")?;
        super::validate_relative(path)?;
        paths.insert(path.to_owned());
        if paths.len() > MAX_ENTRIES {
            bail!("verification input path count exceeds snapshot bound");
        }
    }
    Ok(())
}

fn collect_input_paths(
    directory: &Dir,
    prefix: &str,
    excluded: &BTreeSet<String>,
    paths: &mut Vec<String>,
    visited: &mut usize,
) -> Result<()> {
    for entry in directory.entries()? {
        let entry = entry?;
        *visited += 1;
        if *visited > MAX_ENTRIES {
            bail!("ignored-input enumeration exceeds snapshot entry bound");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("ignored-input name is not UTF-8"))?;
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if sensitive_path(&relative) || excluded.contains(&relative) {
            continue;
        }
        super::validate_relative(&relative)?;
        let metadata = directory.symlink_metadata(&name)?;
        if metadata.is_dir() && !input_is_link(&metadata) {
            collect_input_paths(
                &open_input_directory(directory, &name)?,
                &relative,
                excluded,
                paths,
                visited,
            )?;
        } else {
            paths.push(relative);
        }
    }
    Ok(())
}

async fn file_digest(path: &Path, expected_size: u64) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut count = 0_u64;
    loop {
        let size = file.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        count = count
            .checked_add(size as u64)
            .context("verification file size overflow")?;
        if count > expected_size {
            bail!("canonical file size changed: {}", path.display());
        }
        digest.update(&buffer[..size]);
    }
    if count != expected_size {
        bail!("canonical file size changed: {}", path.display());
    }
    Ok(hex::encode(digest.finalize()))
}

async fn check_source_integrity(
    baseline: &Path,
    root: &Path,
    files: &[SourceFile],
    source: &SourceVerification,
) -> Result<()> {
    for file in files {
        let path = root.join(&file.path);
        let mut parent = root.to_owned();
        for component in Path::new(&file.path)
            .parent()
            .context("canonical file parent")?
            .components()
        {
            parent.push(component);
            if workspace::snapshot_entry_is_link(&tokio::fs::symlink_metadata(&parent).await?) {
                bail!("canonical source directory became a link");
            }
        }
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        let digest = if file.mode == "120000" {
            if !workspace::snapshot_entry_is_link(&metadata) {
                bail!("canonical link changed type");
            }
            let target = workspace::validated_snapshot_symlink_target(root, &path)?;
            let target = target.to_str().context("canonical link target UTF-8")?;
            #[cfg(windows)]
            let target = target.replace('\\', "/");
            hex::encode(Sha256::digest(target.as_bytes()))
        } else {
            if !metadata.is_file() || workspace::snapshot_entry_is_link(&metadata) {
                bail!("canonical file changed type: {}", file.path);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if (metadata.permissions().mode() & 0o111 != 0) != (file.mode == "100755") {
                    bail!("canonical executable mode changed: {}", file.path);
                }
            }
            file_digest(&path, file.bytes).await?
        };
        if digest != file.sha256 {
            bail!("canonical blob bytes changed: {}", file.path);
        }
    }
    for path in [
        root.join(".git"),
        root.join(".git/HEAD"),
        root.join(".git/index"),
    ] {
        if workspace::snapshot_entry_is_link(&tokio::fs::symlink_metadata(path).await?) {
            bail!("private Git metadata became a link");
        }
    }
    if tokio::fs::read(root.join(".git/HEAD")).await?
        != format!("{}\n", source.candidate_commit).as_bytes()
    {
        bail!("private verification HEAD changed");
    }
    let tree = private_git_with_index(
        baseline,
        &["write-tree".into()],
        &[],
        Some(&root.join(".git/index")),
    )
    .await?;
    if tree != format!("{}\n", source.tree).as_bytes() {
        bail!("private verification index tree changed");
    }
    // Use trusted baseline config/objects to inspect only the command's index and worktree.
    let args = [
        "--git-dir".into(),
        workspace::normalize_path(baseline.join(".git")).into_os_string(),
        "--work-tree".into(),
        workspace::normalize_path(root.to_path_buf()).into_os_string(),
        "ls-files".into(),
        "--others".into(),
        "--exclude-standard".into(),
        "-z".into(),
    ];
    if !private_git(baseline, &args, &[]).await?.is_empty() {
        bail!("check created non-ignored source outside the verified tree");
    }
    // Raw-file comparisons above deliberately do not use Git diff: clean filters can hide drift.
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn canonical_raw_blob_rejection_waits_for_process_exit() {
        let root =
            std::env::temp_dir().join(format!("ecorp-raw-blob-error-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        private_git(
            &root,
            &["init".into(), "--quiet".into(), "--template=".into()],
            &[],
        )
        .await
        .unwrap();
        let mut files = [SourceFile {
            path: "missing.txt".into(),
            mode: "100644".into(),
            object: "0".repeat(40),
            bytes: 1,
            sha256: String::new(),
        }];
        let error = materialize(&root, &mut files).await.unwrap_err();
        assert!(format!("{error:#}").contains("unexpected raw Git blob header"));
        std::fs::remove_dir_all(&root).expect("rejected blob reader must release the snapshot");
    }
}
