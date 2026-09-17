// This file is included inside artifacts::tests, never in a production binary.
// The launcher must independently own the PostgreSQL process; this child also
// checks the exact database capability before connecting or creating its schema.
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../crony-store/src/dependency_artifact_test_fixture.rs"
));

const ISSUE297_CASES: [&str; 13] = [
    "altered-content",
    "undeclared-file",
    "cross-corp",
    "cross-task",
    "cross-run",
    "cross-recovery",
    "cross-room",
    "traversal",
    "prompt-byte-limit",
    "envelope-byte-limit",
    "cancelled-parent",
    "failed-parent",
    "unauthorized-artifact",
];
const ISSUE297_BASE: &str = "6162bb2ed44a1fe1c7ffc726dd9bedc799b398bd";
const ISSUE297_VERIFIER: &str = "abababababababababababababababababababababababababababababababab";

struct Issue297Admission {
    case_id: &'static str,
    nonce: Uuid,
    database_url: reqwest::Url,
    database: String,
    port: u16,
    schema: String,
}

impl Issue297Admission {
    fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let required =
            |name| get(name).with_context(|| format!("missing fixture capability: {name}"));
        let selected = required("ECORP_ISSUE297_NATIVE_CASE")?;
        let case_index = ISSUE297_CASES
            .iter()
            .position(|case| *case == selected)
            .context("unknown native fixture case")?;
        let nonce_text = required("ECORP_ISSUE297_FIXTURE_NONCE")?;
        let nonce = Uuid::parse_str(&nonce_text).context("invalid fixture nonce")?;
        anyhow::ensure!(
            nonce.get_version_num() == 4
                && nonce.get_variant() == uuid::Variant::RFC4122
                && nonce.to_string() == nonce_text,
            "fixture nonce must be a canonical UUID v4"
        );
        anyhow::ensure!(
            required("ECORP_ISSUE297_FIXTURE_DATABASE_OWNED")? == nonce_text,
            "fixture database ownership capability does not match"
        );
        // Do not put supplied connection strings (which may contain passwords)
        // in diagnostics, and never consult DATABASE_URL or a default database.
        let database_url = reqwest::Url::parse(&required("ECORP_ISSUE297_FIXTURE_DATABASE_URL")?)
            .map_err(|_| anyhow!("invalid fixture database URL"))?;
        let port = database_url
            .port()
            .context("fixture requires an explicit port")?;
        let database = format!("ecorp_issue297_{}", nonce.simple());
        anyhow::ensure!(
            matches!(database_url.scheme(), "postgres" | "postgresql")
                && database_url.host_str() == Some("127.0.0.1")
                && port >= 49_152
                && port != 55_483
                && database_url.path() == format!("/{database}")
                && !database_url.username().is_empty()
                && database_url.query().is_none()
                && database_url.fragment().is_none(),
            "fixture requires a nonce-named disposable database on explicit loopback high port"
        );
        Ok(Self {
            case_id: ISSUE297_CASES[case_index],
            nonce,
            database_url,
            database,
            port,
            schema: format!("issue297_{}_{}", nonce.simple(), case_index),
        })
    }
}

fn issue297_test_environment() -> std::collections::BTreeMap<String, String> {
    let nonce = "ee1ba3db-5407-4229-954f-36d5c6c46320";
    [
        ("ECORP_ISSUE297_NATIVE_CASE", "altered-content".to_owned()),
        ("ECORP_ISSUE297_FIXTURE_NONCE", nonce.to_owned()),
        ("ECORP_ISSUE297_FIXTURE_DATABASE_OWNED", nonce.to_owned()),
        (
            "ECORP_ISSUE297_FIXTURE_DATABASE_URL",
            format!(
                "postgres://fixture@127.0.0.1:55432/ecorp_issue297_{}",
                nonce.replace('-', "")
            ),
        ),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

#[test]
fn issue297_native_catalog_and_guard_are_fail_closed_offline() {
    let mut environment = issue297_test_environment();
    let unique = ISSUE297_CASES
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), 13);
    for case in ISSUE297_CASES {
        environment.insert("ECORP_ISSUE297_NATIVE_CASE".to_owned(), case.to_owned());
        let admission = Issue297Admission::parse(|name| environment.get(name).cloned()).unwrap();
        assert_eq!(admission.case_id, case);
        assert!(admission.schema.len() < 63);
    }
    for key in issue297_test_environment().keys() {
        let mut missing = environment.clone();
        missing.remove(key);
        assert!(Issue297Admission::parse(|name| missing.get(name).cloned()).is_err());
    }
    for (key, invalid) in [
        ("ECORP_ISSUE297_NATIVE_CASE", "all"),
        ("ECORP_ISSUE297_NATIVE_CASE", "cross-room --ignored"),
        (
            "ECORP_ISSUE297_FIXTURE_NONCE",
            "00000000-0000-0000-0000-000000000000",
        ),
        (
            "ECORP_ISSUE297_FIXTURE_NONCE",
            "EE1BA3DB-5407-4229-954F-36D5C6C46320",
        ),
        (
            "ECORP_ISSUE297_FIXTURE_NONCE",
            "ee1ba3db54074229954f36d5c6c46320",
        ),
        ("ECORP_ISSUE297_FIXTURE_DATABASE_OWNED", "yes"),
    ] {
        let mut invalid_environment = environment.clone();
        invalid_environment.insert(key.to_owned(), invalid.to_owned());
        assert!(Issue297Admission::parse(|name| invalid_environment.get(name).cloned()).is_err());
    }
    let only_application_database = std::collections::BTreeMap::from([(
        "DATABASE_URL".to_owned(),
        "postgres://application@127.0.0.1:5432/ecorp".to_owned(),
    )]);
    assert!(Issue297Admission::parse(|name| only_application_database.get(name).cloned()).is_err());
}

