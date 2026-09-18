//! Readiness is a read-only observation using the actual preflight and native selector.
use super::*;
use crony_protocol::FactoryDispatchReadiness;

fn unbound(f: &Fixture) -> PreflightFactoryMissionRequest {
    let mut request = f.preflight();
    request.preferred_adapter = Some("fake-process".to_owned());
    request.preferred_model = None;
    request
        .policy
        .as_object_mut()
        .unwrap()
        .remove("workspace_connection_id");
    request.policy["adapter_allowlist"] = json!(["fake-process"]);
    request.policy["model"] = Value::Null;
    request
}

fn advertise(f: &Fixture) {
    let mut runner = f.state.runners.get_mut(&f.runner_id).unwrap();
    let mut workspace = capability("workspace-isolation", None);
    workspace.source_repository = Some(source().repository);
    workspace.source_base_ref = Some(source().base_ref);
    workspace.source_base_commit = Some(source().base_commit);
    runner.capabilities = vec![workspace, capability("fake-process", None)];
}

async fn preview(
    f: &Fixture,
    request: PreflightFactoryMissionRequest,
) -> Result<PreflightFactoryMissionResponse, ApiError> {
    preflight_factory_mission(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path(f.ids.corp_id),
        Json(request),
    )
    .await
    .map(|response| response.0)
}

async fn ledger(f: &Fixture) -> Result<Value> {
    // Include complete rows, not just counts: a failed reclaim must preserve
    // tokens/versions, policies, immutable lineage, and journal content.
    let mut result = serde_json::Map::new();
    for table in [
        "factory_work_items",
        "factory_operations",
        "missions",
        "tasks",
        "runs",
        "events",
        "factory_controllers",
        "factory_controller_operations",
    ] {
        let rows: Value = sqlx::query_scalar(&format!(
            "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') \
             FROM {table} t WHERE corp_id=$1"
        ))
        .bind(f.ids.corp_id)
        .fetch_one(f.state.store.pool())
        .await?;
        result.insert(table.to_owned(), rows);
    }
    Ok(Value::Object(result))
}

