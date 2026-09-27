//! Retrospective native Git/verifier regressions. These are not provider or browser acceptance.

use std::{fs, path::Path, process::Command};

use crony_domain::{VerificationPolicy, VerifierCheck};
use serde_json::Value;
use sha2::Sha384;
use tokio::sync::watch;

use super::*;
use crate::verifier;

struct Fixture {
    root: PathBuf,
    lease: WorkspaceLease,
}

impl Fixture {
    fn new() -> Self {
        Self::new_in(&std::env::temp_dir())
    }

    fn new_in(parent: &Path) -> Self {
        let root = parent.join(format!("ecorp-canonical-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        println!("canonical fixture: {}", root.display());
        git(&source, &["init", "--template=", "-b", "main"]);
        git(
            &source,
            &["config", "user.name", "ECorp regression fixture"],
        );
        git(&source, &["config", "user.email", "fixture@ecorp.invalid"]);
        git(&source, &["config", "core.autocrlf", "false"]);
        fs::write(source.join("tracked.txt"), b"before\n").unwrap();
        fs::write(source.join("other.txt"), b"other before\n").unwrap();
        fs::write(
            source.join(".gitignore"),
            b"deps/\nbuild/\nignored/\n.env\n",
        )
        .unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "fixture base"]);
        Self {
            root,
            lease: WorkspaceLease {
                base_commit: git(&source, &["rev-parse", "HEAD"]),
                path: source,
                branch: "main".into(),
                base_ref: "main".into(),
            },
        }
    }

