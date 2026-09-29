use super::*;
use anyhow::Result;
use crony_domain::AgentRetirementStatus;
use sqlx::PgPool;

fn request(actor_id: Uuid) -> RetireAgentRequest {
    RetireAgentRequest {
        actor_id,
        expected_pin_version: 0,
        idempotency_key: Uuid::new_v4(),
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_retirement_handler_authorizes_and_broadcasts_only_new_outcomes(
    pool: PgPool,
) -> Result<()> {
    let (state, ids) = crate::agent_pinning_tests::fixture(&pool).await?;
    let mut events = state.event_tx.subscribe();
    for (actor, corp) in [
        (ids.eve_actor_id, ids.corp_id),
        (ids.alice_actor_id, Uuid::new_v4()),
    ] {
        let error = retire_agent(
            State(state.clone()),
            Extension(Principal::Development),
            Path((corp, ids.worker_agent_id)),
            Json(request(actor)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert!(events.try_recv().is_err());
    }
    let operation = request(ids.bob_actor_id);
    let Json(first) = retire_agent(
        State(state.clone()),
        Extension(Principal::Development),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(operation.clone()),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(!first.replayed);
    assert_eq!(first.results.len(), 1);
    assert_eq!(first.results[0].status, AgentRetirementStatus::Retired);
    assert_eq!(events.try_recv()?.event_type, "agent.retired");
    let Json(replay) = retire_agent(
        State(state),
        Extension(Principal::Development),
        Path((ids.corp_id, ids.worker_agent_id)),
        Json(operation),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(replay.replayed);
    assert_eq!(replay.results, first.results);
    assert!(events.try_recv().is_err());
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue48_clear_handler_rechecks_oidc_actor_and_authority_on_replay(
    pool: PgPool,
) -> Result<()> {
    let (state, ids) = crate::agent_pinning_tests::fixture(&pool).await?;
    sqlx::query("INSERT INTO human_identities(issuer,subject,actor_id) VALUES('https://retirement-fixture.invalid','bob',$1)")
        .bind(ids.bob_actor_id).execute(&pool).await?;
    let principal = Principal::Oidc {
        issuer: "https://retirement-fixture.invalid".into(),
        subject: "bob".into(),
        email: None,
    };
    let mut operation = ClearCrewRequest {
        actor_id: ids.alice_actor_id,
        targets: vec![AgentRetirementTarget {
            agent_id: ids.worker_agent_id,
            expected_pin_version: 0,
        }],
        idempotency_key: Uuid::new_v4(),
    };
    let mut events = state.event_tx.subscribe();
    let error = clear_crew(
        State(state.clone()),
        Extension(principal.clone()),
        Path(ids.corp_id),
        Json(operation.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert!(events.try_recv().is_err());
    operation.actor_id = ids.bob_actor_id;
    let Json(first) = clear_crew(
        State(state.clone()),
        Extension(principal.clone()),
        Path(ids.corp_id),
        Json(operation.clone()),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    assert!(!first.replayed);
    assert_eq!(first.results.len(), 1);
    assert_eq!(events.try_recv()?.aggregate_id, ids.worker_agent_id);
    sqlx::query("UPDATE actors SET role='guest' WHERE id=$1")
        .bind(ids.bob_actor_id)
        .execute(&pool)
        .await?;
    let error = clear_crew(
        State(state),
        Extension(principal),
        Path(ids.corp_id),
        Json(operation),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert!(events.try_recv().is_err());
    Ok(())
}

#[test]
fn issue48_retirement_wire_rejects_missing_or_untyped_authority_and_extra_effects() {
    let retire = serde_json::to_value(request(Uuid::new_v4())).unwrap();
    for field in ["actor_id", "expected_pin_version", "idempotency_key"] {
        let mut invalid = retire.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<RetireAgentRequest>(invalid).is_err());
    }
    for (field, value) in [("expected_pin_version", json!("0")), ("force", json!(true))] {
        let mut invalid = retire.clone();
        invalid[field] = value;
        assert!(serde_json::from_value::<RetireAgentRequest>(invalid).is_err());
    }
    let clear = json!({
        "actor_id": Uuid::new_v4(),
        "idempotency_key": Uuid::new_v4(),
        "targets": [{ "agent_id": Uuid::new_v4(), "expected_pin_version": 0 }]
    });
    assert!(serde_json::from_value::<ClearCrewRequest>(clear.clone()).is_ok());
    for field in ["actor_id", "targets", "idempotency_key"] {
        let mut invalid = clear.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ClearCrewRequest>(invalid).is_err());
    }
    for target in [
        json!("all"),
        json!({"agent_id": Uuid::new_v4()}),
        json!({"agent_id": Uuid::new_v4(), "expected_pin_version": 0, "stop_run": true}),
    ] {
        let mut invalid = clear.clone();
        invalid["targets"] = json!([target]);
        assert!(serde_json::from_value::<ClearCrewRequest>(invalid).is_err());
    }
}
