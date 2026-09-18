//! Opt-in, owned native assignment probes; never server/store/browser acceptance.
//! Run the ignored dispatcher only through the source/binary-admitting QA driver.
//! The fresh root must end in the nonce and be outside the source checkout. Fixtures,
//! including failed worktrees, are retained. No production injection seam is installed.

use super::*;
use crate::dependency_files::fixture_support::payload;
use anyhow::{bail, ensure};
use async_trait::async_trait;
use crony_protocol::dependency_files::{
    MAX_DEPENDENCY_BYTES, MAX_DEPENDENCY_FILE_BYTES, MAX_DEPENDENCY_FILES, VerifiedDependencyFile,
};
use std::{
    fs,
    path::{Component, Path},
    process::Stdio,
    sync::atomic::AtomicUsize,
};

const CASES: [&str; 10] = [
    "destination-symlink",
    "destination-reparse",
    "file-count-limit",
    "wire-file-byte-limit",
    "aggregate-byte-limit",
    "exact-limit-control",
    "parent-tree-isolation",
    "missing-file",
    "oversized-file",
    "invalid-probe",
];
const SENTINEL: &[u8] = b"owned target sentinel: unchanged\r\n";
const ENTRYPOINT: &str = "issue297_native_fixtures::issue297_native_fixture_dispatch";

#[derive(Debug)]
struct Parameters {
    case_id: String,
    nonce: Uuid,
    root: PathBuf,
}

impl Parameters {
    fn parse(case_id: String, nonce: String, root: PathBuf) -> Result<Self> {
        ensure!(
            CASES.contains(&case_id.as_str()),
            "unknown native fixture case"
        );
        let parsed = Uuid::parse_str(&nonce).context("fixture nonce must be a UUID")?;
        ensure!(
            !parsed.is_nil() && parsed.to_string() == nonce,
            "canonical non-nil nonce required"
        );
        ensure!(root.is_absolute(), "absolute owned fixture root required");
        ensure!(
            root.components()
                .all(|part| !matches!(part, Component::ParentDir | Component::CurDir)),
            "ambiguous fixture root"
        );
        ensure!(
            root.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&nonce)),
            "owned root name must end in the exact nonce"
        );
        Ok(Self {
            case_id,
            nonce: parsed,
            root,
        })
    }

    fn from_environment() -> Result<Self> {
        Self::parse(
            std::env::var("ECORP_ISSUE297_NATIVE_CASE")?,
            std::env::var("ECORP_ISSUE297_FIXTURE_NONCE")?,
            PathBuf::from(
                std::env::var_os("ECORP_ISSUE297_FIXTURE_ROOT")
                    .context("explicit owned fixture root required")?,
            ),
        )
    }

    fn create_owned_root(&self) -> Result<()> {
        let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .canonicalize()?;
        let parent = self.root.parent().context("fixture root parent")?;
        ensure_plain_ancestors(parent)?;
        let canonical_parent = parent.canonicalize()?;
        let canonical_root = canonical_parent.join(self.root.file_name().context("root name")?);
        ensure!(
            !canonical_root.starts_with(&checkout) && !checkout.starts_with(&canonical_root),
            "native fixture must not overlap the source checkout"
        );
        // create_dir, never create_dir_all, proves this invocation owns a new root.
        fs::create_dir(&self.root)
            .context("fixture root must be absent under an existing owned parent")?;
        let manifest = json!({
            "schema_version": 1, "test_owned": true, "case_id": self.case_id,
            "nonce": self.nonce, "entrypoint": ENTRYPOINT,
            "scope": "offline-native-runner-only", "source_checkout": checkout,
        });
        fs::write(self.root.join("owner.json"), serde_json::to_vec(&manifest)?)?;
        Ok(())
    }
}

fn ensure_plain_ancestors(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        ensure!(
            !matches!(part, Component::ParentDir | Component::CurDir),
            "ambiguous owned parent"
        );
        current.push(part);
        if !current.has_root() {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "owned parent is not a plain directory"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            ensure!(
                metadata.file_attributes() & 0x400 == 0,
                "owned parent is a reparse point"
            );
        }
    }
    Ok(())
}

