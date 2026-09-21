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

async fn controller_registration_rows(f: &Fixture) -> Result<Value> {
    Ok(sqlx::query_scalar(
        r#"SELECT jsonb_build_object(
            'controllers', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)
                            FROM factory_controllers c),
            'operations', (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.corp_id, o.idempotency_key), '[]'::jsonb)
                           FROM factory_controller_operations o),
            'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.seq), '[]'::jsonb)
                       FROM events e))"#,
    )
    .fetch_one(f.state.store.pool())
    .await?)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_production_controller_registration_requires_pin_before_persistence(
    pool: PgPool,
) -> Result<()> {
    let mut f = Fixture::new(pool).await?;
    // Native production AuthService initialization, with bounded in-process
    // discovery only. No daemon or real identity provider; it closes before admission.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let issuer = format!("http://{}", listener.local_addr()?);
    let metadata = json!({
        "issuer": issuer,
        "userinfo_endpoint": format!("{issuer}/userinfo"),
    });
    let discovery = Router::new().route(
        "/.well-known/openid-configuration",
        get(move || async move { Json(metadata) }),
    );
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (served, auth) = tokio::time::timeout(StdDuration::from_secs(15), async {
        tokio::join!(
            axum::serve(listener, discovery).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            }),
            async {
                let auth =
                    AuthService::initialize(ServerMode::Production, Some(issuer.clone()), true)
                        .await;
                let _ = shutdown_tx.send(());
                auth
            }
        )
    })
    .await
    .context("bounded synthetic OIDC discovery")?;
    served?;
    f.state.auth = auth?;
    assert_eq!(f.state.auth.mode(), ServerMode::Production);

    // Synthetic post-middleware principals exercise native identity mapping and
    // handler authorization, NOT bearer-token/UserInfo or HTTP middleware execution.
    for actor in [f.ids.alice_actor_id, f.ids.bob_actor_id] {
        f.state
            .store
            .link_human_identity(actor, &issuer, &actor.to_string(), None)
            .await?;
    }
    let principal = |actor: Uuid| Principal::Oidc {
        issuer: issuer.clone(),
        subject: actor.to_string(),
        email: None,
    };
    let authority = f
        .state
        .store
        .factory_authority(f.ids.corp_id, f.ids.alice_actor_id)
        .await?;
    let request = ConfigureFactoryControllerRequest {
        claim_authority_id: Some(authority.claim_authority_id),
        actor_id: f.ids.alice_actor_id,
        controller_id: Uuid::new_v4(),
        source_project_owner: "fixture".to_owned(),
        source_project_number: 161,
        source_repository_owner: "fixture".to_owned(),
        source_repository_name: "project".to_owned(),
        connection_epoch: Uuid::new_v4(),
        lease_seconds: 300,
        idempotency_key: "issue161-production-registration".to_owned(),
    };
    let initial = controller_registration_rows(&f).await?;
    assert_eq!(initial["controllers"], json!([]));
    assert_eq!(initial["operations"], json!([]));
    let mut expected = initial.clone();
    let mut accepted_controller = Value::Null;
    // Repeat all denials after registration: a persisted idempotency key is not
    // permission to bypass the current pin, identity, role or Corp checks.
    for replayed in [false, true] {
        for pin in [None, Some(Uuid::new_v4()), Some(Uuid::nil())] {
            let mut denied = request.clone();
            denied.claim_authority_id = pin;
            let result = configure_factory_controller(
                State(f.state.clone()),
                Extension(principal(f.ids.alice_actor_id)),
                Path(f.ids.corp_id),
                Json(denied),
            )
            .await;
            assert_eq!(controller_registration_rows(&f).await?, expected);
            let error = result.unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(
                error.message,
                if pin.is_none() {
                    "claim_authority_id is required for production controller registration"
                } else {
                    "factory claim authority mismatch"
                }
            );
        }
        for (identity, actor, corp) in [
            (f.ids.alice_actor_id, f.ids.bob_actor_id, f.ids.corp_id),
            (f.ids.bob_actor_id, f.ids.bob_actor_id, f.ids.corp_id),
            (Uuid::new_v4(), f.ids.alice_actor_id, f.ids.corp_id),
            (f.ids.alice_actor_id, f.ids.alice_actor_id, Uuid::new_v4()),
        ] {
            let mut denied = request.clone();
            denied.actor_id = actor;
            let result = configure_factory_controller(
                State(f.state.clone()),
                Extension(principal(identity)),
                Path(corp),
                Json(denied),
            )
            .await;
            assert_eq!(controller_registration_rows(&f).await?, expected);
            assert_eq!(result.unwrap_err().status, StatusCode::FORBIDDEN);
        }
        let Json(accepted) = configure_factory_controller(
            State(f.state.clone()),
            Extension(principal(f.ids.alice_actor_id)),
            Path(f.ids.corp_id),
            Json(request.clone()),
        )
        .await
        .expect("correct production pin admits registration and exact replay");
        assert_eq!(accepted.replayed, replayed);
        let rows = controller_registration_rows(&f).await?;
        if replayed {
            assert_eq!(json!(accepted.controller), accepted_controller);
            assert_eq!(rows, expected);
        } else {
            assert_eq!(accepted.controller.id, request.controller_id);
            assert_eq!(accepted.controller.corp_id, f.ids.corp_id);
            assert_eq!(accepted.controller.configured_by, f.ids.alice_actor_id);
            assert_eq!(accepted.controller.version, 1);
            assert_eq!(rows["controllers"].as_array().unwrap().len(), 1);
            assert_eq!(rows["operations"].as_array().unwrap().len(), 1);
            assert_eq!(rows["operations"][0]["operation"], "configure");
            let events = rows["events"].as_array().unwrap();
            let initial_events = initial["events"].as_array().unwrap();
            assert_eq!(events.len(), initial_events.len() + 1);
            assert_eq!(&events[..initial_events.len()], initial_events.as_slice());
            assert_eq!(
                events.last().unwrap()["type"],
                "factory.controller_configured"
            );
            assert_eq!(
                events.last().unwrap()["aggregate_id"],
                json!(request.controller_id)
            );
            accepted_controller = json!(accepted.controller);
            expected = rows;
        }
    }
    f.finish().await;
    Ok(())
}