fn claim(f: &Fixture, request: &PreflightFactoryMissionRequest) -> ClaimFactoryWorkItemInput {
    ClaimFactoryWorkItemInput {
        corp_id: f.ids.corp_id,
        actor_id: f.ids.alice_actor_id,
        source: FactorySourceInput {
            project_owner: "fixture".to_owned(),
            project_number: 3,
            project_item_id: "issue256-item".to_owned(),
            repository_owner: "fixture".to_owned(),
            repository_name: "project".to_owned(),
            issue_number: 256,
            issue_node_id: "issue256-node".to_owned(),
            issue_url: "https://github.com/fixture/project/issues/256".to_owned(),
            title: request.title.clone(),
            revision: "2026-09-18T00:00:00Z".to_owned(),
        },
        idempotency_key: "issue256-claim".to_owned(),
        lease_seconds: 300,
        policy: request.policy.clone(),
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue256_offline_plan_and_required_readiness_preserve_full_ledger(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let mut request = unbound(&f);
    let before = ledger(&f).await?;
    let result = preview(&f, request.clone()).await.unwrap();
    assert!(result.valid);
    assert_eq!(result.task_count, 1);
    assert!(matches!(
        result.dispatch_readiness,
        Some(FactoryDispatchReadiness::NotReady { reason }) if reason.contains("immutable checkout")
    ));
    assert_eq!(ledger(&f).await?, before);
    request.require_dispatch_ready = true;
    let error = preview(&f, request.clone()).await.unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert!(
        error
            .message
            .contains("plan is valid but dispatch is not ready")
    );
    assert_eq!(ledger(&f).await?, before);

    // A ledger claim is not execution intent. An offline legacy claim remains
    // supported, but the execution preflight must not reclaim or rewrite it.
    f.state
        .store
        .claim_factory_work_item(claim(&f, &request))
        .await?;
    sqlx::query(
        "UPDATE factory_work_items SET lease_expires_at=now()-interval '1 second' WHERE corp_id=$1",
    )
    .bind(f.ids.corp_id)
    .execute(f.state.store.pool())
    .await?;
    let expired = ledger(&f).await?;
    assert!(preview(&f, request).await.is_err());
    assert_eq!(ledger(&f).await?, expired);
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue256_readiness_uses_exact_native_scope_and_reconciliation(pool: PgPool) -> Result<()> {
    let f = Fixture::new(pool).await?;
    advertise(&f);
    let request = unbound(&f);
    let before = ledger(&f).await?;
    assert_eq!(
        preview(&f, request.clone())
            .await
            .unwrap()
            .dispatch_readiness,
        Some(FactoryDispatchReadiness::Ready)
    );
    let original = f
        .state
        .runners
        .get(&f.runner_id)
        .unwrap()
        .capabilities
        .clone();
    for mismatch in [
        "corp",
        "unreconciled",
        "repository",
        "ref",
        "commit",
        "adapter",
        "connection",
    ] {
        {
            let mut runner = f.state.runners.get_mut(&f.runner_id).unwrap();
            match mismatch {
                "corp" => runner.corp_id = Uuid::new_v4(),
                "unreconciled" => runner.dispatch_ready = false,
                "repository" => {
                    runner.capabilities[0].source_repository = Some("elsewhere/project".into())
                }
                "ref" => runner.capabilities[0].source_base_ref = Some("other".into()),
                "commit" => runner.capabilities[0].source_base_commit = Some("b".repeat(40)),
                "adapter" => runner.capabilities[1].available = false,
                "connection" => {
                    for cap in &mut runner.capabilities {
                        cap.workspace_connection_id = Some(f.connection_id);
                    }
                }
                _ => unreachable!(),
            }
        }
        assert!(
            matches!(
                preview(&f, request.clone())
                    .await
                    .unwrap()
                    .dispatch_readiness,
                Some(FactoryDispatchReadiness::NotReady { .. })
            ),
            "{mismatch}"
        );
        let mut runner = f.state.runners.get_mut(&f.runner_id).unwrap();
        runner.capabilities = original.clone();
        runner.corp_id = f.ids.corp_id;
        runner.dispatch_ready = true;
    }
    for actor in [f.ids.eve_actor_id, Uuid::new_v4()] {
        let mut unauthorized = request.clone();
        unauthorized.actor_id = actor;
        assert!(preview(&f, unauthorized).await.is_err());
    }
    assert_eq!(ledger(&f).await?, before);
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue256_saved_connection_model_and_room_authority_still_fail_closed(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let request = f.preflight();
    assert_eq!(
        preview(&f, request.clone())
            .await
            .unwrap()
            .dispatch_readiness,
        Some(FactoryDispatchReadiness::Ready)
    );
    let before = ledger(&f).await?;
    let mut substituted = request.clone();
    substituted.policy["workspace_connection_id"] = json!(Uuid::new_v4());
    assert!(preview(&f, substituted).await.is_err());
    f.state.runners.get_mut(&f.runner_id).unwrap().capabilities[1].models[0].policy_state =
        Some("disabled".to_owned());
    assert!(preview(&f, request.clone()).await.is_err());
    f.state.runners.get_mut(&f.runner_id).unwrap().capabilities[1].models[0].policy_state =
        Some("enabled".to_owned());
    let mut foreign_model = request.clone();
    foreign_model.preferred_model = Some("another-account-model".to_owned());
    foreign_model.policy["model"] = json!("another-account-model");
    assert!(preview(&f, foreign_model).await.is_err());
    assert_eq!(ledger(&f).await?, before);

    let mut bob = request;
    bob.actor_id = f.ids.bob_actor_id;
    assert_eq!(
        preview(&f, bob.clone()).await.unwrap().dispatch_readiness,
        Some(FactoryDispatchReadiness::Ready)
    );
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(f.ids.room_id)
        .bind(f.ids.bob_actor_id)
        .execute(f.state.store.pool())
        .await?;
    let revoked = ledger(&f).await?;
    assert!(preview(&f, bob).await.is_err());
    assert_eq!(ledger(&f).await?, revoked);
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue256_matching_preflight_preserves_concurrent_claims_and_dispatch_recheck(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    advertise(&f);
    let mut request = unbound(&f);
    request.require_dispatch_ready = true;
    assert_eq!(
        preview(&f, request.clone())
            .await
            .unwrap()
            .dispatch_readiness,
        Some(FactoryDispatchReadiness::Ready)
    );
    let (first, second) = tokio::join!(
        f.state.store.claim_factory_work_item(claim(&f, &request)),
        f.state.store.claim_factory_work_item(claim(&f, &request)),
    );
    let first = first?;
    let second = second?;
    assert_eq!(first.work_item.id, second.work_item.id);
    assert_eq!(first.claim_token, second.claim_token);
    assert_ne!(first.replayed, second.replayed);
    let mut body = serde_json::to_value(request)?;
    body["claim_token"] = json!(first.claim_token.unwrap());
    body["expected_version"] = json!(first.work_item.version);
    body["idempotency_key"] = json!("issue256-materialize");
    let materialized = materialize_factory_mission(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path((f.ids.corp_id, first.work_item.id)),
        Json(serde_json::from_value(body)?),
    )
    .await
    .unwrap();
    let before = ledger(&f).await?;
    assert_eq!(before["factory_work_items"].as_array().unwrap().len(), 1);
    assert_eq!(before["missions"].as_array().unwrap().len(), 1);
    assert_eq!(before["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(before["runs"].as_array().unwrap().len(), 0);
    f.state
        .runners
        .get_mut(&f.runner_id)
        .unwrap()
        .dispatch_ready = false;
    let outcome = schedule_ready_tasks(
        &f.state,
        f.ids.corp_id,
        materialized.mission_id,
        Some(f.ids.alice_actor_id),
    )
    .await?;
    assert_eq!(outcome.candidate_count, 1);
    assert_eq!(outcome.failures.len(), 1);
    assert_eq!(ledger(&f).await?, before);
    // Restoring the exact reconciled runner still permits native dispatch.
    f.state
        .runners
        .get_mut(&f.runner_id)
        .unwrap()
        .dispatch_ready = true;
    let outcome = schedule_ready_tasks(
        &f.state,
        f.ids.corp_id,
        materialized.mission_id,
        Some(f.ids.alice_actor_id),
    )
    .await?;
    assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    assert_eq!(ledger(&f).await?["runs"].as_array().unwrap().len(), 1);
    f.finish().await;
    Ok(())
}
