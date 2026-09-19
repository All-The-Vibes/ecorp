use super::*;
use anyhow::Result;
use crony_store::DemoIds;
use sqlx::{ConnectOptions, PgPool};

async fn fixture(pool: &PgPool) -> Result<(AppState, DemoIds)> {
    let store = PgStore::connect(pool.connect_options().to_url_lossy().as_str()).await?;
    let (ids, _) = store.bootstrap_demo().await?;
    let (event_tx, _) = broadcast::channel(64);
    Ok((
        AppState {
            store,
            event_tx,
            runners: Arc::new(DashMap::new()),
            strategies: StrategyRegistry::new(),
            runner_grace_secs: 10,
            runner_credential_ttl_secs: 300,
            publication_publisher_credential_ttl_secs: 300,
            auth: AuthService::initialize(ServerMode::Development, None, false).await?,
            secret_cipher: SecretCipher::initialize(ServerMode::Development, None)?,
            artifacts: ArtifactStore::initialize(
                "local",
                PathBuf::from("output/issue48-unused-artifacts"),
                None,
                None,
                None,
                None,
                None,
                false,
                None,
                1024,
                false,
            )?,
            artifact_retention_days: 1,
            workspace_sign_in: Arc::new(DashMap::new()),
        },
        ids,
    ))
}

fn request(actor: Uuid) -> SetAgentPinRequest {
    SetAgentPinRequest {
        actor_id: actor,
        pinned: true,
        expected_version: 0,
        idempotency_key: Uuid::new_v4(),
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_handler_authorizes_and_publishes_only_first_operation(pool: PgPool) -> Result<()> {
    let (state, ids) = fixture(&pool).await?;
    let mut events = state.event_tx.subscribe();
    let pin = request(ids.bob_actor_id);
    let Json(first) = set_agent_pin(
        State(state.clone()),
        Extension(Principal::Development),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(pin.clone()),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(!first.replayed && first.pinned);
    assert_eq!(events.try_recv()?.event_type, "agent.pinned");
    let Json(replay) = set_agent_pin(
        State(state.clone()),
        Extension(Principal::Development),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(pin),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(replay.replayed);
    assert!(events.try_recv().is_err());
    for (actor, corp) in [
        (ids.eve_actor_id, ids.corp_id),
        (ids.alice_actor_id, Uuid::new_v4()),
    ] {
        let denied = set_agent_pin(
            State(state.clone()),
            Extension(Principal::Development),
            Path((corp, ids.worker_agent_id)),
            Json(request(actor)),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.status, StatusCode::FORBIDDEN);
    }
    let stale = set_agent_pin(
        State(state),
        Extension(Principal::Development),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(request(ids.alice_actor_id)),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.status, StatusCode::CONFLICT);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_handler_oidc_mapping_rejects_spoofed_actor_and_replay(pool: PgPool) -> Result<()> {
    let (state, ids) = fixture(&pool).await?;
    sqlx::query("INSERT INTO human_identities(issuer,subject,actor_id) VALUES('https://pin-fixture.invalid','bob',$1)")
        .bind(ids.bob_actor_id).execute(&pool).await?;
    let principal = Principal::Oidc {
        issuer: "https://pin-fixture.invalid".into(),
        subject: "bob".into(),
        email: None,
    };
    let denied = set_agent_pin(
        State(state.clone()),
        Extension(principal.clone()),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(request(ids.alice_actor_id)),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let pin = request(ids.bob_actor_id);
    let Json(applied) = set_agent_pin(
        State(state.clone()),
        Extension(principal.clone()),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(pin.clone()),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(!applied.replayed);
    assert_eq!(applied.pin_version, 1);
    sqlx::query("UPDATE actors SET role='guest' WHERE id=$1")
        .bind(ids.bob_actor_id)
        .execute(&pool)
        .await?;
    let denied = set_agent_pin(
        State(state),
        Extension(principal),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(pin),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    Ok(())
}

#[test]
fn issue48_wire_requires_typed_version_and_operation_without_extra_effects() {
    let value = serde_json::to_value(request(Uuid::new_v4())).unwrap();
    for field in ["pinned", "expected_version", "idempotency_key"] {
        let mut invalid = value.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<SetAgentPinRequest>(invalid).is_err());
    }
    for (field, extra) in [
        ("retire", json!(true)),
        ("expected_version", json!("0")),
        ("pinned", json!("true")),
    ] {
        let mut invalid = value.clone();
        invalid[field] = extra;
        assert!(serde_json::from_value::<SetAgentPinRequest>(invalid).is_err());
    }
}