fn files_at_count_limit() -> Vec<VerifiedDependencyFile> {
    (0..MAX_DEPENDENCY_FILES)
        .map(|index| payload(&format!("handoffs/file{index}.txt"), "λ\r\n\0verified"))
        .collect()
}

fn files_at_aggregate_limit() -> Vec<VerifiedDependencyFile> {
    let mut files: Vec<_> = (0..MAX_DEPENDENCY_FILES)
        .map(|index| payload(&format!("handoffs/file{index}.txt"), ""))
        .collect();
    let mut remaining = MAX_DEPENDENCY_BYTES - serde_json::to_vec(&files).unwrap().len();
    for file in &mut files {
        let bytes = remaining.min(MAX_DEPENDENCY_FILE_BYTES);
        *file = payload(&file.path, &"a".repeat(bytes));
        remaining -= bytes;
    }
    assert_eq!(remaining, 0);
    assert_eq!(
        serde_json::to_vec(&files).unwrap().len(),
        MAX_DEPENDENCY_BYTES
    );
    files
}

struct ObservedAdapter {
    inner: adapter::FakeProcessAdapter,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl AgentAdapter for ObservedAdapter {
    fn id(&self) -> &'static str {
        "fake-process"
    }
    fn display_name(&self) -> &'static str {
        "Owned issue297 native process fixture"
    }
    fn capabilities(&self) -> adapter::AdapterCapabilities {
        self.inner.capabilities()
    }

    async fn execute(
        &self,
        request: AdapterRunRequest,
        controls: mpsc::UnboundedReceiver<AdapterControl>,
        sink: Arc<dyn AdapterEventSink>,
    ) -> Result<AdapterExit, adapter::AdapterError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.execute(request, controls, sink).await
    }
}

struct Fixture {
    workspaces: Arc<WorkspaceManager>,
    script: PathBuf,
    root: PathBuf,
    nonce: Uuid,
}