#[test]
fn issue297_native_database_guard_rejects_unowned_targets_offline() {
    let environment = issue297_test_environment();
    let valid = &environment["ECORP_ISSUE297_FIXTURE_DATABASE_URL"];
    for invalid in [
        valid.replace("127.0.0.1", "localhost"),
        valid.replace("127.0.0.1", "192.0.2.1"),
        valid.replace("127.0.0.1", "[::1]"),
        valid.replace(":55432", ":5432"),
        valid.replace(":55432", ":55483"),
        valid.replace(":55432", ""),
        valid.replace("postgres:", "https:"),
        valid.replace("fixture@", ""),
        valid.replace("ecorp_issue297_ee1ba3db54074229954f36d5c6c46320", "ecorp"),
        valid.replace(
            "ecorp_issue297_ee1ba3db54074229954f36d5c6c46320",
            "postgres",
        ),
        format!("{valid}?options=-csearch_path=public"),
        format!("{valid}?host=remote"),
        format!("{valid}#unowned"),
        format!("{valid}/extra"),
    ] {
        let mut invalid_environment = environment.clone();
        invalid_environment.insert("ECORP_ISSUE297_FIXTURE_DATABASE_URL".to_owned(), invalid);
        assert!(Issue297Admission::parse(|name| invalid_environment.get(name).cloned()).is_err());
    }
}

fn issue297_change(path: &str, content: &[u8]) -> Value {
    json!({
        "path": path, "status": "A", "mode": "100644", "media_type": "text/plain",
        "sha256": hex::encode(Sha256::digest(content)), "bytes": content.len(),
        "content_base64": BASE64.encode(content),
    })
}

fn issue297_document(changes: Vec<Value>) -> Value {
    let patch = b"diff --git a/handoff.md b/handoff.md\n";
    json!({
        "schema_version": 1, "form": "typed_artifact_set",
        "base_commit": ISSUE297_BASE, "head_commit": null,
        "branch": "crony/issue297-native-fixture", "verification_sha256": ISSUE297_VERIFIER,
        "patch_sha256": hex::encode(Sha256::digest(patch)), "patch_base64": BASE64.encode(patch),
        "git_bundle_sha256": null, "git_bundle_base64": null, "changes": changes,
    })
}

async fn issue297_sign(
    artifacts: &ArtifactStore,
    identity: ArtifactIdentity<'_>,
    bytes: &[u8],
    typed: bool,
) -> StoredArtifact {
    let mut payload = json!({
        "sha256": hex::encode(Sha256::digest(bytes)), "bytes": bytes.len(),
        "media_type": if typed { crate::dependency_source::TYPED_SOURCE_MEDIA_TYPE } else { "text/plain" },
        "content_base64": BASE64.encode(bytes),
    });
    if typed {
        payload["artifact_role"] = json!("source_deliverable");
        payload["file_name"] = json!("ecorp-artifact-set.json");
        payload["form"] = json!("typed_artifact_set");
        payload["verification_sha256"] = json!(ISSUE297_VERIFIER);
        payload["base_commit"] = json!(ISSUE297_BASE);
        payload["branch"] = json!("crony/issue297-native-fixture");
        payload["integration_state"] = json!("ready_for_review");
    }
    let artifact = artifacts
        .ingest(identity, &payload, Utc::now() + chrono::Duration::days(1))
        .await
        .expect("ingest genuinely signed fixture artifact");
    assert_eq!(
        artifacts.read_verified(&artifact).await.unwrap().as_ref(),
        bytes
    );
    artifact
}

