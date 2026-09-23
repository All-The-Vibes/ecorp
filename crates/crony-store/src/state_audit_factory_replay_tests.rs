use super::*;

async fn factory_fixture(
    pool: PgPool,
    key: &str,
    covered: bool,
) -> Result<(PgStore, UpgradeFactorySourceCommitInput, Uuid)> {
    let (store, ids, mission, _, _) = fixture(pool).await?;
    let work_item_id = Uuid::new_v4();
    let claim_token = Uuid::new_v4();
    sqlx::query("UPDATE tasks SET contract=jsonb_set(jsonb_set(contract,'{source_repository}',to_jsonb('fixture/repository'::text),true),'{source_base_ref}',to_jsonb('HEAD'::text),true) WHERE id=$1")
        .bind(mission.task_ids[0]).execute(&store.pool).await?;
    sqlx::query(
        "INSERT INTO factory_work_items(id,corp_id,source_kind,source_project_owner,source_project_number,source_project_item_id,source_repository_owner,source_repository_name,source_issue_number,source_issue_node_id,source_issue_url,source_title,source_revision,state,claim_owner_id,claim_token,lease_expires_at,policy,mission_id) VALUES($1,$2,'github_project_issue','fixture',1,'item','fixture','repository',281,'issue','https://github.com/fixture/repository/issues/281','audit','revision','claimed',$3,$4,now()+interval '1 hour',$5,$6)",
    )
    .bind(work_item_id).bind(ids.corp_id).bind(ids.alice_actor_id).bind(claim_token)
    .bind(json!({"source_base_ref":"HEAD","source_commit_upgrade_required":true}))
    .bind(mission.mission_id).execute(&store.pool).await?;
    if covered {
        store
            .initialize_state_audit(ids.corp_id, ids.alice_actor_id, Uuid::new_v4())
            .await?;
        store
            .cover_mission(ids.corp_id, ids.alice_actor_id, mission.mission_id)
            .await?;
    }
    Ok((
        store,
        UpgradeFactorySourceCommitInput {
            corp_id: ids.corp_id,
            work_item_id,
            actor_id: ids.alice_actor_id,
            claim_token,
            expected_version: 1,
            idempotency_key: key.into(),
            source_base_commit: "ab".repeat(20),
        },
        mission.mission_id,
    ))
}

fn request_id(input: &UpgradeFactorySourceCommitInput) -> Result<Uuid> {
    state_audit::derived_request_id(
        "factory-source-commit-upgrade",
        input.corp_id,
        input.actor_id,
        &input.idempotency_key,
    )
}

// Exercise the actual pre-alias wrapper with its original raw-key UUID. The
// immutable retained records are created normally, never edited into a fixture.
async fn historical_upgrade(
    store: &PgStore,
    input: UpgradeFactorySourceCommitInput,
    mission: Uuid,
) -> Result<FactoryWorkItemOutcome> {
    let op = state_audit::Operation {
        corp: input.corp_id,
        actor: input.actor_id,
        mission,
        request_id: request_id(&input)?,
        name: "source_commit_upgrade",
        request: json!({"work_item_id":input.work_item_id,
            "expected_version":input.expected_version,
            "source_base_commit":input.source_base_commit.trim().to_ascii_lowercase()}),
    };
    let native = store.clone();
    store
        .audited(op, move |tx| {
            Box::pin(async move {
                native
                    .upgrade_factory_source_commit_audit_inner(input, tx)
                    .await
            })
        })
        .await
}

async fn history(store: &PgStore, corp: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY sequence),'[]'::jsonb)::text FROM state_audit_decisions d WHERE corp_id=$1")
        .bind(corp).fetch_one(&store.pool).await?)
}

async fn alias_count(store: &PgStore) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT count(*) FROM state_audit_factory_replay_aliases")
            .fetch_one(&store.pool)
            .await?,
    )
}