    fn write(&self, path: &str, bytes: &[u8]) {
        let path = self.lease.path.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn commit_base(&mut self) {
        git(&self.lease.path, &["add", "."]);
        git(&self.lease.path, &["commit", "-m", "fixture prerequisites"]);
        self.lease.base_commit = git(&self.lease.path, &["rev-parse", "HEAD"]);
    }

    async fn prepare(&self, paths: &[&str], artifacts: &[AdapterArtifact]) -> PreparedDeliverable {
        prepare(
            Uuid::new_v4(),
            &DeliverableSpec {
                form: DeliverableForm::CommitBranch,
                commit_after_verification: true,
                paths: paths.iter().map(|path| (*path).to_owned()).collect(),
            },
            &self.lease,
            artifacts,
            &["**".into()],
            None,
        )
        .await
        .expect("prepare actual native candidate")
    }

    fn cleanup(self) {
        // Only called after every assertion succeeds; a failed fixture remains for diagnosis.
        assert!(
            self.root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ecorp-canonical-test-")
        );
        fs::remove_dir_all(self.root).expect("remove owned successful fixture");
    }
}

fn git_bytes(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn git(root: &Path, args: &[&str]) -> String {
    String::from_utf8(git_bytes(root, args))
        .unwrap()
        .trim()
        .to_owned()
}

fn policy(checks: Vec<VerifierCheck>) -> VerificationPolicy {
    VerificationPolicy {
        checks,
        manual_gate: None,
    }
}

fn node(script: &str) -> VerifierCheck {
    VerifierCheck::Command {
        program: "node".into(),
        args: vec!["-e".into(), script.into()],
        timeout_ms: 20_000,
        cache_suppression: None,
    }
}

async fn verify(
    prepared: &mut PreparedDeliverable,
    policy: &VerificationPolicy,
    artifacts: &[AdapterArtifact],
) -> VerificationReport {
    let (_sender, mut receiver) = watch::channel(false);
    let report = prepared
        .verify(policy, artifacts, &mut receiver)
        .await
        .expect("canonical verification setup")
        .expect("not cancelled");
    assert!(report.source.as_ref().unwrap().is_valid());
    for check in &report.checks {
        assert_eq!(
            check.payload["source"],
            serde_json::to_value(&report.source).unwrap()
        );
    }
    assert_snapshots_removed(prepared.run_id);
    report
}

fn assert_snapshots_removed(run_id: Uuid) {
    let parent = std::env::temp_dir().join("ecorp-verification-snapshots");
    if let Ok(entries) = fs::read_dir(parent) {
        assert!(
            entries.map(Result::unwrap).all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(&run_id.simple().to_string())),
            "owned verification snapshots leaked"
        );
    }
}

#[cfg(windows)]
#[tokio::test]
async fn canonical_private_git_timeout_reaps_descendants_before_snapshot_cleanup() {
    let root = std::env::temp_dir().join(format!("ecorp-private-git-timeout-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut command = tokio::process::Command::new("node");
    command.current_dir(&root).kill_on_drop(true).args([
        "-e",
        r#"const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',"require('node:fs').writeFileSync('child-ready.txt',String(process.pid));setTimeout(()=>{},6000)"],{cwd:process.cwd(),stdio:'ignore'});
setTimeout(()=>{},6000);"#,
    ]);
    let error = verification::run_private_git(&mut command, &[], Duration::from_secs(2))
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("timed out"), "{error:#}");
    assert!(
        root.join("child-ready.txt").exists(),
        "descendant must start before timeout"
    );
    let child_pid: u32 = fs::read_to_string(root.join("child-ready.txt"))
        .unwrap()
        .parse()
        .unwrap();
    let child_alive = crate::adapter::process_tree::process_is_alive(child_pid);
    let cleanup = fs::remove_dir_all(&root);
    if cleanup.is_err() {
        // The negative regression must not leave an indefinitely running child.
        // Its own fixed lifetime expires; retain the failed fixture for diagnosis.
        tokio::time::sleep(Duration::from_secs(6)).await;
    }
    assert!(
        cleanup.is_ok(),
        "private Git descendant still owns the snapshot: {cleanup:?}"
    );
    assert!(
        !child_alive,
        "private Git descendant survived awaited cleanup"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn canonical_private_git_success_reaps_descendants_before_snapshot_cleanup() {
    let root = std::env::temp_dir().join(format!("ecorp-private-git-success-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut command = tokio::process::Command::new("node");
    command.current_dir(&root).args([
        "-e",
        r#"const fs=require('node:fs'),{spawn}=require('node:child_process');
spawn(process.execPath,['-e',"require('node:fs').writeFileSync('child-ready.txt',String(process.pid));setTimeout(()=>{},6000)"],{cwd:process.cwd(),stdio:'ignore'});
const poll=setInterval(()=>{if(fs.existsSync('child-ready.txt'))process.exit(0)},10);
setTimeout(()=>process.exit(1),6000);"#,
    ]);
    let output = verification::run_private_git(&mut command, &[], Duration::from_secs(10))
        .await
        .unwrap();
    assert!(output.status.success());
    let child_pid: u32 = fs::read_to_string(root.join("child-ready.txt"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!crate::adapter::process_tree::process_is_alive(child_pid));
    fs::remove_dir_all(&root).expect("successful private Git must release the snapshot");
}

#[cfg(windows)]
#[tokio::test]
async fn canonical_export_supports_long_windows_paths_without_changing_git_config() {
    let mut fixture = Fixture::new();
    let mut long_source = fixture.root.join("native-git-path");
    while long_source.to_string_lossy().encode_utf16().count() < 210 {
        long_source = long_source.join("native-git-path");
    }
    fs::create_dir_all(long_source.parent().unwrap()).unwrap();
    fs::rename(&fixture.lease.path, &long_source).unwrap();
    fixture.lease.path = long_source;
    git(&fixture.lease.path, &["config", "core.longpaths", "false"]);
    let original_config = fs::read(fixture.lease.path.join(".git/config")).unwrap();
    fixture.write("tracked.txt", b"verified long-path export\n");

    let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
    let ref_path = fixture.lease.path.join(".git").join(&prepared.bundle_ref);
    assert!(ref_path.to_string_lossy().encode_utf16().count() > 260);
    assert!(prepared.bundle.to_string_lossy().encode_utf16().count() > 260);
    let report = verify(
        &mut prepared,
        &policy(vec![VerifierCheck::File {
            path: "tracked.txt".into(),
            min_bytes: 1,
        }]),
        &[],
    )
    .await;
    assert!(report.passed, "{report:?}");
    assert_eq!(
        report.checks[0].payload["sha256"],
        hex::encode(Sha256::digest(b"verified long-path export\n"))
    );
    let exported = prepared.export(&report).await.unwrap();
    let envelope: Value = serde_json::from_slice(&exported.bytes).unwrap();
    let bundle_path = fixture.root.join("verified.bundle");
    fs::write(
        &bundle_path,
        BASE64
            .decode(envelope["git_bundle_base64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    git(
        &fixture.lease.path,
        &[
            "-c",
            "core.longpaths=true",
            "bundle",
            "verify",
            bundle_path.to_str().unwrap(),
        ],
    );
    assert_eq!(
        git(
            &fixture.lease.path,
            &["-c", "core.longpaths=true", "rev-parse", "HEAD^{tree}"]
        ),
        report.source.unwrap().tree
    );
    assert!(!ref_path.exists(), "temporary export ref must be removed");
    assert_eq!(
        fs::read(fixture.lease.path.join(".git/config")).unwrap(),
        original_config
    );
    assert_eq!(
        fs::read(fixture.lease.path.join("tracked.txt")).unwrap(),
        b"verified long-path export\n"
    );
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_private_git_rejects_excess_diagnostic_output() {
    let mut command = tokio::process::Command::new("node");
    command.args([
        "-e",
        "process.stdout.write(Buffer.alloc(17*1024*1024));setTimeout(()=>{},6000)",
    ]);
    let error = verification::run_private_git(&mut command, &[], Duration::from_secs(10))
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("output exceeds its bound"),
        "{error:#}"
    );
}

#[tokio::test]
async fn canonical_migration_checks_cover_conversion_selection_and_clean_runner_commits() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let historical: Value =
        serde_json::from_slice(&fs::read(repository.join("db/migrations/manifest.json")).unwrap())
            .unwrap();
    let checker = fs::read(repository.join("tools/check_migrations.mjs")).unwrap();
    let migration_path = "db/migrations/9999_canonical_fixture.sql";
    // The first five cases reproduce feedback 5735035194. The sixth supplies a correct
    // canonical manifest despite CRLF physical source. Historical hashes are never regenerated.
    for (name, autocrlf, attribute, bytes, canonical_manifest, omit_manifest, expected) in [
        (
            "autocrlf_crlf",
            true,
            "",
            &b"SELECT 9999;\r\n"[..],
            false,
            false,
            false,
        ),
        (
            "explicit_lf_crlf",
            false,
            "text eol=lf",
            &b"SELECT 9999;\r\n"[..],
            false,
            false,
            false,
        ),
        (
            "lf_control",
            true,
            "",
            &b"SELECT 9999;\n"[..],
            false,
            false,
            true,
        ),
        (
            "binary_crlf_control",
            true,
            "-text",
            &b"SELECT 9999;\r\n"[..],
            false,
            false,
            true,
        ),
        (
            "omitted_manifest",
            false,
            "",
            &b"SELECT 9999;\n"[..],
            false,
            true,
            false,
        ),
        (
            "canonical_manifest_crlf",
            true,
            "",
            &b"SELECT 9999;\r\n"[..],
            true,
            false,
            true,
        ),
    ] {
        let mut fixture = Fixture::new();
        fixture.write("tools/check_migrations.mjs", &checker);
        fixture.write(
            "db/migrations/manifest.json",
            &serde_json::to_vec_pretty(&historical).unwrap(),
        );
        let mut attributes = String::new();
        for migration in historical["migrations"].as_array().unwrap() {
            let file = migration["file"].as_str().unwrap();
            let path = format!("db/migrations/{file}");
            let bytes = fs::read(repository.join(&path)).unwrap();
            assert_eq!(hex::encode(Sha384::digest(&bytes)), migration["sha384"]);
            fixture.write(&path, &bytes);
            attributes.push_str(&format!("{path} -text\n"));
        }
        if !attribute.is_empty() {
            attributes.push_str(&format!("{migration_path} {attribute}\n"));
        }
        fixture.write(".gitattributes", attributes.as_bytes());
        fixture.commit_base();
        git(
            &fixture.lease.path,
            &[
                "config",
                "core.autocrlf",
                if autocrlf { "true" } else { "false" },
            ],
        );
        fixture.write(migration_path, bytes);
        let mut manifest = historical.clone();
        manifest["migrations"].as_array_mut().unwrap().push(json!({
            "version": 9999, "file": "9999_canonical_fixture.sql",
            "sha384": hex::encode(Sha384::digest(if canonical_manifest { b"SELECT 9999;\n" } else { bytes })),
        }));
        fixture.write(
            "db/migrations/manifest.json",
            &serde_json::to_vec_pretty(&manifest).unwrap(),
        );
        let policy = policy(vec![VerifierCheck::Test {
            program: "node".into(),
            args: vec!["tools/check_migrations.mjs".into()],
            timeout_ms: 20_000,
            cache_suppression: None,
        }]);
        let physical = verifier::verify(&policy, &fixture.lease.path, &[]).await;
        assert_eq!(
            physical.passed, !canonical_manifest,
            "physical {name}: {physical:?}"
        );
        let migration_only = [migration_path];
        let mut prepared = fixture
            .prepare(if omit_manifest { &migration_only } else { &[] }, &[])
            .await;
        let raw = git_bytes(
            &fixture.lease.path,
            &[
                "cat-file",
                "blob",
                &format!("{}:{migration_path}", prepared.tree),
            ],
        );
        let report = verify(&mut prepared, &policy, &[]).await;
        assert_eq!(report.passed, expected, "canonical {name}: {report:?}");
        let source = report.source.as_ref().unwrap();
        assert_eq!(source.tree, prepared.tree);
        assert_eq!(source.base_commit, fixture.lease.base_commit);
        assert_eq!(source.ignored_input_count, 0);
        if expected {
            let exported = prepared
                .export(&report)
                .await
                .expect("actual runner-created commit and deliverable");
            let envelope: Value = serde_json::from_slice(&exported.bytes).unwrap();
            let head = exported.head_commit.as_deref().unwrap();
            assert_eq!(exported.verified_tree, source.tree);
            assert_eq!(
                git(
                    &fixture.lease.path,
                    &["rev-parse", &format!("{head}^{{tree}}")]
                ),
                source.tree
            );
            assert_eq!(
                envelope["source_verification"],
                serde_json::to_value(source).unwrap()
            );
            assert_eq!(
                envelope["verification_sha256"],
                hex::encode(Sha256::digest(serde_json::to_vec(&report).unwrap()))
            );
            let archived = envelope["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|change| change["path"] == migration_path)
                .unwrap();
            assert_eq!(
                BASE64
                    .decode(archived["content_base64"].as_str().unwrap())
                    .unwrap(),
                raw
            );
            let checkout = fixture.root.join("clean-export");
            git(
                &fixture.root,
                &[
                    "clone",
                    "--no-checkout",
                    "--no-hardlinks",
                    fixture.lease.path.to_str().unwrap(),
                    checkout.to_str().unwrap(),
                ],
            );
            git(&checkout, &["config", "core.autocrlf", "false"]);
            git(&checkout, &["checkout", "--detach", head]);
            let clean = verifier::verify(&policy, &checkout, &[]).await;
            assert!(
                clean.passed,
                "clean runner-created checkout {name}: {clean:?}"
            );
            assert_eq!(fs::read(checkout.join(migration_path)).unwrap(), raw);
            for migration in historical["migrations"].as_array().unwrap() {
                let path = format!("db/migrations/{}", migration["file"].as_str().unwrap());
                assert_eq!(
                    git_bytes(&checkout, &["cat-file", "blob", &format!("{head}:{path}")]),
                    fs::read(repository.join(&path)).unwrap()
                );
                assert_eq!(
                    hex::encode(Sha384::digest(fs::read(checkout.join(path)).unwrap())),
                    migration["sha384"]
                );
            }
            println!(
                "{}",
                json!({"case":name,"physical_passed":physical.passed,"canonical_passed":true,"clean_export_passed":true,"tree":source.tree,"head":head,"historical_migrations_unchanged":historical["migrations"].as_array().unwrap().len(),"physical_sha256":hex::encode(Sha256::digest(bytes)),"canonical_sha256":hex::encode(Sha256::digest(&raw))})
            );
        } else {
            assert!(
                prepared.export(&report).await.is_err(),
                "failed canonical policy must not export"
            );
            assert_eq!(
                git(&fixture.lease.path, &["rev-parse", "HEAD"]),
                fixture.lease.base_commit
            );
            println!(
                "{}",
                json!({"case":name,"physical_passed":physical.passed,"canonical_passed":false,"export_rejected":true,"tree":source.tree,"checks":report.checks})
            );
        }
        drop(prepared);
        fixture.cleanup();
    }
}

#[tokio::test]
async fn canonical_inputs_preserve_selected_tree_and_separate_dependencies_and_artifacts() {
    let fixture = Fixture::new();
    fixture.write("tracked.txt", b"selected\n");
    fixture.write("other.txt", b"omitted physical change\n");
    fixture.write("omitted.txt", b"not selected\n");
    fixture.write("deps/cache.txt", b"dependency bytes\n");
    fixture.write(
        "ignored/staged.txt",
        b"newly staged source must remain omitted\n",
    );
    git(&fixture.lease.path, &["add", "-f", "ignored/staged.txt"]);
    fixture.write(".env", b"fixture-secret-marker-not-a-real-secret\n");
    fixture.write("ignored/provider.txt", b"separate provider evidence\n");
    fixture.write(
        "physical-ignore-only.txt",
        b"not ignored by canonical policy\n",
    );
    fixture.write(
        ".gitignore",
        b"deps/\nbuild/\nignored/\n.env\nphysical-ignore-only.txt\n",
    );
    let artifact = AdapterArtifact {
        path: fixture.lease.path.join("ignored/provider.txt"),
        media_type: "text/plain".into(),
        sha256: hex::encode(Sha256::digest(b"separate provider evidence\n")),
        bytes: b"separate provider evidence\n".len(),
    };
    let artifacts = [artifact];
    let mut prepared = fixture.prepare(&["tracked.txt"], &artifacts).await;
    let report = verify(&mut prepared, &policy(vec![
        node("const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('tracked.txt','utf8'),'selected\\n');a.equal(fs.readFileSync('other.txt','utf8'),'other before\\n');a.equal(fs.readFileSync('deps/cache.txt','utf8'),'dependency bytes\\n');for(const p of ['omitted.txt','ignored/staged.txt','.env','ignored/provider.txt','physical-ignore-only.txt'])a.equal(fs.existsSync(p),false,p);const remote=require('node:child_process').spawnSync('git',['config','--get','remote.origin.url']);a.equal(remote.status,1);a.equal(remote.stdout.length,0)"),
        VerifierCheck::Artifact { min_bytes: 1 },
    ]), &artifacts).await;
    assert!(report.passed, "{report:?}");
    assert_eq!(report.source.as_ref().unwrap().ignored_input_count, 1);
    assert_eq!(report.source.as_ref().unwrap().ignored_input_bytes, 17);
    let exported = prepared.export(&report).await.unwrap();
    assert_eq!(
        git(
            &fixture.lease.path,
            &[
                "show",
                &format!("{}:other.txt", exported.head_commit.unwrap())
            ]
        ),
        "other before"
    );
    assert_eq!(
        fs::read(fixture.lease.path.join("other.txt")).unwrap(),
        b"omitted physical change\n"
    );
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_export_is_frozen_despite_later_physical_edits_and_real_index_staging() {
    let fixture = Fixture::new();
    fixture.write("tracked.txt", b"verified\n");
    let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
    let report = verify(&mut prepared, &policy(vec![node("require('node:assert/strict').equal(require('node:fs').readFileSync('tracked.txt','utf8'),'verified\\n')")]), &[]).await;
    assert!(report.passed, "{report:?}");
    fixture.write("tracked.txt", b"later physical change\n");
    fixture.write("other.txt", b"later staged change\n");
    git(&fixture.lease.path, &["add", "tracked.txt", "other.txt"]);
    let exported = prepared.export(&report).await.unwrap();
    let head = exported.head_commit.unwrap();
    assert_eq!(
        git_bytes(
            &fixture.lease.path,
            &["cat-file", "blob", &format!("{head}:tracked.txt")]
        ),
        b"verified\n"
    );
    assert_eq!(
        fs::read(fixture.lease.path.join("tracked.txt")).unwrap(),
        b"later physical change\n"
    );
    assert_eq!(
        git(&fixture.lease.path, &["diff", "--cached", "--name-only"]),
        "other.txt"
    );
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_export_rejects_report_index_and_original_head_tampering() {
    for alteration in ["report", "index", "head"] {
        let fixture = Fixture::new();
        fixture.write("tracked.txt", b"verified\n");
        let mut prepared = fixture.prepare(&[], &[]).await;
        let mut report = verify(
            &mut prepared,
            &policy(vec![VerifierCheck::File {
                path: "tracked.txt".into(),
                min_bytes: 1,
            }]),
            &[],
        )
        .await;
        assert!(report.passed);
        match alteration {
            "report" => {
                report.checks[0].payload["source"]["ignored_input_sha256"] = json!("a".repeat(64))
            }
            "index" => {
                git_success(
                    &fixture.lease.path,
                    &prepared.index,
                    &["read-tree".into(), fixture.lease.base_commit.clone().into()],
                )
                .await
                .unwrap();
            }
            "head" => {
                git(
                    &fixture.lease.path,
                    &["commit", "--allow-empty", "-m", "concurrent fixture commit"],
                );
            }
            _ => unreachable!(),
        }
        let before = git(&fixture.lease.path, &["rev-parse", "HEAD"]);
        assert!(
            prepared.export(&report).await.is_err(),
            "accepted changed {alteration}"
        );
        assert_eq!(git(&fixture.lease.path, &["rev-parse", "HEAD"]), before);
        drop(prepared);
        fixture.cleanup();
    }
}

#[tokio::test]
async fn canonical_checks_reject_raw_source_index_head_and_untracked_mutation() {
    for script in [
        "require('node:fs').writeFileSync('tracked.txt','verified\\r\\n')",
        "require('node:child_process').execFileSync('git',['read-tree','HEAD^'])",
        "require('node:fs').writeFileSync('.git/HEAD','ref: refs/heads/forged\\n')",
        "require('node:fs').writeFileSync('new-source.txt','not in candidate')",
    ] {
        let fixture = Fixture::new();
        fixture.write("tracked.txt", b"verified\n");
        let mut prepared = fixture.prepare(&[], &[]).await;
        let report = verify(&mut prepared, &policy(vec![node(script)]), &[]).await;
        assert!(!report.passed, "accepted mutation {script}: {report:?}");
        assert!(
            report.checks[0].payload["source_integrity_error"].is_string(),
            "{report:?}"
        );
        assert!(prepared.export(&report).await.is_err());
        assert_eq!(
            fs::read(fixture.lease.path.join("tracked.txt")).unwrap(),
            b"verified\n"
        );
        drop(prepared);
        fixture.cleanup();
    }
}

#[tokio::test]
async fn canonical_private_git_contains_only_candidate_and_base_history() {
    // Hosted Windows keeps the checkout on D: and verification snapshots on C:.
    // A temp-only source fixture cannot exercise that native cross-volume export.
    let mut fixture = Fixture::new_in(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
    println!("canonical snapshots: {}", std::env::temp_dir().display());
    fixture.write("ancestor-only.txt", b"excluded historical bytes\n");
    fixture.commit_base();
    let ancestor = fixture.lease.base_commit.clone();
    let ancestor_blob = git(
        &fixture.lease.path,
        &["rev-parse", "HEAD:ancestor-only.txt"],
    );
    git(
        &fixture.lease.path,
        &["tag", "historical-fixture", &ancestor],
    );
    fs::remove_file(fixture.lease.path.join("ancestor-only.txt")).unwrap();
    fixture.write("tracked.txt", b"base bytes\n");
    fixture.commit_base();
    // Exercise already-packed objects and preserve a real source config/ref/index.
    git(&fixture.lease.path, &["repack", "-adq"]);
    git(
        &fixture.lease.path,
        &["config", "ecorp.fixture", "source-only"],
    );
    fixture.write("other.txt", b"unselected staged bytes\n");
    git(&fixture.lease.path, &["add", "other.txt"]);
    let config = fs::read(fixture.lease.path.join(".git/config")).unwrap();
    let index = fs::read(fixture.lease.path.join(".git/index")).unwrap();
    let refs = git(&fixture.lease.path, &["show-ref"]);
    fixture.write("tracked.txt", b"candidate bytes\n");
    let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
    let script = format!(
        "const expected = {};{}",
        json!({
            "base": fixture.lease.base_commit,
            "tree": prepared.tree,
            "excluded": [ancestor, ancestor_blob],
        }),
        r#"
const fs = require('node:fs'), cp = require('node:child_process'), a = require('node:assert/strict');
const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const head = git('rev-parse', 'HEAD');
a.deepEqual(git('rev-list', 'HEAD').split('\n'), [head, expected.base]);
a.equal(git('rev-parse', 'HEAD^{tree}'), expected.tree);
a.equal(fs.readFileSync('.git/shallow', 'utf8'), expected.base + '\n');
for (const oid of expected.excluded) a.notEqual(cp.spawnSync('git', ['cat-file', '-e', oid]).status, 0);
const commits = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)')
    .split('\n').filter(line => line.endsWith(' commit')).map(line => line.split(' ')[0]).sort();
a.deepEqual(commits, [head, expected.base].sort());
a.equal(git('for-each-ref'), '');
a.equal(cp.spawnSync('git', ['config', '--get', 'ecorp.fixture']).status, 1);
for (const path of ['.git/objects/info/alternates', '.git/commondir']) a.equal(fs.existsSync(path), false);
git('fsck', '--connectivity-only', '--no-reflogs', '--no-progress');
a.equal(fs.readFileSync('tracked.txt', 'utf8'), 'candidate bytes\n');
a.equal(fs.readFileSync('other.txt', 'utf8'), 'other before\n');
"#,
    );
    let report = verify(&mut prepared, &policy(vec![node(&script)]), &[]).await;
    assert!(report.passed, "{report:?}");
    assert_eq!(
        fs::read(fixture.lease.path.join(".git/config")).unwrap(),
        config
    );
    assert_eq!(
        fs::read(fixture.lease.path.join(".git/index")).unwrap(),
        index
    );
    assert_eq!(git(&fixture.lease.path, &["show-ref"]), refs);
    assert_eq!(
        git(&fixture.lease.path, &["rev-parse", "HEAD"]),
        fixture.lease.base_commit
    );
    assert!(!fixture.lease.path.join(".git/shallow").exists());
    assert_eq!(
        fs::read(fixture.lease.path.join("other.txt")).unwrap(),
        b"unselected staged bytes\n"
    );
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_snapshot_streams_packs_larger_than_diagnostic_output_limit() {
    let mut fixture = Fixture::new();
    let bytes = vec![b'x'; 17 * 1024 * 1024];
    fixture.write("large-base.txt", &bytes);
    fixture.commit_base();
    fixture.write("tracked.txt", b"candidate bytes\n");
    let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
    let report = verify(
        &mut prepared,
        &policy(vec![
            VerifierCheck::File {
                path: "large-base.txt".into(),
                min_bytes: bytes.len() as u64,
            },
            node("const fs=require('node:fs'),a=require('node:assert/strict');const p='.git/objects/pack/';a.ok(fs.readdirSync(p).filter(f=>f.endsWith('.pack')).some(f=>fs.statSync(p+f).size>16*1024*1024));a.equal(fs.existsSync('.git/ecorp-transfer.pack'),false)"),
        ]),
        &[],
    )
    .await;
    assert!(report.passed, "{report:?}");
    assert_eq!(
        report.checks[0].payload["sha256"],
        hex::encode(Sha256::digest(&bytes))
    );
    assert_eq!(
        git(&fixture.lease.path, &["rev-parse", "HEAD"]),
        fixture.lease.base_commit
    );
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_commands_have_private_git_context_and_fresh_build_outputs() {
    let fixture = Fixture::new();
    fixture.write("tracked.txt", b"verified\n");
    let mut prepared = fixture.prepare(&[], &[]).await;
    let expected_tree = serde_json::to_string(&prepared.tree).unwrap();
    let report = verify(&mut prepared, &policy(vec![
        node(&format!("const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');a.equal(cp.execFileSync('git',['rev-parse','HEAD^{{tree}}'],{{encoding:'utf8'}}).trim(),{expected_tree});fs.mkdirSync('build');fs.writeFileSync('build/cache.txt','private build output')")),
        node("require('node:assert/strict').equal(require('node:fs').existsSync('build/cache.txt'),false)"),
    ]), &[]).await;
    assert!(report.passed, "{report:?}");
    assert!(!fixture.lease.path.join("build").exists());
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_materialization_ignores_smudge_ident_and_archive_attributes_after_selection() {
    let mut fixture = Fixture::new();
    fixture.write("clean.cjs", b"process.stdout.write(require('node:fs').readFileSync(0,'utf8').replaceAll('physical','canonical'));\n");
    fixture.write(
        ".gitattributes",
        b"filtered.txt filter=fixture ident export-subst export-ignore\n",
    );
    fixture.commit_base();
    git(
        &fixture.lease.path,
        &["config", "filter.fixture.clean", "node clean.cjs"],
    );
    git(
        &fixture.lease.path,
        &[
            "config",
            "filter.fixture.smudge",
            "node -e \"process.stdout.write('wrong smudged bytes')\"",
        ],
    );
    fixture.write("filtered.txt", b"physical $Id: expanded $\n");
    let mut prepared = fixture.prepare(&["filtered.txt"], &[]).await;
    let canonical = b"canonical $Id$\n";
    let report = verify(&mut prepared, &policy(vec![node("require('node:assert/strict').equal(require('node:fs').readFileSync('filtered.txt','utf8'),'canonical $Id$\\n')")]), &[]).await;
    assert!(report.passed, "{report:?}");
    let exported = prepared.export(&report).await.unwrap();
    let envelope: Value = serde_json::from_slice(&exported.bytes).unwrap();
    let change = envelope["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["path"] == "filtered.txt")
        .unwrap();
    assert_eq!(
        BASE64
            .decode(change["content_base64"].as_str().unwrap())
            .unwrap(),
        canonical
    );
    assert_eq!(
        git_bytes(
            &fixture.lease.path,
            &[
                "cat-file",
                "blob",
                &format!("{}:filtered.txt", exported.head_commit.unwrap())
            ]
        ),
        canonical
    );
    assert_eq!(
        fs::read(fixture.lease.path.join("filtered.txt")).unwrap(),
        b"physical $Id: expanded $\n"
    );
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_links_rebase_internal_dependencies_and_reject_external_targets() {
    let mut fixture = Fixture::new();
    fixture.write("deps/package/value.txt", b"dependency\n");
    git(&fixture.lease.path, &["config", "core.symlinks", "true"]);
    #[cfg(unix)]
    std::os::unix::fs::symlink("deps/package", fixture.lease.path.join("source-alias")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(r"deps\package", fixture.lease.path.join("source-alias"))
        .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        "deps/package/value.txt",
        fixture.lease.path.join("source-file-alias"),
    )
    .unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(
        r"deps\package\value.txt",
        fixture.lease.path.join("source-file-alias"),
    )
    .unwrap();
    fixture.commit_base();
    assert_eq!(
        git_bytes(&fixture.lease.path, &["show", "HEAD:source-alias"]),
        b"deps/package"
    );
    assert_eq!(
        git_bytes(&fixture.lease.path, &["show", "HEAD:source-file-alias"]),
        b"deps/package/value.txt"
    );
    let create_link = |target: &Path, name: &Path| {
        let result = Command::new("node")
            .args(["-e", "require('node:fs').symlinkSync(process.argv[1],process.argv[2],process.platform==='win32'?'junction':'dir')"])
            .arg(target).arg(name).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    };
    create_link(
        &fixture.lease.path.join("deps/package"),
        &fixture.lease.path.join("deps/internal"),
    );
    fixture.write("tracked.txt", b"selected\n");
    let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
    let report = verify(&mut prepared, &policy(vec![node(
        "const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');for(const link of ['source-alias','deps/internal']){a.equal(fs.readFileSync(p.join(link,'value.txt'),'utf8'),'dependency\\n');a.equal(p.isAbsolute(fs.readlinkSync(link)),false);const real=fs.realpathSync(link);a.equal(real,fs.realpathSync('deps/package'));a.ok(real.startsWith(fs.realpathSync('.')+p.sep))}a.equal(fs.readFileSync('source-file-alias','utf8'),'dependency\\n');a.equal(fs.realpathSync('source-file-alias'),fs.realpathSync('deps/package/value.txt'))",
    )]), &[]).await;
    assert!(report.passed, "{report:?}");
    assert_eq!(report.source.as_ref().unwrap().ignored_input_count, 2);
    let exported = prepared.export(&report).await.unwrap();
    assert_eq!(
        git(
            &fixture.lease.path,
            &[
                "rev-parse",
                &format!("{}^{{tree}}", exported.head_commit.unwrap())
            ]
        ),
        report.source.unwrap().tree
    );
    assert_eq!(
        git_bytes(&fixture.lease.path, &["show", "HEAD:source-alias"]),
        b"deps/package"
    );
    assert_eq!(
        git_bytes(&fixture.lease.path, &["show", "HEAD:source-file-alias"]),
        b"deps/package/value.txt"
    );
    drop(prepared);

    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.txt"), b"must not be copied").unwrap();
    create_link(&outside, &fixture.lease.path.join("deps/external"));
    let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
    let (_sender, mut cancellation) = watch::channel(false);
    let error = prepared
        .verify(
            &policy(vec![node("process.exit(0)")]),
            &[],
            &mut cancellation,
        )
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("escapes its source workspace"),
        "{error:#}"
    );
    assert!(prepared.verified_report_sha256.is_none());
    assert_snapshots_removed(prepared.run_id);
    drop(prepared);
    fixture.cleanup();
}

#[tokio::test]
async fn canonical_git_routing_isolated_from_inherited_environment() {
    const MARKER: &str = "ECORP_CANONICAL_ROUTING_FIXTURE";
    if let Some(root) = std::env::var_os(MARKER) {
        let root = PathBuf::from(root);
        let fixture = Fixture {
            lease: WorkspaceLease {
                path: root.join("source"),
                branch: "main".into(),
                base_ref: "main".into(),
                base_commit: std::env::var("ECORP_CANONICAL_ROUTING_BASE").unwrap(),
            },
            root,
        };
        let mut prepared = fixture.prepare(&["tracked.txt"], &[]).await;
        let report = verify(&mut prepared, &policy(vec![node(
            "const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');a.equal(fs.readFileSync('tracked.txt','utf8'),'selected\\n');a.equal(cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim().replaceAll('\\\\','/'),process.cwd().replaceAll('\\\\','/'))",
        )]), &[]).await;
        assert!(report.passed, "{report:?}");
        prepared.export(&report).await.unwrap();
        return;
    }
    let fixture = Fixture::new();
    fixture.write("tracked.txt", b"selected\n");
    let unrelated = Fixture::new();
    let index = fs::read(unrelated.lease.path.join(".git/index")).unwrap();
    let trace = unrelated.root.join("trace.json");
    let output = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "deliverable::canonical_tests::canonical_git_routing_isolated_from_inherited_environment", "--nocapture"])
        .env(MARKER, &fixture.root)
        .env("ECORP_CANONICAL_ROUTING_BASE", &fixture.lease.base_commit)
        .env("GIT_DIR", unrelated.lease.path.join(".git"))
        .env("GIT_WORK_TREE", &unrelated.lease.path)
        .env("GIT_INDEX_FILE", unrelated.lease.path.join(".git/index"))
        .env("GIT_OBJECT_DIRECTORY", unrelated.lease.path.join(".git/objects"))
        .env("GIT_NAMESPACE", "unrelated")
        .env("GIT_TRACE2_EVENT", &trace)
        .output().await.unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!trace.exists());
    assert_eq!(
        fs::read(unrelated.lease.path.join(".git/index")).unwrap(),
        index
    );
    assert_eq!(
        git(&unrelated.lease.path, &["rev-parse", "HEAD"]),
        unrelated.lease.base_commit
    );
    fixture.cleanup();
    unrelated.cleanup();
}

#[tokio::test]
async fn canonical_cancellation_cleans_owned_snapshots_and_cannot_authorize_export() {
    let fixture = Fixture::new();
    fixture.write("tracked.txt", b"verified\n");
    let mut prepared = fixture.prepare(&[], &[]).await;
    let earlier = verify(&mut prepared, &policy(vec![node("process.exit(0)")]), &[]).await;
    assert!(earlier.passed);
    let marker = fixture.root.join("verifier-started");
    let script = format!(
        "require('node:fs').writeFileSync({},'started');setInterval(()=>{{}},1000)",
        serde_json::to_string(&marker.to_str().unwrap()).unwrap()
    );
    let (sender, mut receiver) = watch::channel(false);
    let cancel = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(15), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("verifier started");
        sender.send(true).unwrap();
    });
    let report = prepared
        .verify(&policy(vec![node(&script)]), &[], &mut receiver)
        .await
        .unwrap();
    cancel.await.unwrap();
    assert!(report.is_none());
    assert!(prepared.verified_report_sha256.is_none());
    assert!(
        prepared.export(&earlier).await.is_err(),
        "cancellation revokes the earlier passing report"
    );
    assert_snapshots_removed(prepared.run_id);
    assert_eq!(
        git(&fixture.lease.path, &["rev-parse", "HEAD"]),
        fixture.lease.base_commit
    );
    let scratch = prepared.index.clone();
    drop(prepared);
    assert!(!scratch.exists());
    fixture.cleanup();
}