fn issue297_identity(artifact: &StoredArtifact) -> ArtifactIdentity<'_> {
    ArtifactIdentity {
        id: artifact.id,
        corp_id: artifact.corp_id,
        task_id: artifact.task_id,
        run_id: artifact.run_id,
        agent_id: artifact.producer_agent_id,
        runner_id: &artifact.producer_runner_id,
    }
}

async fn issue297_persist_artifact(pool: &sqlx::PgPool, artifact: &StoredArtifact) {
    let result = sqlx::query(
        "UPDATE artifacts SET corp_id=$2,task_id=$3,run_id=$4,producer_agent_id=$5,
         producer_runner_id=$6,verifier=$7,object_key=$8,uri=$9,sha256=$10,media_type=$11,
         bytes=$12,artifact_role=$13,file_name=$14,metadata=$15,provenance_signature=$16,
         retention_until=$17,status='ready' WHERE id=$1",
    )
    .bind(artifact.id)
    .bind(artifact.corp_id)
    .bind(artifact.task_id)
    .bind(artifact.run_id)
    .bind(artifact.producer_agent_id)
    .bind(&artifact.producer_runner_id)
    .bind(&artifact.verifier)
    .bind(&artifact.object_key)
    .bind(&artifact.uri)
    .bind(&artifact.sha256)
    .bind(&artifact.media_type)
    .bind(artifact.bytes)
    .bind(&artifact.artifact_role)
    .bind(&artifact.file_name)
    .bind(&artifact.metadata)
    .bind(&artifact.provenance_signature)
    .bind(artifact.retention_until)
    .execute(pool)
    .await
    .unwrap();
    assert_eq!(result.rows_affected(), 1);
    if artifact.artifact_role == "source_deliverable" {
        sqlx::query("UPDATE runs SET deliverable_sha256=$1 WHERE id=$2")
            .bind(&artifact.sha256)
            .bind(Uuid::from_u128(12))
            .execute(pool)
            .await
            .unwrap();
    } else {
        sqlx::query("UPDATE runs SET artifact_sha256=$1,artifact_media_type=$2,artifact_signature=$3 WHERE id IN ($4,$5)")
            .bind(&artifact.sha256).bind(&artifact.media_type).bind(&artifact.provenance_signature)
            .bind(Uuid::from_u128(5)).bind(Uuid::from_u128(6)).execute(pool).await.unwrap();
    }
}

struct Issue297Fixture {
    state: crate::AppState,
    launch: crony_store::LaunchRecord,
    source: StoredArtifact,
    provider: StoredArtifact,
    bytes: Vec<u8>,
    document: Value,
    paths: Vec<String>,
}

