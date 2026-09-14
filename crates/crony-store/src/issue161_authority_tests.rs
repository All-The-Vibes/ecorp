//! Actual-migration claim-authority regressions. These reuse the existing
//! connection/Factory fixture and do not start a provider or a retained service.
//! Same-host metadata tests are not independent-host execution acceptance.
use super::*;

async fn pinned_policy(f: &Fixture) -> Result<Value> {
    let authority = f
        .store
        .factory_authority(f.ids.corp_id, f.ids.alice_actor_id)
        .await?;
    let mut value = policy(None);
    value["claim_authority_id"] = json!(authority.claim_authority_id);
    Ok(value)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_migration_identity_is_unique_non_nil_and_immutable(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let authority = f
        .store
        .factory_authority(f.ids.corp_id, f.ids.alice_actor_id)
        .await?;
    let (other_corp, _, other_actor, _) = foreign_scope(&f.store).await?;
    let other = f.store.factory_authority(other_corp, other_actor).await?;
    assert_ne!(authority.claim_authority_id, other.claim_authority_id);
    for replacement in [Uuid::nil(), other.claim_authority_id, Uuid::new_v4()] {
        assert!(
            sqlx::query("UPDATE corps SET claim_authority_id=$1 WHERE id=$2")
                .bind(replacement)
                .bind(f.ids.corp_id)
                .execute(&f.store.pool)
                .await
                .is_err()
        );
        assert_eq!(
            f.store
                .factory_authority(f.ids.corp_id, f.ids.alice_actor_id)
                .await?,
            authority
        );
    }
    // An ordinary metadata update must not rotate or invalidate the identity.
    sqlx::query("UPDATE corps SET name='Issue 161 renamed fixture' WHERE id=$1")
        .bind(f.ids.corp_id)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(
        f.store
            .factory_authority(f.ids.corp_id, f.ids.alice_actor_id)
            .await?,
        authority
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_authority_inspection_is_scoped_stable_and_read_only(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let before = ledger(&f).await?;
    let authority = f
        .store
        .factory_authority(f.ids.corp_id, f.ids.alice_actor_id)
        .await?;
    assert_eq!(authority.corp_id, f.ids.corp_id);
    assert!(!authority.claim_authority_id.is_nil());
    let reconnected = PgStore {
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_with((*f.store.pool.connect_options()).clone())
            .await?,
    };
    assert_eq!(
        reconnected
            .factory_authority(f.ids.corp_id, f.ids.bob_actor_id)
            .await?,
        authority
    );
    assert_eq!(ledger(&f).await?, before);
    let snapshot = f
        .store
        .snapshot(f.ids.corp_id, f.ids.alice_actor_id)
        .await?;
    assert_eq!(
        snapshot.corp.claim_authority_id,
        Some(authority.claim_authority_id)
    );
    assert_eq!(
        serde_json::to_value(&authority)?,
        json!({
            "corp_id": f.ids.corp_id, "claim_authority_id": authority.claim_authority_id
        })
    );
    for (corp, actor) in [
        (Uuid::new_v4(), f.ids.alice_actor_id),
        (f.ids.corp_id, Uuid::new_v4()),
    ] {
        denied(f.store.factory_authority(corp, actor).await, "forbidden");
    }
    let agent_actor: Uuid = sqlx::query_scalar("SELECT actor_id FROM agents WHERE id=$1")
        .bind(f.ids.codex_agent_id)
        .fetch_one(&f.store.pool)
        .await?;
    denied(
        f.store.factory_authority(f.ids.corp_id, agent_actor).await,
        "forbidden",
    );
    assert_eq!(ledger(&f).await?, before);
    reconnected.pool.close().await;
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_new_production_claim_requires_valid_matching_pin_without_side_effects(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let original = ledger(&f).await?;
    let accepted_policy = pinned_policy(&f).await?;
    for (index, invalid) in [
        Value::Null,
        json!(Uuid::nil()),
        json!(Uuid::new_v4()),
        json!("not-a-credential"),
        json!(42),
        json!({}),
        json!([]),
    ]
    .into_iter()
    .enumerate()
    {
        let mut candidate = accepted_policy.clone();
        candidate["claim_authority_id"] = invalid;
        let result = f
            .store
            .claim_factory_work_item_with_authority(
                claim_input(&f, candidate, &format!("issue161-invalid-{index}")),
                true,
            )
            .await;
        assert!(result.is_err());
        assert_eq!(
            ledger(&f).await?,
            original,
            "denial must not consume an operation or claim"
        );
    }
    denied(
        f.store
            .claim_factory_work_item_with_authority(
                claim_input(&f, policy(None), "issue161-missing"),
                true,
            )
            .await,
        "claim_authority_id is required",
    );
    assert_eq!(ledger(&f).await?, original);
    let input = claim_input(&f, accepted_policy, "issue161-missing");
    let claimed = f
        .store
        .claim_factory_work_item_with_authority(input.clone(), true)
        .await?;
    let after = ledger(&f).await?;
    let replay = f
        .store
        .claim_factory_work_item_with_authority(input, true)
        .await?;
    assert!(replay.replayed);
    assert_eq!(replay.work_item.id, claimed.work_item.id);
    assert_eq!(replay.claim_token, claimed.claim_token);
    assert_eq!(ledger(&f).await?, after);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_preflight_pin_mismatch_is_mutation_free_and_valid_pin_materializes_once(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let approved = pinned_policy(&f).await?;
    let plan = factory_plan(&f, None);
    let before = ledger(&f).await?;
    let mut incorrect = approved.clone();
    incorrect["claim_authority_id"] = json!(Uuid::new_v4());
    denied(
        f.store
            .preflight_factory_mission(preflight(&f, incorrect), &plan)
            .await,
        "authority mismatch",
    );
    assert_eq!(ledger(&f).await?, before);
    let checked = f
        .store
        .preflight_factory_mission(preflight(&f, approved.clone()), &plan)
        .await?;
    assert_eq!(ledger(&f).await?, before);
    let claim = f
        .store
        .claim_factory_work_item_with_authority(
            claim_input(&f, approved, "issue161-materialize"),
            true,
        )
        .await?;
    let request = materialize(&f, &claim, "issue161-materialize");
    let original = f
        .store
        .materialize_factory_mission(request.clone(), &checked)
        .await?;
    assert_eq!(original.work_item.policy, claim.work_item.policy);
    assert_materialization_replays(&f, &request, &checked, &original).await?;
    let persisted = ledger(&f).await?;
    assert_eq!(persisted.1["items"].as_array().unwrap().len(), 1);
    assert_eq!(persisted.0["missions"].as_array().unwrap().len(), 1);
    assert_eq!(persisted.0["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(persisted.0["runs"], json!([]));
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_legacy_claim_replay_and_reclaim_keep_unbound_policy_bytes(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let input = claim_input(&f, policy(None), "issue161-legacy");
    let claimed = f.store.claim_factory_work_item(input.clone()).await?;
    assert!(claimed.work_item.policy.get("claim_authority_id").is_none());
    let before = ledger(&f).await?;
    let replay = f
        .store
        .claim_factory_work_item_with_authority(input.clone(), true)
        .await?;
    assert!(replay.replayed);
    assert_eq!(replay.work_item.policy, claimed.work_item.policy);
    assert_eq!(ledger(&f).await?, before);
    sqlx::query("UPDATE factory_work_items SET lease_expires_at=now()-interval '1 second' WHERE corp_id=$1 AND id=$2")
        .bind(f.ids.corp_id).bind(claimed.work_item.id).execute(&f.store.pool).await?;
    let mut reclaim = input.clone();
    reclaim.idempotency_key = "issue161-legacy-reclaim".to_owned();
    let recovered = f
        .store
        .claim_factory_work_item_with_authority(reclaim, true)
        .await?;
    assert_eq!(recovered.work_item.id, claimed.work_item.id);
    assert_eq!(recovered.work_item.policy, claimed.work_item.policy);
    assert_ne!(recovered.claim_token, claimed.claim_token);
    let before = ledger(&f).await?;
    let mut rebind = input;
    rebind.idempotency_key = "issue161-legacy-rebind".to_owned();
    rebind.policy = pinned_policy(&f).await?;
    denied(
        f.store
            .claim_factory_work_item_with_authority(rebind, true)
            .await,
        "policy",
    );
    assert_eq!(ledger(&f).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue161_pin_does_not_bypass_source_scope_or_actor_authority(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let input = claim_input(&f, pinned_policy(&f).await?, "issue161-source");
    let claimed = f
        .store
        .claim_factory_work_item_with_authority(input.clone(), true)
        .await?;
    let before = ledger(&f).await?;
    let mut foreign = input.clone();
    foreign.corp_id = Uuid::new_v4();
    assert!(
        f.store
            .claim_factory_work_item_with_authority(foreign, true)
            .await
            .is_err()
    );
    let mut guest = input.clone();
    guest.actor_id = f.ids.eve_actor_id;
    assert!(
        f.store
            .claim_factory_work_item_with_authority(guest, true)
            .await
            .is_err()
    );
    let mut changed_source = input.clone();
    changed_source.source.revision = "different-revision".to_owned();
    assert!(
        f.store
            .claim_factory_work_item_with_authority(changed_source, true)
            .await
            .is_err()
    );
    assert_eq!(ledger(&f).await?, before);
    let mut changed_commit = input;
    changed_commit.idempotency_key = "issue161-changed-commit".to_owned();
    changed_commit.policy["source_base_commit"] = json!("b".repeat(40));
    assert!(
        f.store
            .claim_factory_work_item_with_authority(changed_commit, true)
            .await
            .is_err()
    );
    assert_eq!(ledger(&f).await?, before);
    // Native materialization constrains a proposed graph to its persisted source.
    // A proposed graph cannot overwrite the claimed immutable commit.
    let mut proposed = factory_plan(&f, None);
    proposed.tasks[0].contract.source_base_commit = Some("b".repeat(40));
    let outcome = f
        .store
        .materialize_factory_mission(
            materialize(&f, &claimed, "issue161-constrained-source"),
            &proposed,
        )
        .await?;
    let stored: String = sqlx::query_scalar(
        "SELECT contract->>'source_base_commit' FROM tasks WHERE id=$1 AND corp_id=$2",
    )
    .bind(outcome.ids.task_ids[0])
    .bind(f.ids.corp_id)
    .fetch_one(&f.store.pool)
    .await?;
    assert_eq!(stored, source().base_commit);
    Ok(())
}