async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new("git")
            .arg("--no-pager")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("owned git deadline")??;
    ensure!(
        output.status.success(),
        "owned git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

impl Fixture {
    async fn new(parameters: &Parameters) -> Result<Self> {
        parameters.create_owned_root()?;
        let source = parameters.root.join("source");
        fs::create_dir(&source)?;
        // Only the newly owned synthetic repository gets Git objects or refs.
        // The admitted source checkout is never used as a writable fixture repository.
        git(&source, &["init", "-b", "main"]).await?;
        git(&source, &["config", "--local", "core.longpaths", "true"]).await?;
        git(
            &source,
            &[
                "-c",
                "user.name=ECorp Native Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "core.hooksPath=",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "owned native fixture seed",
            ],
        )
        .await?;
        let workspaces = Arc::new(
            WorkspaceManager::initialize(
                parameters.root.join("managed"),
                source,
                "main".to_owned(),
            )
            .await?,
        );
        let script = parameters.root.join("native-provider.mjs");
        fs::write(&script, PROVIDER_SCRIPT)?;
        Ok(Self {
            workspaces,
            script,
            root: parameters.root.clone(),
            nonce: parameters.nonce,
        })
    }

    fn assignment(&self, files: Vec<VerifiedDependencyFile>) -> Assignment {
        Assignment {
            corp_id: Uuid::new_v4(),
            connection_epoch: Uuid::new_v4(),
            room_id: Uuid::new_v4(),
            mission_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            workspace_run_id: Uuid::new_v4(),
            agent_id: Uuid::new_v4(),
            assignment_token: Uuid::new_v4(),
            adapter: "fake-process".to_owned(),
            mission_title: self.nonce.to_string(),
            dependency_files: files,
            model: None,
            reasoning_effort: None,
            source_repository: Some(self.workspaces.repository_identity().unwrap().to_owned()),
            source_base_ref: Some(self.workspaces.base_ref().to_owned()),
            source_base_commit: Some(self.workspaces.base_commit().to_owned()),
            workspace_connection_id: None,
            resume_workspace_base_commit: None,
            verification_policy: VerificationPolicy {
                checks: vec![],
                manual_gate: None,
            },
            write_scope: vec!["handoffs/**".to_owned()],
            deliverable: None,
            secrets: vec![],
            expected_workspace_fingerprint: None,
            expected_head_commit: None,
            provider_artifact: None,
            verification_command_id: None,
            retained_provider_receipt: None,
            checkpoint_verification: false,
            hard_boundary_checkpoint: Arc::default(),
        }
    }

    async fn prepare(&self, assignment: &Assignment) -> Result<WorkspaceLease> {
        self.workspaces
            .prepare(
                assignment.task_id,
                assignment.workspace_run_id,
                assignment.source_base_commit.as_deref(),
                None,
            )
            .await
    }

    async fn bind_checkpoint(
        &self,
        assignment: &mut Assignment,
        workspace: &WorkspaceLease,
    ) -> Result<()> {
        let (head, fingerprint) = self.workspaces.checkpoint(workspace).await?;
        assignment.resume_workspace_base_commit = Some(workspace.base_commit.clone());
        assignment.expected_workspace_fingerprint = Some(fingerprint);
        assignment.expected_head_commit = Some(head);
        Ok(())
    }

    async fn run(
        &self,
        assignment: Assignment,
        workspace: &WorkspaceLease,
        parent_sentinel: Option<&Path>,
    ) -> Result<Observation> {
        let receipt = self
            .root
            .join(format!("receipt-{}.json", assignment.run_id));
        let configuration = json!({
            "nonce": self.nonce, "receipt": receipt,
            "files": assignment.dependency_files,
            "parent_sentinel": parent_sentinel,
            "sentinel_sha256": hex::encode(sha2::Sha256::digest(SENTINEL)),
        });
        // Every file is fixture-owned. This is not a client mutation or a provider prompt.
        fs::write(
            workspace.path.join("native-fixture.json"),
            serde_json::to_vec(&configuration)?,
        )?;
        let mut assignment = assignment;
        assignment.dependency_files =
            serde_json::from_slice(&serde_json::to_vec(&assignment.dependency_files)?)?;
        if assignment.expected_workspace_fingerprint.is_some() {
            self.bind_checkpoint(&mut assignment, workspace).await?;
        }
        let admitted_checkpoint = assignment
            .expected_head_commit
            .clone()
            .zip(assignment.expected_workspace_fingerprint.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        let adapter = Arc::new(ObservedAdapter {
            inner: adapter::FakeProcessAdapter::new(self.script.clone()),
            calls: calls.clone(),
        });
        let outbound = OutboundBus::default();
        let (_control_tx, controls) = mpsc::unbounded_channel();
        let (_ack_tx, artifact_acks) = mpsc::unbounded_channel();
        tokio::time::timeout(
            Duration::from_secs(30),
            execute_assignment(
                self.workspaces.clone(),
                "issue297-owned-native".to_owned(),
                assignment.clone(),
                adapter,
                outbound.clone(),
                AssignmentChannels {
                    controls,
                    artifact_acks,
                },
                None,
            ),
        )
        .await
        .context("native assignment deadline")??;
        let (sender, mut receiver) = mpsc::unbounded_channel();
        outbound.attach(sender, assignment.connection_epoch);
        let mut events = Vec::new();
        while let Ok(message) = receiver.try_recv() {
            if let RunnerToServer::RunEvent {
                event_type,
                payload,
                ..
            } = message
            {
                events.push((event_type, payload));
            }
        }
        ensure!(
            workspace.path.is_dir(),
            "native workspace was not preserved"
        );
        if calls.load(Ordering::SeqCst) == 0
            && let Some(expected) = admitted_checkpoint
        {
            ensure!(
                self.workspaces.checkpoint(workspace).await? == expected,
                "native pre-dispatch rejection changed the admitted workspace checkpoint"
            );
        }
        ensure!(
            events.iter().all(|(kind, _)| kind != "run.completed"),
            "fixture must never claim accepted completion"
        );
        Ok(Observation {
            calls: calls.load(Ordering::SeqCst),
            events,
            receipt: if receipt.exists() {
                Some(serde_json::from_slice(&fs::read(receipt)?)?)
            } else {
                None
            },
        })
    }

    async fn positive(&self, files: Vec<VerifiedDependencyFile>) -> Result<Value> {
        let mut assignment = self.assignment(files.clone());
        let workspace = self.prepare(&assignment).await?;
        self.bind_checkpoint(&mut assignment, &workspace).await?;
        let observation = self.run(assignment, &workspace, None).await?;
        observation.assert_started(self.nonce, files.len())?;
        for file in files {
            ensure!(
                fs::read(workspace.path.join(file.path))? == file.content.as_bytes(),
                "positive native bytes changed"
            );
        }
        Ok(observation.receipt.unwrap())
    }

    async fn reject_limit(&self, files: Vec<VerifiedDependencyFile>, error: &str) -> Result<()> {
        let mut assignment = self.assignment(files);
        let workspace = self.prepare(&assignment).await?;
        fs::write(workspace.path.join("owned-sentinel.txt"), SENTINEL)?;
        self.bind_checkpoint(&mut assignment, &workspace).await?;
        let observation = self.run(assignment, &workspace, None).await?;
        observation.assert_rejected(error)?;
        ensure!(
            !workspace.path.join("handoffs").exists(),
            "rejection wrote dependency files"
        );
        ensure!(
            fs::read(workspace.path.join("owned-sentinel.txt"))? == SENTINEL,
            "sentinel changed"
        );
        Ok(())
    }
}

struct Observation {
    calls: usize,
    events: Vec<(String, Value)>,
    receipt: Option<Value>,
}

impl Observation {
    fn assert_rejected(&self, reason: &str) -> Result<()> {
        ensure!(
            self.calls == 0 && self.receipt.is_none(),
            "provider startup was not prevented"
        );
        ensure!(
            self.events
                .iter()
                .map(|(kind, _)| kind.as_str())
                .collect::<Vec<_>>()
                == ["run.failed", "run.workspace_preserved"],
            "native rejection must have exactly failure and preservation events"
        );
        ensure!(
            self.events
                .iter()
                .all(|(kind, _)| kind != "run.started" && kind != "run.session_terminated"),
            "provider lifecycle appeared after native admission rejection"
        );
        ensure!(
            self.events
                .iter()
                .any(|(kind, payload)| kind == "run.failed"
                    && payload["error"].as_str().is_some_and(|error| error
                        .contains("verified dependency materialization failed")
                        && error.contains(reason))),
            "expected the materializer's native rejection, not an earlier checkpoint or unit failure"
        );
        ensure!(
            self.events.iter().any(|(kind, payload)| {
                kind == "run.workspace_preserved"
                    && payload["detail"]
                        .as_str()
                        .is_some_and(|detail| detail.contains("dependency materialization failed"))
            }),
            "native preservation event missing"
        );
        Ok(())
    }

    fn assert_started(&self, nonce: Uuid, count: usize) -> Result<()> {
        ensure!(
            self.calls == 1,
            "positive assignment never entered the adapter"
        );
        let receipt = self
            .receipt
            .as_ref()
            .context("native child readback receipt missing")?;
        ensure!(
            receipt["nonce"] == nonce.to_string(),
            "wrong native child nonce"
        );
        ensure!(
            receipt["files_read"] == count
                && receipt["exact_bytes"] == true
                && receipt["read_write_permissions"] == true,
            "native child byte/permission control failed"
        );
        ensure!(
            self.events.iter().any(|(kind, _)| kind == "run.started"),
            "startup event missing"
        );
        Ok(())
    }
}

// The actual shipped fake-process adapter starts this offline Node child. It validates
// on-disk bytes and native r+ opens, then intentionally fails to avoid verifier/publication
// or artifact acceptance. Parent reads are actual OS opens, never an inferred denial.
const PROVIDER_SCRIPT: &str = r#"
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const workspace = arg('--workdir');
const config = JSON.parse(fs.readFileSync(path.join(workspace, 'native-fixture.json'), 'utf8'));
let count = 0;
for (const file of config.files) {
  const name = path.join(workspace, ...file.path.split('/'));
  const handle = fs.openSync(name, 'r+');
  const bytes = fs.readFileSync(handle);
  fs.closeSync(handle);
  if (!bytes.equals(Buffer.from(file.content)) ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error('native materialized bytes mismatch');
  }
  count++;
}
const control = path.join(workspace, 'handoffs', 'native-permission-control.txt');
fs.writeFileSync(control, config.nonce, { flag: 'wx' });
if (fs.readFileSync(control, 'utf8') !== config.nonce) throw new Error('native write control');
let parent = { attempted: false };
if (config.parent_sentinel) {
  try {
    const bytes = fs.readFileSync(config.parent_sentinel);
    parent = { attempted: true, denied: false, readable: true,
      exact: createHash('sha256').update(bytes).digest('hex') === config.sentinel_sha256 };
  } catch (error) {
    parent = { attempted: true, denied: ['EACCES', 'EPERM'].includes(error.code),
      readable: false, error_code: error.code };
  }
}
fs.writeFileSync(config.receipt, JSON.stringify({ nonce: config.nonce, files_read: count,
  exact_bytes: true, read_write_permissions: true, parent }), { flag: 'wx' });
console.log(JSON.stringify({ type: 'failed', error: 'owned native fixture stopped after readback' }));
"#;

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    case_id: String,
    nonce: Uuid,
    status: &'static str,
    positive_controls: Vec<&'static str>,
    rejection_assertions: Vec<&'static str>,
    evidence_scope: &'static str,
    platform: &'static str,
    qualification: String,
    observations: Value,
}

impl Report {
    fn new(parameters: &Parameters) -> Self {
        Self {
            schema_version: 1, case_id: parameters.case_id.clone(), nonce: parameters.nonce,
            status: "native_rejection_observed",
            positive_controls: vec![],
            rejection_assertions: vec![],
            evidence_scope: "native-runner-assignment-materialization",
            platform: std::env::consts::OS,
            qualification: "Actual execute_assignment -> workspace prepare/checkpoint -> materializer -> fake-process child; not signed-store, server, browser, real-provider or full-stack acceptance.".to_owned(),
            observations: json!({}),
        }
    }

    fn rejected(&mut self) {
        self.rejection_assertions.extend([
            "native_materializer_rejection",
            "no_adapter_entry",
            "no_provider_start",
            "workspace_preserved",
            "owned_sentinel_unchanged",
            "no_dependency_writes",
        ]);
    }

    fn unqualified(&mut self, reason: impl Into<String>) {
        self.status = "unqualified";
        self.qualification = reason.into();
    }
}

async fn execute_case(parameters: &Parameters) -> Result<Report> {
    let fixture = Fixture::new(parameters).await?;
    let mut report = Report::new(parameters);
    fixture
        .positive(vec![payload(
            "handoffs/valid.txt",
            "\u{feff}valid\r\nλ\0bytes",
        )])
        .await?;
    report.positive_controls.extend([
        "native_assignment_provider_started",
        "native_exact_byte_readback",
        "native_read_write_permissions",
        "legitimate_retained_checkpoint",
    ]);
    match parameters.case_id.as_str() {
        "missing-file" | "oversized-file" | "invalid-probe" => {
            let nonce = parameters.nonce.to_string();
            verifier::tests::issue297_verify_case(&parameters.root, "control", &nonce).await;
            verifier::tests::issue297_verify_case(&parameters.root, "exact-limit-control", &nonce)
                .await;
            let evidence = verifier::tests::issue297_verify_case(
                &parameters.root,
                &parameters.case_id,
                &nonce,
            )
            .await;
            report.evidence_scope = "native-runner-verifier";
            report.positive_controls.extend([
                "native_verifier_unchanged_control",
                "exact_6144_byte_note_control",
            ]);
            report.rejection_assertions.extend([
                "real_fake_process_fault",
                "signed_download_not_claimed",
                "native_verifier_exact_check_rejected",
                "four_native_verifier_assertions",
                "provider_artifact_present",
            ]);
            report.observations = evidence;
            report.qualification = "Real deterministic subprocess outputs and native verify() file/command checks. Assignment positive control is separate. No signed store, scheduling, browser, live rejection or owner acceptance.".to_owned();
        }
        "file-count-limit" => {
            let mut files = files_at_count_limit();
            fixture.positive(files.clone()).await?;
            report.positive_controls.push("exact_file_count_limit");
            files.push(payload("handoffs/extra.txt", "valid"));
            fixture
                .reject_limit(files, "too many dependency files")
                .await?;
            report.rejected();
        }
        "wire-file-byte-limit" => {
            let exact = payload(
                "handoffs/large.txt",
                &"λ".repeat(MAX_DEPENDENCY_FILE_BYTES / 2),
            );
            fixture.positive(vec![exact.clone()]).await?;
            report.positive_controls.push("exact_utf8_file_byte_limit");
            let oversized = payload(&exact.path, &(exact.content + "a"));
            ensure!(
                oversized.content.len() == MAX_DEPENDENCY_FILE_BYTES + 1,
                "byte-limit fault construction"
            );
            fixture
                .reject_limit(vec![oversized], "dependency file exceeds byte limit")
                .await?;
            report.rejected();
        }
        "aggregate-byte-limit" | "exact-limit-control" => {
            let exact = files_at_aggregate_limit();
            fixture.positive(exact.clone()).await?;
            report.positive_controls.extend([
                "exact_file_count_limit",
                "exact_file_byte_limit",
                "exact_serialized_aggregate_limit",
            ]);
            let mut overflow = exact;
            let file = overflow.last_mut().unwrap();
            *file = payload(&file.path, &(file.content.clone() + "a"));
            ensure!(
                serde_json::to_vec(&overflow)?.len() == MAX_DEPENDENCY_BYTES + 1,
                "aggregate boundary construction"
            );
            ensure!(
                overflow
                    .iter()
                    .all(|file| file.content.len() <= MAX_DEPENDENCY_FILE_BYTES),
                "aggregate fault must not violate file limit"
            );
            fixture
                .reject_limit(overflow, "dependency payload byte limit")
                .await?;
            report.rejected();
            if parameters.case_id == "exact-limit-control" {
                report.status = "native_control_observed";
            }
            report.observations = json!({
                "file_count_limit": MAX_DEPENDENCY_FILES, "file_byte_limit": MAX_DEPENDENCY_FILE_BYTES,
                "aggregate_wire_limit": MAX_DEPENDENCY_BYTES, "rejected_wire_bytes": MAX_DEPENDENCY_BYTES + 1,
            });
        }
        "destination-symlink" | "destination-reparse" => {
            destination_case(&fixture, &mut report).await?;
        }
        "parent-tree-isolation" => {
            // This sibling worktree is an actual parent tree under the same manager.
            let parent_assignment = fixture.assignment(vec![]);
            let parent = fixture.prepare(&parent_assignment).await?;
            let sentinel = parent.path.join("parent-owned-sentinel.txt");
            fs::write(&sentinel, SENTINEL)?;
            let before = fixture.workspaces.checkpoint(&parent).await?;
            let mut child_assignment =
                fixture.assignment(vec![payload("handoffs/child.txt", "valid")]);
            let child = fixture.prepare(&child_assignment).await?;
            fixture
                .bind_checkpoint(&mut child_assignment, &child)
                .await?;
            let observed = fixture
                .run(child_assignment, &child, Some(&sentinel))
                .await?;
            observed.assert_started(fixture.nonce, 1)?;
            ensure!(
                fixture.workspaces.checkpoint(&parent).await? == before,
                "parent checkpoint changed"
            );
            ensure!(fs::read(&sentinel)? == SENTINEL, "parent sentinel changed");
            let receipt = observed.receipt.unwrap();
            let native_read = &receipt["parent"];
            ensure!(
                native_read["attempted"] == true,
                "parent OS read was not attempted"
            );
            report.positive_controls.extend([
                "owned_parent_native_read_attempt",
                "parent_checkpoint_unchanged",
            ]);
            report.observations = receipt;
            if report.observations["parent"]["denied"] == true {
                report
                    .rejection_assertions
                    .extend(["native_os_parent_read_denied", "owned_sentinel_unchanged"]);
                report.qualification.push_str(" Parent EACCES/EPERM denial is qualified only for this exact native identity and fixture layout.");
            } else {
                ensure!(
                    report.observations["parent"]["readable"] == true
                        && report.observations["parent"]["exact"] == true,
                    "parent read failed for a non-denial reason"
                );
                report.unqualified("The actual fake-process child read the owned sibling-parent sentinel with exact bytes. The current native runner does not supply OS filesystem isolation (docs/SECURITY.md; adapter/fake.rs). A worktree, native tool scope or Windows job object is not a filesystem ACL boundary. Qualifying this case needs an authorized production isolation design (separate OS identity/ACLs or container/sandbox), not fixture chmod or additional runtime provisioning. No full-stack isolation acceptance.");
            }
        }
        _ => bail!("unknown fixture case"),
    }
    Ok(report)
}

async fn destination_case(fixture: &Fixture, report: &mut Report) -> Result<()> {
    let reparse = report.case_id == "destination-reparse";
    if reparse && !cfg!(windows) {
        report.unqualified("destination-reparse requires Windows junction/reparse semantics; Unix symlinks are not a substitute. Native positive control ran; no platform skip counts as rejection.");
        return Ok(());
    }
    let files = vec![
        payload("handoffs/first.txt", "must not be written"),
        payload(
            if reparse {
                "handoffs/linked/target.txt"
            } else {
                "handoffs/linked.txt"
            },
            std::str::from_utf8(SENTINEL)?,
        ),
    ];
    fixture.positive(files.clone()).await?;
    report
        .positive_controls
        .push("same_destination_plain_file_control");
    let mut assignment = fixture.assignment(files);
    let workspace = fixture.prepare(&assignment).await?;
    let target = workspace.path.join("owned-target");
    fs::create_dir(&target)?;
    fs::write(target.join("target.txt"), SENTINEL)?;
    fs::create_dir(workspace.path.join("handoffs"))?;
    let link = workspace.path.join(if reparse {
        "handoffs/linked"
    } else {
        "handoffs/linked.txt"
    });
    let construction = if reparse {
        create_junction(&target, &link).await
    } else {
        create_symlink(
            &PathBuf::from("..").join("owned-target").join("target.txt"),
            &link,
        )
    };
    if let Err(error) = construction {
        report.unqualified(format!("Native destination link construction unavailable on {}: {error:#}. Native byte/permission control succeeded; no rejection claimed.", std::env::consts::OS));
        return Ok(());
    }
    ensure!(
        fs::read(if reparse {
            link.join("target.txt")
        } else {
            link.clone()
        })? == SENTINEL,
        "constructed link must actually resolve to the exact owned sentinel"
    );
    report
        .positive_controls
        .push("native_destination_link_resolves_exact_target");
    if reparse {
        // Windows junction targets are absolute, which checkpoint admission deliberately
        // rejects. Exercise the real fresh-assignment path, not a forged recovery hash.
        // prepare() above owns and verifies this exact task/run worktree and base commit.
        assignment.expected_head_commit = Some(fixture.workspaces.head_commit(&workspace).await?);
        report
            .positive_controls
            .push("fresh_owned_worktree_base_and_head");
    } else {
        fixture.bind_checkpoint(&mut assignment, &workspace).await?;
        report
            .positive_controls
            .push("relative_internal_symlink_checkpoint");
    }
    let observation = fixture.run(assignment, &workspace, None).await?;
    observation.assert_rejected("dependency path is a link or reparse point")?;
    ensure!(
        fs::read(target.join("target.txt"))? == SENTINEL,
        "owned target sentinel changed"
    );
    ensure!(
        fs::symlink_metadata(&link).is_ok(),
        "destination link was not preserved"
    );
    ensure!(
        !workspace.path.join("handoffs").join("first.txt").exists(),
        "native preflight wrote a file"
    );
    ensure!(
        fs::read_dir(&target)?.count() == 1,
        "native materializer wrote through the target"
    );
    report.rejected();
    report.qualification.push_str(if reparse {
        " Windows junction constructed before dispatch in a freshly owned task worktree; checkpoint hashes were not fabricated or bypassed. Fresh assignment head/base checks pass before native materializer rejection."
    } else {
        " A relative file symlink within the retained owned child worktree was checkpointed legitimately before dispatch; native OS link creation capability was present."
    });
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link).context("native Unix file symlink")
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::windows::fs::symlink_file(target, link)
        .context("native Windows symlink privilege/capability")
}