impl Issue297Fixture {
    async fn create(store: crony_store::PgStore, admission: &Issue297Admission) -> Self {
        use crate::{AuthService, DashMap, SecretCipher, ServerMode, StrategyRegistry, broadcast};
        initialize_dependency_artifact_fixture(store.pool()).await;
        sqlx::raw_sql(
            "CREATE TABLE missions (id UUID PRIMARY KEY,corp_id UUID,room_id UUID,status TEXT);
             CREATE TABLE room_memberships (room_id UUID,actor_id UUID);
             CREATE TABLE events (
                 seq BIGSERIAL PRIMARY KEY,id UUID,schema_version INTEGER,corp_id UUID,room_id UUID,
                 actor_id UUID,type TEXT,aggregate_type TEXT,aggregate_id UUID,aggregate_version BIGINT,
                 correlation_id UUID,causation_id UUID,idempotency_key TEXT,visibility TEXT,payload JSONB,
                 created_at TIMESTAMPTZ DEFAULT now(),UNIQUE(corp_id,idempotency_key)
             );",
        ).execute(store.pool()).await.unwrap();
        sqlx::query("INSERT INTO missions VALUES ($1,$2,$3,'running')")
            .bind(Uuid::from_u128(2))
            .bind(Uuid::from_u128(1))
            .bind(Uuid::from_u128(20))
            .execute(store.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO room_memberships VALUES ($1,$2),($3,$4)")
            .bind(Uuid::from_u128(20))
            .bind(Uuid::from_u128(21))
            .bind(Uuid::from_u128(22))
            .bind(Uuid::from_u128(23))
            .execute(store.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO runs (id,task_id,status) VALUES ($1,$2,'starting')")
            .bind(Uuid::from_u128(14))
            .bind(Uuid::from_u128(4))
            .execute(store.pool())
            .await
            .unwrap();
        let mut artifacts = memory_store();
        artifacts.max_bytes = crate::dependency_source::MAX_TYPED_SOURCE_ENVELOPE_BYTES + 1;
        let provider_bytes = format!("Verified provider receipt for {}\n", admission.nonce);
        let provider = issue297_sign(
            &artifacts,
            ArtifactIdentity {
                id: Uuid::from_u128(7),
                corp_id: Uuid::from_u128(1),
                task_id: Uuid::from_u128(3),
                run_id: Uuid::from_u128(5),
                agent_id: Uuid::from_u128(8),
                runner_id: "fixture-runner",
            },
            provider_bytes.as_bytes(),
            false,
        )
        .await;
        issue297_persist_artifact(store.pool(), &provider).await;
        let paths = vec!["handoffs/a.md".to_owned(), "handoffs/b.md".to_owned()];
        let first = format!("A: signed handoff {}\n", admission.nonce).into_bytes();
        let second = b"B: independent specialist handoff\n".to_vec();
        let mut document = issue297_document(vec![
            issue297_change(&paths[0], &first),
            issue297_change(&paths[1], &second),
        ]);
        if admission.case_id == "prompt-byte-limit" {
            let framing = paths
                .iter()
                .map(|path| path.len() + 64 + 128)
                .sum::<usize>();
            let first = vec![b'a'; crate::dependency_source::MAX_TYPED_SOURCE_FILE_BYTES];
            let second =
                vec![
                    b'b';
                    crate::dependency_source::MAX_TYPED_SOURCE_PROMPT_BYTES - framing - first.len()
                ];
            document = issue297_document(vec![
                issue297_change(&paths[0], &first),
                issue297_change(&paths[1], &second),
            ]);
        }
        let mut bytes = serde_json::to_vec(&document).unwrap();
        if admission.case_id == "envelope-byte-limit" {
            // JSON trailing whitespace is valid. This hits the envelope validator
            // without exceeding the separate patch/file/prompt validators.
            bytes.resize(
                crate::dependency_source::MAX_TYPED_SOURCE_ENVELOPE_BYTES,
                b' ',
            );
        }
        let source = issue297_sign(
            &artifacts,
            ArtifactIdentity {
                id: Uuid::from_u128(13),
                corp_id: Uuid::from_u128(1),
                task_id: Uuid::from_u128(11),
                run_id: Uuid::from_u128(12),
                agent_id: Uuid::from_u128(8),
                runner_id: "fixture-runner",
            },
            &bytes,
            true,
        )
        .await;
        issue297_persist_artifact(store.pool(), &source).await;
        sqlx::query(
            "UPDATE runs SET workspace_base_commit=$1,source_base_commit=$1,verification_sha256=$2",
        )
        .bind(ISSUE297_BASE)
        .bind(ISSUE297_VERIFIER)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE tasks SET contract=contract || $1 WHERE id=$2",
        ).bind(json!({
            "source_repository":"fixture/repo", "source_base_ref":"main", "source_base_commit":ISSUE297_BASE,
            "write_scope":paths, "deliverable":{"form":"typed_artifact_set","paths":paths,"commit_after_verification":false},
        })).bind(Uuid::from_u128(11)).execute(store.pool()).await.unwrap();
        sqlx::query(
            "INSERT INTO source_deliverables VALUES ($1,$2,$3,$4,'typed_artifact_set',$5,$6)",
        )
        .bind(Uuid::from_u128(12))
        .bind(Uuid::from_u128(11))
        .bind(Uuid::from_u128(1))
        .bind(source.id)
        .bind(ISSUE297_BASE)
        .bind(ISSUE297_VERIFIER)
        .execute(store.pool())
        .await
        .unwrap();
        let (event_tx, _) = broadcast::channel(16);
        let state = crate::AppState {
            store,
            artifacts,
            event_tx,
            runners: Arc::new(DashMap::new()),
            strategies: StrategyRegistry::new(),
            runner_grace_secs: 10,
            runner_credential_ttl_secs: 300,
            publication_publisher_credential_ttl_secs: 300,
            auth: AuthService::initialize(ServerMode::Development, None, false)
                .await
                .unwrap(),
            secret_cipher: SecretCipher::initialize(ServerMode::Development, None).unwrap(),
            artifact_retention_days: 1,
            workspace_sign_in: Arc::new(DashMap::new()),
        };
        let launch = crony_store::LaunchRecord {
            corp_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(20),
            mission_id: Uuid::from_u128(2),
            task_id: Uuid::from_u128(4),
            run_id: Uuid::from_u128(14),
            agent_id: Uuid::from_u128(8),
            assignment_token: Uuid::new_v4(),
            attempt: 1,
            adapter: "fake-process".to_owned(),
            mission_title: "Combine signed handoffs".to_owned(),
            model: None,
            reasoning_effort: None,
            source_repository: Some("fixture/repo".to_owned()),
            source_base_ref: Some("main".to_owned()),
            source_base_commit: Some(ISSUE297_BASE.to_owned()),
            workspace_connection_id: None,
            verification_policy: crony_domain::VerificationPolicy {
                checks: vec![],
                manual_gate: None,
            },
            write_scope: paths.clone(),
            deliverable: None,
            secret_refs: vec![],
            queued_messages: vec![],
        };
        Self {
            state,
            launch,
            source,
            provider,
            bytes,
            document,
            paths,
        }
    }

    async fn positive(&self) -> crate::VerifiedDependencyContext {
        let selected = self
            .state
            .store
            .dependency_artifacts(self.launch.corp_id, self.launch.task_id)
            .await
            .expect("actual persisted selector must accept both parents");
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].artifact.id, self.provider.id);
        assert_eq!(selected[0].artifact.run_id, Uuid::from_u128(5));
        assert_eq!(selected[0].verification_run_id, Uuid::from_u128(6));
        assert_ne!(selected[0].artifact.run_id, selected[0].verification_run_id);
        assert_eq!(selected[1].artifact.id, self.source.id);
        assert_eq!(
            self.state
                .artifacts
                .read_verified(&selected[1].artifact)
                .await
                .unwrap()
                .as_ref(),
            self.bytes
        );
        self.state
            .artifacts
            .read_verified(&selected[0].artifact)
            .await
            .unwrap();
        let context = crate::resolve_dependency_context(&self.state, &self.launch)
            .await
            .unwrap();
        assert_eq!(context.files.len(), self.paths.len());
        for (file, expected) in context
            .files
            .iter()
            .zip(self.document["changes"].as_array().unwrap())
        {
            assert_eq!(file.path, expected["path"]);
            assert_eq!(file.sha256, expected["sha256"]);
            assert_eq!(
                file.content.as_bytes(),
                BASE64
                    .decode(expected["content_base64"].as_str().unwrap())
                    .unwrap()
            );
            assert!(context.prompt.contains(&file.content));
        }
        assert!(context.prompt.contains(&self.provider.id.to_string()));
        context
    }

    async fn receipt_snapshot(&self) -> Value {
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e")
            .fetch_one(self.state.store.pool())
            .await
            .unwrap()
    }

    async fn selector_rejects(&self) {
        let error = self
            .state
            .store
            .dependency_artifacts(self.launch.corp_id, self.launch.task_id)
            .await
            .expect_err("authority mutation must fail the real relational selector");
        assert!(
            error
                .to_string()
                .contains("dependency handoff is incomplete or unverified")
        );
        let error = crate::resolve_dependency_context(&self.state, &self.launch)
            .await
            .err()
            .expect("resolver must propagate native selector rejection");
        assert!(
            error
                .to_string()
                .contains("dependency handoff is incomplete or unverified")
        );
    }

    async fn decoder_rejects(
        &self,
        bytes: &[u8],
        expected: crate::dependency_source::DependencySourceError,
    ) {
        let artifact = issue297_sign(
            &self.state.artifacts,
            issue297_identity(&self.source),
            bytes,
            true,
        )
        .await;
        issue297_persist_artifact(self.state.store.pool(), &artifact).await;
        let selected = self
            .state
            .store
            .dependency_artifacts(self.launch.corp_id, self.launch.task_id)
            .await
            .expect("signed malformed source must reach native delivery validator");
        assert_eq!(selected.len(), 2);
        assert_eq!(
            self.state
                .artifacts
                .read_verified(&selected[1].artifact)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
        let error = crate::resolve_dependency_context(&self.state, &self.launch)
            .await
            .err()
            .expect("signed malformed envelope must not resolve any handoff");
        assert_eq!(
            error.downcast_ref::<crate::dependency_source::DependencySourceError>(),
            Some(&expected)
        );
        issue297_persist_artifact(self.state.store.pool(), &self.source).await;
    }
}

