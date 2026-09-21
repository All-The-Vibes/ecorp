use super::*;
use crony_audit::PublicationTransport;
use futures_util::future::BoxFuture;
use sqlx::{ConnectOptions, PgPool};
use std::{collections::BTreeMap, sync::Mutex};

const PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Same additive, in-memory transport fixture as the publication regressions,
// with explicit ancestors so an older DB fence cannot stand in for the pin.
#[derive(Default)]
struct PublicationFixture {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    writes: Mutex<usize>,
    ancestors: Vec<String>,
    checks: Mutex<Vec<(String, String)>>,
    heads: Mutex<usize>,
    rewrite_after_initial: bool,
}

impl PublicationTransport for PublicationFixture {
    fn head(&self) -> BoxFuture<'_, anyhow::Result<String>> {
        Box::pin(async {
            let mut heads = self.heads.lock().unwrap();
            *heads += 1;
            Ok(if self.rewrite_after_initial && *heads > 1 {
                "cccccccccccccccccccccccccccccccccccccccc"
            } else {
                HEAD
            }
            .into())
        })
    }
    fn descends_from<'a>(
        &'a self,
        old: &'a str,
        new: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            self.checks.lock().unwrap().push((old.into(), new.into()));
            Ok(old == new || (new == HEAD && self.ancestors.iter().any(|a| a == old)))
        })
    }
    fn read<'a>(
        &'a self,
        path: &'a str,
        _head: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<Option<Vec<u8>>>> {
        Box::pin(async move { Ok(self.files.lock().unwrap().get(path).cloned()) })
    }
    fn create<'a>(&'a self, path: &'a str, body: &'a [u8]) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            *self.writes.lock().unwrap() += 1;
            let mut files = self.files.lock().unwrap();
            ensure!(
                !files.contains_key(path),
                "fixture conflict; never overwrite"
            );
            files.insert(path.into(), body.into());
            Ok(())
        })
    }
}

async fn fixture(
    pool: &PgPool,
) -> anyhow::Result<(PgStore, crony_store::DemoIds, Service, AuditDestination)> {
    let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let (ids, _) = store.bootstrap_demo().await?;
    let ledger = Uuid::new_v4();
    store
        .initialize_state_audit(ids.corp_id, ids.alice_actor_id, ledger)
        .await?;
    let plan: TaskGraphPlan = serde_json::from_value(serde_json::json!({
        "strategy":"single","max_nodes":1,"max_depth":0,"budget_tokens":1000,
        "budget_cost_microusd":100000,"staffing":[],
        "tasks":[{"key":"deliver","title":"audit fixture","assigned_agent_id":ids.worker_agent_id,
            "required_adapter":"fake-process","depends_on":[],"depth":0,"max_attempts":1,
            "contract":{
                "objective":"Write result.md","expected_output":"result.md","acceptance_tests":["exists"],
                "allowed_tools":["filesystem"],"prohibited_actions":["no deployment"],"references":[],
                "write_scope":["result.md"],"budget_tokens":1000,"budget_cost_microusd":100000,
                "deadline_at":null,"escalation":"ask owner","secret_refs":[],
                "source_repository":null,"source_base_ref":null,"source_base_commit":null,
                "model":null,"reasoning_effort":null,"deliverable":null,"workspace_connection_id":null
            },
            "verification_policy":{"checks":[{"type":"file","path":"result.md","min_bytes":1}],"manual_gate":null}
        }]
    }))?;
    let (mission, _) = store
        .create_mission(
            ids.corp_id,
            ids.alice_actor_id,
            "Audit fixture",
            "Initial specification",
            &plan,
        )
        .await?;
    store
        .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
        .await?;
    let key = crony_audit::SigningKey::from_bytes(&[7; 32]);
    let checkpoint = store
        .audit_checkpoint(ids.corp_id, "fixture-key", &key)
        .await?;
    let destination = AuditDestination {
        id: Uuid::new_v4(),
        corp_id: ids.corp_id,
        kind: "github".into(),
        interval_seconds: 60,
        calendar_schedule: None,
        overdue_after_seconds: 3600,
        workflow_gate: "published".into(),
        config: serde_json::json!({"repository":"fixture/audit","branch":"main","path":"audit"}),
    };
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    let service = Service {
        key,
        key_id: "fixture-key".into(),
        github_token: None,
        checkpoint_seconds: 300,
        witnesses: vec![RetainedWitness {
            corp_id: ids.corp_id,
            ledger_id: ledger,
            checkpoint_digest: checkpoint.digest,
            github_commit: Some(PIN.into()),
            destination_id: Some(destination.id),
        }],
    };
    Ok((store, ids, service, destination))
}

