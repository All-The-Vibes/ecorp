//! Real-handler/real-migration tests using the existing saved-connection fixture.
//! Concurrent handler calls are not independent hosts or native runner processes.
use super::*;

async fn claim_request(f: &Fixture, actor: Uuid, key: &str) -> Result<ClaimFactoryWorkItemRequest> {
    let authority = f
        .state
        .store
        .factory_authority(f.ids.corp_id, actor)
        .await?;
    let mut policy = f.preflight().policy;
    policy["claim_authority_id"] = json!(authority.claim_authority_id);
    Ok(serde_json::from_value(json!({
        "actor_id": actor,
        "source_project_owner": "fixture", "source_project_number": 161,
        "source_project_item_id": "PVTI_ISSUE161_SHARED_ITEM",
        "source_repository_owner": "fixture", "source_repository_name": "project",
        "source_issue_number": 161, "source_issue_node_id": "I_ISSUE161_SHARED_ITEM",
        "source_issue_url": "https://github.com/fixture/project/issues/161",
        "source_title": "Shared authority handler fixture", "source_revision": "revision-1",
        "lease_seconds": 300, "idempotency_key": key, "policy": policy,
    }))?)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_concurrent_controllers_keep_one_claim_and_one_held_mission(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let alice = claim_request(&f, f.ids.alice_actor_id, "issue161-alice").await?;
    let bob = claim_request(&f, f.ids.bob_actor_id, "issue161-bob").await?;
    let (a, b) = tokio::join!(
        claim_factory_work_item(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path(f.ids.corp_id),
            Json(alice)
        ),
        claim_factory_work_item(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path(f.ids.corp_id),
            Json(bob)
        ),
    );
    let claim = match (a, b) {
        (Ok(Json(claim)), Err(error)) | (Err(error), Ok(Json(claim))) => {
            assert_eq!(error.status, StatusCode::CONFLICT);
            claim
        }
        _ => panic!("exactly one independent actor must own the shared item"),
    };
    let actor = claim.work_item.claim_owner_id;
    let token = claim.claim_token.context("direct winning claim token")?;
    let mut value = serde_json::to_value(f.preflight())?;
    value["actor_id"] = json!(actor);
    value["claim_token"] = json!(token);
    value["expected_version"] = json!(claim.work_item.version);
    value["idempotency_key"] = json!("issue161-materialize-replay");
    let request: MaterializeFactoryMissionRequest = serde_json::from_value(value)?;
    let (a, b) = tokio::join!(
        materialize_factory_mission(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path((f.ids.corp_id, claim.work_item.id)),
            Json(request.clone())
        ),
        materialize_factory_mission(
            State(f.state.clone()),
            Extension(Principal::Development),
            Path((f.ids.corp_id, claim.work_item.id)),
            Json(request)
        ),
    );
    let Json(a) = a.expect("first keyed materialization");
    let Json(b) = b.expect("second keyed materialization");
    assert_eq!(a.mission_id, b.mission_id);
    assert_eq!(a.task_ids, b.task_ids);
    assert_ne!(a.replayed, b.replayed);
    let snapshot = f.snapshot().await?;
    assert_eq!(snapshot["factory_work_items"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["missions"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["missions"][0]["status"], "ready");
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["runs"], json!([]));
    assert!(
        !snapshot.to_string().contains(&token.to_string()),
        "claim capabilities cannot enter shared state"
    );
    assert_eq!(
        snapshot["factory_work_items"][0]["policy"],
        claim.work_item.policy
    );
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_authority_handler_is_uncached_and_rejects_foreign_scope(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let before = f.snapshot().await?;
    let (headers, Json(report)) = crate::factory_authority::inspect(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path(f.ids.corp_id),
        Query(SnapshotQuery {
            actor_id: f.ids.alice_actor_id,
        }),
    )
    .await
    .expect("authorized authority inspection");
    assert_eq!(
        headers.get(axum::http::header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    assert_eq!(report["authority"]["corp_id"], json!(f.ids.corp_id));
    assert_eq!(
        report["authority"]["claim_authority_id"],
        before["corp"]["claim_authority_id"]
    );
    assert_eq!(report["mode"], "development");
    assert_eq!(report["new_claim_pin_required"], false);
    let result = crate::factory_authority::inspect(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path(Uuid::new_v4()),
        Query(SnapshotQuery {
            actor_id: f.ids.alice_actor_id,
        }),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(f.snapshot().await?, before);
    f.finish().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_bad_pin_rejects_claim_before_events_or_materialization(
    pool: PgPool,
) -> Result<()> {
    let f = Fixture::new(pool).await?;
    let before = f.snapshot().await?;
    let mut wrong = claim_request(&f, f.ids.alice_actor_id, "issue161-wrong-authority").await?;
    wrong.policy["claim_authority_id"] = json!(Uuid::new_v4());
    let error = claim_factory_work_item(
        State(f.state.clone()),
        Extension(Principal::Development),
        Path(f.ids.corp_id),
        Json(wrong),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(f.snapshot().await?, before);
    f.finish().await;
    Ok(())
}