async fn accepted_roundtrip(pool: PgPool, first_key: &str, legacy: bool) -> Result<()> {
    let (store, input, mission) = factory_fixture(pool, first_key, true).await?;
    let accepted = if legacy {
        historical_upgrade(&store, input.clone(), mission).await?
    } else {
        store.upgrade_factory_source_commit(input.clone()).await?
    };
    assert!(!accepted.replayed);
    let before = history(&store, input.corp_id).await?;
    let mut retry = input.clone();
    retry.idempotency_key = if first_key == first_key.trim() {
        format!("  {first_key} \t")
    } else {
        first_key.trim().into()
    };
    let mut wrong_token = retry.clone();
    wrong_token.claim_token = Uuid::new_v4();
    assert!(
        store
            .upgrade_factory_source_commit(wrong_token)
            .await
            .is_err()
    );
    assert_eq!(alias_count(&store).await?, if legacy { 0 } else { 1 });
    let mut changed = retry.clone();
    changed.source_base_commit = "cd".repeat(20);
    assert!(store.upgrade_factory_source_commit(changed).await.is_err());
    let replayed = store.upgrade_factory_source_commit(retry.clone()).await?;
    assert!(replayed.replayed);
    assert_eq!(replayed.work_item.version, accepted.work_item.version);
    assert_eq!(replayed.claim_token, Some(input.claim_token));
    assert_eq!(alias_count(&store).await?, 1);
    let mut canonical = input.clone();
    canonical.idempotency_key = input.idempotency_key.trim().into();
    let receipt = store
        .audit_receipt(input.corp_id, input.actor_id, request_id(&canonical)?)
        .await?
        .context("canonical receipt missing")?;
    assert_eq!(
        receipt,
        store
            .audit_receipt(
                input.corp_id,
                input.actor_id,
                request_id(if legacy { &input } else { &canonical })?
            )
            .await?
            .unwrap()
    );
    assert_eq!(history(&store, input.corp_id).await?, before);
    sqlx::query(
        "UPDATE factory_work_items SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(input.work_item_id)
    .execute(&store.pool)
    .await?;
    let expired = store.upgrade_factory_source_commit(retry).await?;
    assert!(expired.replayed);
    assert_eq!(expired.claim_token, None);
    assert_eq!(history(&store, input.corp_id).await?, before);
    for sql in [
        "UPDATE state_audit_factory_replay_aliases SET request_id=gen_random_uuid()",
        "DELETE FROM state_audit_factory_replay_aliases",
    ] {
        assert!(sqlx::query(sql).execute(&store.pool).await.is_err());
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_new_padded_factory_key_replays_trimmed(pool: PgPool) -> Result<()> {
    accepted_roundtrip(pool, "  accepted-key \t", false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_new_trimmed_factory_key_replays_padded(pool: PgPool) -> Result<()> {
    accepted_roundtrip(pool, "accepted-key", false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_historical_padded_acceptance_replays_trimmed(pool: PgPool) -> Result<()> {
    accepted_roundtrip(pool, "  accepted-key \t", true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_historical_trimmed_acceptance_replays_padded(pool: PgPool) -> Result<()> {
    accepted_roundtrip(pool, "accepted-key", true).await
}

async fn refused_roundtrip(pool: PgPool, first_key: &str, legacy: bool) -> Result<()> {
    let (store, mut refused, mission) = factory_fixture(pool, first_key, true).await?;
    refused.expected_version = 2;
    let initial = if legacy {
        historical_upgrade(&store, refused.clone(), mission).await
    } else {
        store.upgrade_factory_source_commit(refused.clone()).await
    };
    let initial_message = initial.unwrap_err().to_string();
    assert!(initial_message.contains("audit refusal receipt"));
    let before = history(&store, refused.corp_id).await?;
    let mut canonical = refused.clone();
    canonical.idempotency_key = first_key.trim().into();
    let mut alias = canonical.clone();
    if first_key == first_key.trim() {
        alias.idempotency_key = format!("  {first_key} \t");
    }
    if legacy && first_key != first_key.trim() {
        // The original refusal retained no native operation or key spelling.
        // A trimmed retry, including changed inputs or an unrelated new key,
        // must not be guessed from a matching semantic digest.
        for key in [first_key.trim(), "unrelated-new-key"] {
            for version in [1, 2] {
                let mut ambiguous = canonical.clone();
                ambiguous.idempotency_key = key.into();
                ambiguous.expected_version = version;
                assert!(
                    store
                        .upgrade_factory_source_commit(ambiguous)
                        .await
                        .unwrap_err()
                        .to_string()
                        .contains("original idempotency-key spelling")
                );
            }
        }
        assert_eq!(alias_count(&store).await?, 0);
        assert_eq!(history(&store, refused.corp_id).await?, before);
        assert_eq!(
            store
                .upgrade_factory_source_commit(refused.clone())
                .await
                .unwrap_err()
                .to_string(),
            initial_message
        );
    }
    let first_receipt = store
        .audit_receipt(
            refused.corp_id,
            refused.actor_id,
            request_id(if legacy { &refused } else { &canonical })?,
        )
        .await?
        .unwrap();
    let replay = store
        .upgrade_factory_source_commit(alias.clone())
        .await
        .unwrap_err();
    assert_eq!(replay.to_string(), initial_message);
    assert_eq!(alias_count(&store).await?, 1);
    assert_eq!(history(&store, refused.corp_id).await?, before);
    assert_eq!(
        store
            .audit_receipt(refused.corp_id, refused.actor_id, request_id(&canonical)?)
            .await?
            .unwrap(),
        first_receipt
    );
    let mut changed = canonical.clone();
    changed.expected_version = 1;
    assert!(
        store
            .upgrade_factory_source_commit(changed.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("different semantic inputs")
    );
    // A later, distinct authorized operation does not change the old refusal.
    changed.idempotency_key = "later-success".into();
    assert!(!store.upgrade_factory_source_commit(changed).await?.replayed);
    let after_write = store
        .upgrade_factory_source_commit(alias)
        .await
        .unwrap_err();
    assert_eq!(after_write.to_string(), initial_message);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_new_padded_refusal_replays_trimmed(pool: PgPool) -> Result<()> {
    refused_roundtrip(pool, "  refused-key \t", false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_new_trimmed_refusal_replays_padded(pool: PgPool) -> Result<()> {
    refused_roundtrip(pool, "refused-key", false).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_historical_padded_refusal_requires_original_once(pool: PgPool) -> Result<()> {
    refused_roundtrip(pool, "  refused-key \t", true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_historical_trimmed_refusal_replays_padded(pool: PgPool) -> Result<()> {
    refused_roundtrip(pool, "refused-key", true).await
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_conflicting_historical_refusals_do_not_choose_an_identity(
    pool: PgPool,
) -> Result<()> {
    let (store, mut input, mission) = factory_fixture(pool, "  conflict-key  ", true).await?;
    input.expected_version = 2;
    assert!(
        historical_upgrade(&store, input.clone(), mission)
            .await
            .is_err()
    );
    let mut trimmed = input.clone();
    trimmed.idempotency_key = trimmed.idempotency_key.trim().into();
    assert!(
        historical_upgrade(&store, trimmed.clone(), mission)
            .await
            .is_err()
    );
    let before = history(&store, input.corp_id).await?;
    // Neither direction may install an alias that hides the other historical
    // receipt, even when the first retry is already canonically spelled.
    assert!(
        store
            .upgrade_factory_source_commit(trimmed.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("explicit reconciliation")
    );
    assert!(
        store
            .upgrade_factory_source_commit(input)
            .await
            .unwrap_err()
            .to_string()
            .contains("conflicting historical Factory replay identities")
    );
    assert_eq!(alias_count(&store).await?, 0);
    assert_eq!(history(&store, trimmed.corp_id).await?, before);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned disposable PostgreSQL"]
async fn issue283_precoverage_factory_replay_is_not_adopted(pool: PgPool) -> Result<()> {
    let (store, input, mission) = factory_fixture(pool, "  before-coverage  ", false).await?;
    assert!(
        !store
            .upgrade_factory_source_commit(input.clone())
            .await?
            .replayed
    );
    store
        .initialize_state_audit(input.corp_id, input.actor_id, Uuid::new_v4())
        .await?;
    store
        .cover_mission(input.corp_id, input.actor_id, mission)
        .await?;
    let before = history(&store, input.corp_id).await?;
    for key in [&input.idempotency_key, input.idempotency_key.trim()] {
        let mut retry = input.clone();
        retry.idempotency_key = key.into();
        assert!(
            store
                .upgrade_factory_source_commit(retry)
                .await
                .unwrap_err()
                .to_string()
                .contains("pre-coverage or ambiguous history cannot be adopted")
        );
    }
    assert_eq!(alias_count(&store).await?, 0);
    assert_eq!(history(&store, input.corp_id).await?, before);
    Ok(())
}