#[cfg(not(any(unix, windows)))]
fn create_symlink(_target: &Path, _link: &Path) -> Result<()> {
    bail!("native symlink fixture is unsupported on this platform")
}

#[cfg(windows)]
async fn create_junction(target: &Path, link: &Path) -> Result<()> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::from(crate::dependency_files::fixture_support::junction_command(
            target, link,
        ))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output(),
    )
    .await
    .context("junction creation deadline")??;
    ensure!(
        output.status.success(),
        "native junction creation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    use std::os::windows::fs::MetadataExt;
    ensure!(
        fs::symlink_metadata(link)?.file_attributes() & 0x400 != 0,
        "native link is not a Windows reparse point"
    );
    Ok(())
}

#[cfg(not(windows))]
async fn create_junction(_target: &Path, _link: &Path) -> Result<()> {
    bail!("Windows reparse capability required")
}

#[tokio::test]
#[ignore = "owned QA source/binary admission required; explicit case, nonce and fresh external root"]
async fn issue297_native_fixture_dispatch() {
    let parameters = Parameters::from_environment().expect("strict native fixture parameters");
    let report = execute_case(&parameters)
        .await
        .expect("native fixture assertions");
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(encoded.len() <= 16_384, "bounded native fixture receipt");
    println!("\nISSUE297_NATIVE_FIXTURE: {encoded}");
    assert_ne!(
        report.status, "unqualified",
        "native case is explicitly unqualified; see bounded receipt"
    );
}