async fn assert_disabled(
    pool: &PgPool,
    ids: &crony_store::DemoIds,
    destination: Uuid,
    expected_error: &str,
) -> anyhow::Result<()> {
    let reopened = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let status = reopened
        .audit_status(ids.corp_id, ids.alice_actor_id)
        .await?;
    let retained = status["destinations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == destination.to_string())
        .unwrap();
    assert_eq!(retained["publication_disabled"], true);
    assert_eq!(retained["reconciliation_error"], expected_error);
    assert_eq!(retained["last_error"], expected_error);
    assert_eq!(retained["failures"], 1);
    assert!(!retained["last_attempted_publication"].is_null());
    assert!(status["assurance"]["publication_errors"].as_u64().unwrap() >= 1);
    assert!(
        !reopened
            .due_audit_destinations()
            .await?
            .iter()
            .any(|d| d.id == destination)
    );
    assert!(
        !reopened
            .audit_workflow_gate_satisfied(ids.corp_id, destination, 1)
            .await?
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn b02_retained_remote_pin_fences_null_and_old_database_commit(
    pool: PgPool,
) -> anyhow::Result<()> {
    let (store, ids, mut service, mut destination) = fixture(&pool).await?;
    for previous in [None, Some(OLD)] {
        if previous.is_some() {
            destination.id = Uuid::new_v4();
            store
                .configure_audit_destination(ids.alice_actor_id, &destination)
                .await?;
            service.witnesses[0].destination_id = Some(destination.id);
        }
        sqlx::query("UPDATE state_audit_destinations SET last_commit=$2 WHERE id=$1")
            .bind(destination.id)
            .bind(previous)
            .execute(&pool)
            .await?;
        let remote = PublicationFixture {
            ancestors: vec![OLD.into()],
            ..Default::default()
        };
        let result = service
            .publish_destination(&store, &destination, &remote)
            .await;
        assert_eq!(
            *remote.writes.lock().unwrap(),
            0,
            "retained remote divergence must prevent every create; result={result:?}"
        );
        assert!(format!("{:#}", result.unwrap_err()).contains("history rewrite"));
        assert_disabled(&pool, &ids, destination.id, "external_history_divergence").await?;
        store
            .request_audit_publication(ids.corp_id, ids.alice_actor_id, destination.id)
            .await?;
        assert!(
            !service
                .publish_destination(&store, &destination, &remote)
                .await?
        );
        assert_eq!(*remote.writes.lock().unwrap(), 0);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn b02_descendant_replay_bootstrap_and_database_fence(pool: PgPool) -> anyhow::Result<()> {
    let (store, ids, mut service, mut destination) = fixture(&pool).await?;
    let remote = PublicationFixture {
        ancestors: vec![PIN.into(), OLD.into()],
        ..Default::default()
    };
    sqlx::query("UPDATE state_audit_destinations SET last_commit=$2 WHERE id=$1")
        .bind(destination.id)
        .bind(OLD)
        .execute(&pool)
        .await?;
    assert!(
        service
            .publish_destination(&store, &destination, &remote)
            .await?
    );
    assert_eq!(*remote.writes.lock().unwrap(), 4);
    assert!(
        store
            .audit_workflow_gate_satisfied(ids.corp_id, destination.id, 1)
            .await?
    );
    store
        .request_audit_publication(ids.corp_id, ids.alice_actor_id, destination.id)
        .await?;
    assert!(
        service
            .publish_destination(&store, &destination, &remote)
            .await?
    );
    assert_eq!(*remote.writes.lock().unwrap(), 4);
    let checks = remote.checks.lock().unwrap().clone();
    assert!(checks.contains(&(PIN.into(), HEAD.into())));
    assert!(checks.contains(&(OLD.into(), HEAD.into())));
    // A valid independent pin must not replace a divergent database fence.
    sqlx::query("UPDATE state_audit_destinations SET last_commit=$2,next_due=now() WHERE id=$1")
        .bind(destination.id)
        .bind("dddddddddddddddddddddddddddddddddddddddd")
        .execute(&pool)
        .await?;
    assert!(
        service
            .publish_destination(&store, &destination, &remote)
            .await
            .is_err()
    );
    assert_eq!(*remote.writes.lock().unwrap(), 4);
    assert_disabled(&pool, &ids, destination.id, "external_history_divergence").await?;
    // Explicit checkpoint-only initial publication needs no fabricated remote pin.
    destination.id = Uuid::new_v4();
    destination.config["repository"] = "fixture/bootstrap".into();
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    service.witnesses[0].github_commit = None;
    service.witnesses[0].destination_id = None;
    let bootstrap = PublicationFixture::default();
    assert!(
        service
            .publish_destination(&store, &destination, &bootstrap)
            .await?
    );
    assert_eq!(*bootstrap.writes.lock().unwrap(), 4);
    service.witnesses[0].destination_id = Some(destination.id);
    Service::validate_witnesses(&service.witnesses)?;
    store
        .request_audit_publication(ids.corp_id, ids.alice_actor_id, destination.id)
        .await?;
    assert!(
        service
            .publish_destination(&store, &destination, &bootstrap)
            .await?
    );
    assert_eq!(*bootstrap.writes.lock().unwrap(), 4);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn b02_destination_pin_cannot_authorize_another_destination(
    pool: PgPool,
) -> anyhow::Result<()> {
    let (store, ids, mut service, mut destination) = fixture(&pool).await?;
    destination.id = Uuid::new_v4();
    destination.config["repository"] = "fixture/other".into();
    destination.config["branch"] = "other".into();
    store
        .configure_audit_destination(ids.alice_actor_id, &destination)
        .await?;
    let remote = PublicationFixture {
        ancestors: vec![PIN.into()],
        ..Default::default()
    };
    let result = service
        .publish_destination(&store, &destination, &remote)
        .await;
    assert_eq!(
        *remote.writes.lock().unwrap(),
        0,
        "another destination's pin is not publication authority"
    );
    assert!(result.is_err());
    assert!(
        remote.checks.lock().unwrap().is_empty(),
        "do not apply D1's remote pin to D2"
    );
    assert_disabled(&pool, &ids, destination.id, "retained_witness_divergence").await?;
    // A separate, explicitly associated entry does authorize D2.
    let first = &service.witnesses[0];
    service.witnesses.push(RetainedWitness {
        corp_id: first.corp_id,
        ledger_id: first.ledger_id,
        checkpoint_digest: first.checkpoint_digest.clone(),
        github_commit: Some(OLD.into()),
        destination_id: Some(destination.id),
    });
    Service::validate_witnesses(&service.witnesses)?;
    assert!(
        service
            .witness(ids.corp_id, destination.id)
            .unwrap()
            .github_commit
            .as_deref()
            == Some(OLD)
    );
    let remote = PublicationFixture {
        ancestors: vec![OLD.into()],
        ..Default::default()
    };
    let witness = &service.witnesses[1];
    store
        .reconcile_audit_destination(
            ids.corp_id,
            ids.alice_actor_id,
            destination.id,
            AuditReconciliation {
                ledger_id: witness.ledger_id,
                checkpoint_digest: &witness.checkpoint_digest,
                github_commit: OLD,
            },
            &remote,
            &service.key.verifying_key(),
        )
        .await?;
    assert!(
        service
            .publish_destination(&store, &destination, &remote)
            .await?
    );
    assert!(
        !remote
            .checks
            .lock()
            .unwrap()
            .iter()
            .any(|(old, _)| old == PIN)
    );
    Ok(())
}

#[test]
fn b02_remote_witness_configuration_requires_exact_destination() {
    let mut witness = RetainedWitness {
        corp_id: Uuid::new_v4(),
        ledger_id: Uuid::new_v4(),
        checkpoint_digest: "00".repeat(32),
        github_commit: Some(PIN.into()),
        destination_id: None,
    };
    let error = Service::validate_witnesses(std::slice::from_ref(&witness)).unwrap_err();
    assert!(error.to_string().contains("destination_id"), "{error}");
    witness.destination_id = Some(Uuid::nil());
    assert!(Service::validate_witnesses(std::slice::from_ref(&witness)).is_err());
    witness.destination_id = Some(Uuid::new_v4());
    assert!(Service::validate_witnesses(std::slice::from_ref(&witness)).is_ok());
    witness.github_commit = None;
    witness.destination_id = None;
    assert!(Service::validate_witnesses(std::slice::from_ref(&witness)).is_ok());
    let bound = RetainedWitness {
        corp_id: witness.corp_id,
        ledger_id: witness.ledger_id,
        checkpoint_digest: witness.checkpoint_digest.clone(),
        github_commit: Some(PIN.into()),
        destination_id: Some(Uuid::new_v4()),
    };
    let mut witnesses = [witness, bound];
    assert!(
        Service::validate_witnesses(&witnesses)
            .unwrap_err()
            .to_string()
            .contains("cannot mix")
    );
    witnesses[0].destination_id = Some(Uuid::new_v4());
    assert!(Service::validate_witnesses(&witnesses).is_ok());
    witnesses[0].destination_id = witnesses[1].destination_id;
    assert!(Service::validate_witnesses(&witnesses).is_err());
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn b02_publication_checks_pin_on_its_initial_head_and_rejects_later_rewrite(
    pool: PgPool,
) -> anyhow::Result<()> {
    let (store, ids, service, destination) = fixture(&pool).await?;
    let remote = PublicationFixture {
        ancestors: vec![PIN.into()],
        rewrite_after_initial: true,
        ..Default::default()
    };
    let result = service
        .publish_destination(&store, &destination, &remote)
        .await;
    assert!(result.is_err());
    assert_eq!(*remote.writes.lock().unwrap(), 0);
    assert!(
        remote
            .checks
            .lock()
            .unwrap()
            .contains(&(PIN.into(), HEAD.into()))
    );
    assert_disabled(&pool, &ids, destination.id, "external_history_divergence").await?;
    Ok(())
}