async fn issue297_exercise(fixture: &Issue297Fixture, case_id: &str) -> Vec<&'static str> {
    use crate::dependency_source::DependencySourceError;
    let positive = fixture.positive().await;
    let before = fixture.receipt_snapshot().await;
    assert_eq!(before.as_array().unwrap().len(), 1);
    let pool = fixture.state.store.pool();
    let mut assertions = Vec::new();
    match case_id {
        "altered-content" => {
            let mut changed = fixture.bytes.clone();
            changed[0] = b'[';
            fixture
                .state
                .artifacts
                .store
                .put(
                    &ObjectPath::from(fixture.source.object_key.clone()),
                    Bytes::from(changed).into(),
                )
                .await
                .unwrap();
            fixture
                .state
                .artifacts
                .verify_signature(&fixture.source)
                .unwrap();
            assert_eq!(
                fixture
                    .state
                    .store
                    .dependency_artifacts(fixture.launch.corp_id, fixture.launch.task_id)
                    .await
                    .unwrap()
                    .len(),
                2
            );
            let error = crate::resolve_dependency_context(&fixture.state, &fixture.launch)
                .await
                .err()
                .unwrap();
            assert!(matches!(
                error.downcast_ref::<PermanentArtifactError>(),
                Some(PermanentArtifactError::Integrity(_))
            ));
            fixture
                .state
                .artifacts
                .store
                .put(
                    &ObjectPath::from(fixture.source.object_key.clone()),
                    Bytes::from(fixture.bytes.clone()).into(),
                )
                .await
                .unwrap();
            assertions.push("signed_object_digest_mismatch_rejected");
            let mut document = fixture.document.clone();
            let length = document["changes"][0]["bytes"].as_u64().unwrap() as usize;
            document["changes"][0]["content_base64"] = json!(BASE64.encode(vec![b'x'; length]));
            fixture
                .decoder_rejects(
                    &serde_json::to_vec(&document).unwrap(),
                    DependencySourceError::DigestMismatch,
                )
                .await;
            assertions.push("signed_envelope_inner_digest_mismatch_rejected");
        }
        "undeclared-file" | "traversal" => {
            let mut document = fixture.document.clone();
            if case_id == "undeclared-file" {
                document["changes"]
                    .as_array_mut()
                    .unwrap()
                    .push(issue297_change("handoffs/undeclared.md", b"not authorized"));
                fixture
                    .decoder_rejects(
                        &serde_json::to_vec(&document).unwrap(),
                        DependencySourceError::ContractMismatch("declared file set"),
                    )
                    .await;
                assertions.push("signed_undeclared_file_rejected");
            } else {
                document["changes"][0]["path"] = json!("../outside.md");
                fixture
                    .decoder_rejects(
                        &serde_json::to_vec(&document).unwrap(),
                        DependencySourceError::UnsafePath,
                    )
                    .await;
                assertions.push("signed_traversal_path_rejected");
            }
        }
        "cross-corp" | "cross-task" | "cross-run" => {
            let mut identity = issue297_identity(&fixture.source);
            match case_id {
                "cross-corp" => identity.corp_id = Uuid::from_u128(99),
                "cross-task" => identity.task_id = fixture.provider.task_id,
                "cross-run" => identity.run_id = fixture.provider.run_id,
                _ => unreachable!(),
            }
            let wrong =
                issue297_sign(&fixture.state.artifacts, identity, &fixture.bytes, true).await;
            issue297_persist_artifact(pool, &wrong).await;
            fixture.selector_rejects().await;
            issue297_persist_artifact(pool, &fixture.source).await;
            assertions.push(match case_id {
                "cross-corp" => "signed_cross_corp_lineage_rejected",
                "cross-task" => "signed_cross_task_lineage_rejected",
                _ => "signed_cross_run_lineage_rejected",
            });
        }
        "cross-recovery" => {
            sqlx::query("UPDATE factory_verification_recoveries SET source_run_id=$1 WHERE id=$2")
                .bind(fixture.source.run_id)
                .bind(Uuid::from_u128(9))
                .execute(pool)
                .await
                .unwrap();
            // Both objects are still honestly signed and readable. Only the
            // persisted governed recovery edge has been substituted.
            fixture
                .state
                .artifacts
                .read_verified(&fixture.provider)
                .await
                .unwrap();
            fixture
                .state
                .artifacts
                .read_verified(&fixture.source)
                .await
                .unwrap();
            fixture.selector_rejects().await;
            sqlx::query("UPDATE factory_verification_recoveries SET source_run_id=$1 WHERE id=$2")
                .bind(fixture.provider.run_id)
                .bind(Uuid::from_u128(9))
                .execute(pool)
                .await
                .unwrap();
            assertions.push("signed_cross_recovery_edge_rejected");
        }
        "cross-room" | "unauthorized-artifact" => {
            let download = fixture
                .state
                .store
                .artifact_for_download(
                    fixture.launch.corp_id,
                    fixture.source.id,
                    Uuid::from_u128(21),
                )
                .await
                .unwrap()
                .expect("member of source room must see source");
            assert_eq!(
                fixture
                    .state
                    .artifacts
                    .read_verified(&download)
                    .await
                    .unwrap()
                    .as_ref(),
                fixture.bytes
            );
            let foreign_memberships: i64 =
                sqlx::query_scalar("SELECT count(*) FROM room_memberships WHERE actor_id=$1")
                    .bind(Uuid::from_u128(23))
                    .fetch_one(pool)
                    .await
                    .unwrap();
            assert_eq!(foreign_memberships, 1);
            let denied_actor = if case_id == "cross-room" {
                Uuid::from_u128(23)
            } else {
                Uuid::from_u128(24)
            };
            assert!(
                fixture
                    .state
                    .store
                    .artifact_for_download(fixture.launch.corp_id, fixture.source.id, denied_actor,)
                    .await
                    .unwrap()
                    .is_none()
            );
            if case_id == "unauthorized-artifact" {
                sqlx::query("INSERT INTO room_memberships VALUES ($1,$2)")
                    .bind(Uuid::from_u128(22))
                    .bind(denied_actor)
                    .execute(pool)
                    .await
                    .unwrap();
            }
            sqlx::query("UPDATE room_memberships SET room_id=$1 WHERE actor_id=$2")
                .bind(Uuid::from_u128(20))
                .bind(denied_actor)
                .execute(pool)
                .await
                .unwrap();
            assert!(
                fixture
                    .state
                    .store
                    .artifact_for_download(fixture.launch.corp_id, fixture.source.id, denied_actor,)
                    .await
                    .unwrap()
                    .is_some()
            );
            if case_id == "unauthorized-artifact" {
                sqlx::query("DELETE FROM room_memberships WHERE actor_id=$1")
                    .bind(denied_actor)
                    .execute(pool)
                    .await
                    .unwrap();
                assertions.push("nonmember_signed_download_selector_rejected");
            } else {
                sqlx::query("UPDATE room_memberships SET room_id=$1 WHERE actor_id=$2")
                    .bind(Uuid::from_u128(22))
                    .bind(denied_actor)
                    .execute(pool)
                    .await
                    .unwrap();
                assertions.push("cross_room_download_selector_rejected");
            }
        }
        "prompt-byte-limit" => {
            let total = positive
                .files
                .iter()
                .map(|file| file.content.len() + file.path.len() + 64 + 128)
                .sum::<usize>();
            assert_eq!(
                total,
                crate::dependency_source::MAX_TYPED_SOURCE_PROMPT_BYTES
            );
            let mut document = fixture.document.clone();
            let length = document["changes"][1]["bytes"].as_u64().unwrap() as usize;
            document["changes"][1] = issue297_change(&fixture.paths[1], &vec![b'b'; length + 1]);
            fixture
                .decoder_rejects(
                    &serde_json::to_vec(&document).unwrap(),
                    DependencySourceError::LimitExceeded("per-parent prompt byte limit"),
                )
                .await;
            assertions.push("exact_parent_prompt_bound_accepted_plus_one_rejected");
            let mut launch = fixture.launch.clone();
            launch.mission_title = "x".repeat(64 * 1024 - positive.prompt.len());
            assert_eq!(
                crate::resolve_dependency_context(&fixture.state, &launch)
                    .await
                    .unwrap()
                    .files
                    .len(),
                2
            );
            launch.mission_title.push('x');
            let error = crate::resolve_dependency_context(&fixture.state, &launch)
                .await
                .err()
                .unwrap();
            assert!(
                error
                    .to_string()
                    .contains("task prompt and verified dependency contents exceed 64 KiB")
            );
            assertions.push("exact_combined_prompt_bound_accepted_plus_one_rejected");
        }
        "envelope-byte-limit" => {
            assert_eq!(
                fixture.bytes.len(),
                crate::dependency_source::MAX_TYPED_SOURCE_ENVELOPE_BYTES
            );
            let mut bytes = fixture.bytes.clone();
            bytes.push(b' ');
            fixture
                .decoder_rejects(
                    &bytes,
                    DependencySourceError::LimitExceeded("envelope byte limit"),
                )
                .await;
            assertions.push("exact_envelope_bound_accepted_plus_one_rejected");
        }
        "cancelled-parent" | "failed-parent" => {
            let rejected_status = if case_id == "cancelled-parent" {
                "cancelled"
            } else {
                "failed"
            };
            for (table, id) in [
                ("tasks", fixture.source.task_id),
                ("runs", fixture.source.run_id),
            ] {
                sqlx::query(&format!("UPDATE {table} SET status=$2 WHERE id=$1"))
                    .bind(id)
                    .bind(rejected_status)
                    .execute(pool)
                    .await
                    .unwrap();
                let status: String =
                    sqlx::query_scalar(&format!("SELECT status FROM {table} WHERE id=$1"))
                        .bind(id)
                        .fetch_one(pool)
                        .await
                        .unwrap();
                assert_eq!(status, rejected_status);
                fixture
                    .state
                    .artifacts
                    .read_verified(&fixture.source)
                    .await
                    .unwrap();
                fixture.selector_rejects().await;
                sqlx::query(&format!(
                    "UPDATE {table} SET status='completed' WHERE id=$1"
                ))
                .bind(id)
                .execute(pool)
                .await
                .unwrap();
            }
            assertions.extend(if case_id == "cancelled-parent" {
                [
                    "persisted_cancelled_parent_task_rejected",
                    "persisted_cancelled_parent_run_rejected",
                ]
            } else {
                [
                    "persisted_failed_parent_task_rejected",
                    "persisted_failed_parent_run_rejected",
                ]
            });
        }
        _ => panic!("case was not admitted"),
    }
    assert!(!assertions.is_empty());
    assert_eq!(
        fixture.receipt_snapshot().await,
        before,
        "rejection must not publish or replace any dependency receipt"
    );
    let restored = fixture.positive().await;
    assert_eq!(restored.prompt, positive.prompt);
    assert_eq!(
        fixture.receipt_snapshot().await,
        before,
        "valid replay must remain idempotent"
    );
    assertions
}