#[test]
fn issue297_native_fixture_catalog_and_parameter_guards() {
    let nonce = Uuid::new_v4().to_string();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("owned-{nonce}"));
    assert_eq!(
        CASES
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        10
    );
    for case in CASES {
        assert!(Parameters::parse(case.to_owned(), nonce.clone(), root.clone()).is_ok());
    }
    assert!(Parameters::parse("unknown".into(), nonce.clone(), root.clone()).is_err());
    assert!(Parameters::parse(CASES[0].into(), Uuid::nil().to_string(), root.clone()).is_err());
    assert!(Parameters::parse(CASES[0].into(), "not-a-uuid".into(), root.clone()).is_err());
    assert!(
        Parameters::parse(
            CASES[0].into(),
            nonce.clone(),
            PathBuf::from(format!("relative-{nonce}"))
        )
        .is_err()
    );
    assert!(Parameters::parse(CASES[0].into(), nonce, root.join("different-name")).is_err());
}

#[test]
fn issue297_native_fixture_exact_boundaries_are_constructed_not_inferred() {
    let count = files_at_count_limit();
    assert_eq!(count.len(), MAX_DEPENDENCY_FILES);
    let exact = files_at_aggregate_limit();
    assert_eq!(exact.len(), MAX_DEPENDENCY_FILES);
    assert_eq!(
        serde_json::to_vec(&exact).unwrap().len(),
        MAX_DEPENDENCY_BYTES
    );
    assert!(
        exact
            .iter()
            .any(|file| file.content.len() == MAX_DEPENDENCY_FILE_BYTES)
    );
    assert!(
        exact
            .iter()
            .all(|file| file.content.len() <= MAX_DEPENDENCY_FILE_BYTES)
    );
    assert!(
        exact
            .iter()
            .all(|file| hex::encode(sha2::Sha256::digest(file.content.as_bytes())) == file.sha256)
    );
}