#[tokio::test]
#[ignore = "requires the independently owned nonce-qualified PostgreSQL fixture capability"]
async fn issue297_native_adversarial_fixture() {
    // This must precede even the first connection attempt. Unlike sqlx::test,
    // this entrypoint never provisions a database before its body executes.
    let admission = Issue297Admission::parse(|name| std::env::var(name).ok())
        .expect("refusing unqualified native fixture before any connection");
    let admin = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(admission.database_url.as_str())
        .await
        .expect("connect to qualified disposable database");
    let owned: bool = sqlx::query_scalar(
        "SELECT current_database()=$1 AND pg_get_userbyid(datdba)=current_user
         AND shobj_description(oid,'pg_database')=$2
         AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=$3
         FROM pg_database WHERE datname=current_database()",
    )
    .bind(&admission.database)
    .bind(format!("ecorp-issue297:{}", admission.nonce))
    .bind(i32::from(admission.port))
    .fetch_one(&admin)
    .await
    .expect("read disposable database ownership marker");
    assert!(
        owned,
        "database owner, nonce marker or server endpoint does not match"
    );
    sqlx::query(&format!("CREATE SCHEMA {}", admission.schema))
        .execute(&admin)
        .await
        .expect("create unique owned schema without adopting an existing schema");
    let mut fixture_url = admission.database_url.clone();
    fixture_url
        .query_pairs_mut()
        .append_pair("options", &format!("-c search_path={}", admission.schema));
    let store = crony_store::PgStore::connect(fixture_url.as_str())
        .await
        .unwrap();
    let actual_schema: String = sqlx::query_scalar("SELECT current_schema()")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(actual_schema, admission.schema);
    let fixture = Issue297Fixture::create(store, &admission).await;
    let pool = fixture.state.store.pool().clone();
    let result =
        tokio::spawn(async move { issue297_exercise(&fixture, admission.case_id).await }).await;
    pool.close().await;
    if result.is_ok() {
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", admission.schema))
            .execute(&admin)
            .await
            .expect("remove only the schema this child successfully created");
    }
    admin.close().await;
    let assertions = result.expect("native fixture assertion failed");
    let receipt = json!({
        "schema_version": 1, "case_id": admission.case_id, "nonce": admission.nonce,
        "evidence_scope": "native-integrated-fixture",
        "positive_controls": [
            "real_signed_artifacts_read_verified",
            "persisted_two_parent_selection",
            "native_resolver_exact_declared_bytes",
            "recovered_provider_and_verifier_runs_distinct",
            "restored_control_resolves_identically"
        ],
        "nonvacuity_controls": [
            "exactly_one_persisted_dependency_receipt",
            "rejection_preserves_persisted_receipt",
            "restored_replay_is_idempotent"
        ],
        "native_rejection_assertions": assertions,
        "fixture_schema_removed": true,
        "full_stack": false,
        "provider_inference": false
    });
    let encoded = serde_json::to_string(&receipt).unwrap();
    assert!(encoded.len() <= 4096);
    println!("\nISSUE297_NATIVE_FIXTURE:{encoded}");
}
