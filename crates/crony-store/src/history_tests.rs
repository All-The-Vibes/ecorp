//! Explicitly opted-in regressions against real migrations in SQLx-owned databases.
//! Direct SQL creates historical/corrupt records, never accepted run completion.
use super::*;
use crony_domain::{HistoryFilters, HistoryKind, HistoryPage};
use sqlx::PgPool;

struct Fixture {
    store: PgStore,
    ids: DemoIds,
    agent_actor: Uuid,
}

async fn fixture(pool: PgPool) -> Result<Fixture> {
    let store = PgStore { pool };
    let (ids, _) = store.bootstrap_demo().await?;
    let agent_actor = sqlx::query_scalar("SELECT actor_id FROM agents WHERE id=$1")
        .bind(ids.worker_agent_id)
        .fetch_one(&store.pool)
        .await?;
    Ok(Fixture {
        store,
        ids,
        agent_actor,
    })
}

struct Records {
    mission: Uuid,
    task: Uuid,
    run: Uuid,
    event: Uuid,
}

async fn seed(f: &Fixture, room: Uuid, count: usize) -> Result<Vec<Records>> {
    let mut tx = f.store.pool.begin().await?;
    let mut records = Vec::new();
    let timestamp = Utc::now() - Duration::days(1);
    for i in 0..count {
        let r = Records {
            mission: Uuid::new_v4(),
            task: Uuid::new_v4(),
            run: Uuid::new_v4(),
            event: Uuid::new_v4(),
        };
        // Tied timestamps force the UUID tie-breaker; labels include literal SQL wildcards.
        let title = format!("history literal %_ {i:03}\n\u{202e}");
        sqlx::query("INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,created_at,description,
          budget_tokens,original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd)
          VALUES($1,$2,$3,$4,$5,'ready',$6,'private-description-canary',100000,100000,5000000,5000000)")
            .bind(r.mission).bind(f.ids.corp_id).bind(room).bind(f.ids.alice_actor_id)
            .bind(&title).bind(timestamp).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO tasks(id,mission_id,corp_id,title,objective,status,assigned_agent_id,
          plan_key,contract,verification_policy,created_at)
          VALUES($1,$2,$3,$4,'private-objective-canary','pending',$5,$1::text,
          '{\"private\":\"private-contract-canary\"}', '{\"checks\":[]}', $6)",
        )
        .bind(r.task)
        .bind(r.mission)
        .bind(f.ids.corp_id)
        .bind(&title)
        .bind(f.ids.worker_agent_id)
        .bind(timestamp)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,status,summary,created_at,assignment_token,workspace_run_id)
          VALUES($1,$2,$3,$4,'history-test','failed','private-run-summary-canary',$5,gen_random_uuid(),$1)")
            .bind(r.run).bind(f.ids.corp_id).bind(r.task).bind(f.ids.worker_agent_id)
            .bind(timestamp).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO events(id,corp_id,room_id,actor_id,type,aggregate_type,aggregate_id,
          idempotency_key,payload,created_at)
          VALUES($1,$2,$3,$4,'run.failed','run',$5,$1::text,
          '{\"message\":\"private-payload-canary\",\"token\":\"private-token-canary\"}', $6)",
        )
        .bind(r.event)
        .bind(f.ids.corp_id)
        .bind(room)
        .bind(f.agent_actor)
        .bind(r.run)
        .bind(timestamp)
        .execute(&mut *tx)
        .await?;
        records.push(r);
    }
    tx.commit().await?;
    Ok(records)
}

async fn page(
    f: &Fixture,
    filters: HistoryFilters,
    size: u32,
    cursor: Option<&str>,
) -> Result<HistoryPage> {
    f.store
        .history_page(f.ids.corp_id, f.ids.alice_actor_id, filters, size, cursor)
        .await
}

fn kind_filters(kind: HistoryKind) -> HistoryFilters {
    HistoryFilters {
        kind,
        ..Default::default()
    }
}

fn assert_error(result: Result<HistoryPage>, expected: HistoryReadError) {
    assert_eq!(
        result.unwrap_err().downcast_ref::<HistoryReadError>(),
        Some(&expected)
    );
}

async fn persistence(pool: &PgPool) -> Result<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object(
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM events e),
      'missions',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM missions m),
      'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
      'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r),
      'actors',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM actors a),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY room_id,actor_id) FROM room_memberships m))")
        .fetch_one(pool).await.map_err(Into::into)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_all_kinds_page_past_caps_without_duplicates_or_writes(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let record_count = 267;
    let records = seed(&f, f.ids.room_id, record_count).await?;
    let before = persistence(&f.store.pool).await?;
    for kind in [
        HistoryKind::Mission,
        HistoryKind::Task,
        HistoryKind::Run,
        HistoryKind::Event,
    ] {
        let mut filters = kind_filters(kind);
        filters.room_id = Some(f.ids.room_id);
        if kind == HistoryKind::Event {
            filters.status = Some("run.failed".into());
        }
        let mut cursor = None;
        let mut entries = Vec::new();
        let mut observed = None;
        let started = std::time::Instant::now();
        let mut pages = 0;
        loop {
            let p = page(&f, filters.clone(), 13, cursor.as_deref()).await?;
            pages += 1;
            assert_eq!(p.corp_id, f.ids.corp_id);
            assert_eq!(p.actor_id, f.ids.alice_actor_id);
            assert_eq!(p.filters, filters);
            assert!(p.entries.len() <= 13);
            if let Some(time) = observed {
                assert_eq!(time, p.observed_at);
            }
            observed = Some(p.observed_at);
            entries.extend(p.entries);
            cursor = p.next_cursor;
            if cursor.is_none() {
                break;
            }
            assert!(entries.len() <= record_count, "cursor must make progress");
        }
        eprintln!(
            "history kind={} records={} pages={} elapsed_ms={}",
            kind.as_str(),
            entries.len(),
            pages,
            started.elapsed().as_millis()
        );
        assert_eq!(entries.len(), record_count);
        let actual: HashSet<_> = entries.iter().map(|r| r.id).collect();
        assert_eq!(actual.len(), entries.len());
        let expected: HashSet<_> = records
            .iter()
            .map(|r| match kind {
                HistoryKind::Mission => r.mission,
                HistoryKind::Task => r.task,
                HistoryKind::Run => r.run,
                HistoryKind::Event => r.event,
            })
            .collect();
        assert_eq!(actual, expected);
        for pair in entries.windows(2) {
            if kind == HistoryKind::Event {
                assert!(
                    pair[0].seq.as_ref().unwrap().parse::<i64>()?
                        > pair[1].seq.as_ref().unwrap().parse::<i64>()?
                );
            } else {
                assert!((pair[0].created_at, pair[0].id) > (pair[1].created_at, pair[1].id));
            }
        }
        for entry in &entries {
            assert_eq!(entry.kind, kind);
            assert_eq!(entry.room_id, Some(f.ids.room_id));
            assert!(entry.mission_id.is_some());
            assert_eq!(
                entry.actor_id,
                Some(if kind == HistoryKind::Mission {
                    f.ids.alice_actor_id
                } else {
                    f.agent_actor
                })
            );
            assert!(!entry.title.contains(['\n', '\u{202e}']));
        }
        let body = serde_json::to_string(&entries)?;
        for canary in [
            "private-description",
            "private-objective",
            "private-contract",
            "private-run-summary",
            "private-payload",
            "private-token",
        ] {
            assert!(!body.contains(canary));
        }
    }
    assert_eq!(
        persistence(&f.store.pool).await?,
        before,
        "history cannot mutate stored evidence or state"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_literal_search_exact_links_and_safe_event_details(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let records = seed(&f, f.ids.room_id, 3).await?;
    for kind in [HistoryKind::Mission, HistoryKind::Task, HistoryKind::Run] {
        let filters = HistoryFilters {
            search: "  LITERAL %_  ".into(),
            ..kind_filters(kind)
        };
        let p = page(&f, filters, 10, None).await?;
        assert_eq!(p.filters.search, "LITERAL %_");
        assert_eq!(p.entries.len(), 3);
        for text in ["private", "literal%_", "nonexistent"] {
            assert!(
                page(
                    &f,
                    HistoryFilters {
                        search: text.into(),
                        ..kind_filters(kind)
                    },
                    10,
                    None
                )
                .await?
                .entries
                .is_empty()
            );
        }
    }
    let r = &records[1];
    let e = page(
        &f,
        HistoryFilters {
            record_id: Some(r.run),
            ..kind_filters(HistoryKind::Run)
        },
        10,
        None,
    )
    .await?;
    let entry = &e.entries[0];
    assert_eq!(
        (entry.mission_id, entry.task_id, entry.run_id),
        (Some(r.mission), Some(r.task), Some(r.run))
    );
    assert!(e.next_cursor.is_none());
    let matching = HistoryFilters {
        kind: HistoryKind::Run,
        mission_id: Some(r.mission),
        attributed_actor_id: Some(f.agent_actor),
        status: Some("failed".into()),
        ..Default::default()
    };
    assert_eq!(
        page(&f, matching.clone(), 10, None).await?.entries[0].id,
        r.run
    );
    assert!(
        page(
            &f,
            HistoryFilters {
                attributed_actor_id: Some(f.ids.bob_actor_id),
                ..matching
            },
            10,
            None
        )
        .await?
        .entries
        .is_empty()
    );
    sqlx::query("UPDATE events SET type='unknown-type-private-canary' WHERE id=$1")
        .bind(r.event)
        .execute(&f.store.pool)
        .await?;
    for text in ["private", "unknown-type", "token", "run.failed-private"] {
        assert!(
            page(
                &f,
                HistoryFilters {
                    search: text.into(),
                    ..Default::default()
                },
                100,
                None
            )
            .await?
            .entries
            .is_empty()
        );
    }
    let unknown = page(
        &f,
        HistoryFilters {
            status: Some("other".into()),
            ..Default::default()
        },
        100,
        None,
    )
    .await?;
    assert_eq!(unknown.entries.len(), 1);
    assert_eq!(unknown.entries[0].title, "other");
    assert_eq!(unknown.entries[0].run_id, Some(r.run));
    assert!(!serde_json::to_string(&unknown)?.contains("private-canary"));
    for (kind, table, id) in [
        (HistoryKind::Mission, "missions", r.mission),
        (HistoryKind::Task, "tasks", r.task),
        (HistoryKind::Run, "runs", r.run),
    ] {
        sqlx::query(&format!(
            "UPDATE {table} SET status='unknown-status-private-canary' WHERE id=$1"
        ))
        .bind(id)
        .execute(&f.store.pool)
        .await?;
        let p = page(
            &f,
            HistoryFilters {
                record_id: Some(id),
                ..kind_filters(kind)
            },
            10,
            None,
        )
        .await?;
        assert_eq!(p.entries[0].status, "unknown");
        assert!(!serde_json::to_string(&p)?.contains("private-canary"));
        for text in ["private", "unknown-status"] {
            assert!(
                page(
                    &f,
                    HistoryFilters {
                        search: text.into(),
                        ..kind_filters(kind)
                    },
                    10,
                    None
                )
                .await?
                .entries
                .is_empty()
            );
        }
        let p = page(
            &f,
            HistoryFilters {
                status: Some("unknown".into()),
                ..kind_filters(kind)
            },
            10,
            None,
        )
        .await?;
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0].id, id);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_access_rechecked_for_each_page_and_explicit_scope_never_broadens(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let r = seed(&f, f.ids.room_id, 4).await?;
    let filters = HistoryFilters {
        room_id: Some(f.ids.room_id),
        ..kind_filters(HistoryKind::Run)
    };
    let first = page(&f, filters.clone(), 2, None).await?;
    let cursor = first.next_cursor.as_deref().unwrap();
    assert_error(
        f.store
            .history_page(
                Uuid::new_v4(),
                f.ids.alice_actor_id,
                filters.clone(),
                2,
                Some(cursor),
            )
            .await,
        HistoryReadError::Unavailable,
    );
    assert_error(
        f.store
            .history_page(
                f.ids.corp_id,
                f.agent_actor,
                filters.clone(),
                2,
                Some(cursor),
            )
            .await,
        HistoryReadError::Unavailable,
    );
    assert_error(
        page(
            &f,
            HistoryFilters {
                room_id: Some(Uuid::new_v4()),
                ..filters.clone()
            },
            2,
            None,
        )
        .await,
        HistoryReadError::Unavailable,
    );
    assert_error(
        page(
            &f,
            HistoryFilters {
                mission_id: Some(Uuid::new_v4()),
                ..filters.clone()
            },
            2,
            None,
        )
        .await,
        HistoryReadError::Unavailable,
    );
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(f.ids.room_id)
        .bind(f.ids.alice_actor_id)
        .execute(&f.store.pool)
        .await?;
    assert_error(
        page(&f, filters.clone(), 2, Some(cursor)).await,
        HistoryReadError::Unavailable,
    );
    for kind in [HistoryKind::Mission, HistoryKind::Task, HistoryKind::Run] {
        assert!(
            page(&f, kind_filters(kind), 10, None)
                .await?
                .entries
                .is_empty()
        );
    }
    assert_error(
        page(
            &f,
            HistoryFilters {
                record_id: Some(r[0].run),
                ..kind_filters(HistoryKind::Run)
            },
            10,
            None,
        )
        .await,
        HistoryReadError::Unavailable,
    );
    sqlx::query("UPDATE actors SET role='revoked' WHERE id=$1")
        .bind(f.ids.alice_actor_id)
        .execute(&f.store.pool)
        .await?;
    assert_error(
        page(&f, HistoryFilters::default(), 10, None).await,
        HistoryReadError::Unavailable,
    );
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_unresolved_room_and_mismatched_aggregate_events_fail_closed(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let hidden_room = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'Hidden history','private')",
    )
    .bind(hidden_room)
    .bind(f.ids.corp_id)
    .execute(&f.store.pool)
    .await?;
    let hidden = seed(&f, hidden_room, 1).await?;
    let visible = seed(&f, f.ids.room_id, 1).await?;
    let mut deny_ids = vec![hidden[0].event];
    for (visibility, room, aggregate_type, aggregate_id) in [
        ("room", None, "unknown", Uuid::new_v4()),
        ("corp", None, "corp", Uuid::new_v4()),
        ("corp", None, "mission", hidden[0].mission),
        ("corp", Some(f.ids.room_id), "run", hidden[0].run),
        ("corp", Some(hidden_room), "run", visible[0].run),
        ("private", Some(f.ids.room_id), "run", visible[0].run),
    ] {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO events(id,corp_id,room_id,type,aggregate_type,aggregate_id,idempotency_key,visibility)
          VALUES($1,$2,$3,'run.failed',$4,$5,$1::text,$6)")
            .bind(id).bind(f.ids.corp_id).bind(room).bind(aggregate_type).bind(aggregate_id)
            .bind(visibility).execute(&f.store.pool).await?;
        deny_ids.push(id);
    }
    let all = page(&f, HistoryFilters::default(), 100, None).await?;
    for id in deny_ids {
        assert!(
            !all.entries.iter().any(|e| e.id == id),
            "inaccessible/corrupt event {id} exposed"
        );
        assert_error(
            page(
                &f,
                HistoryFilters {
                    record_id: Some(id),
                    ..Default::default()
                },
                10,
                None,
            )
            .await,
            HistoryReadError::Unavailable,
        );
    }
    assert!(all.entries.iter().any(|e| e.id == visible[0].event));
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_causal_links_require_visible_earlier_events(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let r = seed(&f, f.ids.room_id, 3).await?;
    sqlx::query("UPDATE events SET causation_id=$1 WHERE id=$2")
        .bind(r[0].event)
        .bind(r[2].event)
        .execute(&f.store.pool)
        .await?;
    let exact = HistoryFilters {
        record_id: Some(r[2].event),
        ..Default::default()
    };
    assert_eq!(
        page(&f, exact.clone(), 10, None).await?.entries[0].cause_id,
        Some(r[0].event)
    );
    sqlx::query("UPDATE events SET visibility='private' WHERE id=$1")
        .bind(r[0].event)
        .execute(&f.store.pool)
        .await?;
    assert_eq!(page(&f, exact, 10, None).await?.entries[0].cause_id, None);
    for cause in [r[1].event, r[2].event, Uuid::new_v4()] {
        sqlx::query("UPDATE events SET causation_id=$1 WHERE id=$2")
            .bind(cause)
            .bind(r[1].event)
            .execute(&f.store.pool)
            .await?;
        assert_eq!(
            page(
                &f,
                HistoryFilters {
                    record_id: Some(r[1].event),
                    ..Default::default()
                },
                10,
                None
            )
            .await?
            .entries[0]
                .cause_id,
            None
        );
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_malformed_cross_corp_relationships_cannot_supply_links_or_attribution(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    let r = seed(&f, f.ids.room_id, 5).await?;
    let foreign_corp = Uuid::new_v4();
    let foreign_room = Uuid::new_v4();
    let foreign_actor = Uuid::new_v4();
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,$1::text,'Other Corp')")
        .bind(foreign_corp)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'Other room','private')")
        .bind(foreign_room)
        .bind(foreign_corp)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'foreign-actor-private-canary','human','owner')")
        .bind(foreign_actor).bind(foreign_corp).execute(&f.store.pool).await?;
    // The old schema has individual foreign keys; the projection must also
    // reject malformed relationships that those individual keys permit.
    sqlx::query("UPDATE missions SET room_id=$1 WHERE id=$2")
        .bind(foreign_room)
        .bind(r[0].mission)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE missions SET corp_id=$1 WHERE id=$2")
        .bind(foreign_corp)
        .bind(r[1].mission)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE tasks SET corp_id=$1 WHERE id=$2")
        .bind(foreign_corp)
        .bind(r[2].task)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE runs SET corp_id=$1 WHERE id=$2")
        .bind(foreign_corp)
        .bind(r[3].run)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE events SET actor_id=$1 WHERE id=$2")
        .bind(foreign_actor)
        .bind(r[4].event)
        .execute(&f.store.pool)
        .await?;
    sqlx::query("UPDATE missions SET requested_by=$1 WHERE id=$2")
        .bind(foreign_actor)
        .bind(r[4].mission)
        .execute(&f.store.pool)
        .await?;
    for (kind, denied) in [
        (HistoryKind::Mission, vec![r[0].mission, r[1].mission]),
        (HistoryKind::Task, vec![r[0].task, r[1].task, r[2].task]),
        (
            HistoryKind::Run,
            vec![r[0].run, r[1].run, r[2].run, r[3].run],
        ),
        (
            HistoryKind::Event,
            vec![r[0].event, r[1].event, r[2].event, r[3].event],
        ),
    ] {
        let p = page(&f, kind_filters(kind), 100, None).await?;
        assert!(!serde_json::to_string(&p)?.contains("foreign-actor-private-canary"));
        assert!(!p.entries.iter().any(|e| e.actor_id == Some(foreign_actor)));
        for id in denied {
            assert!(!p.entries.iter().any(|e| e.id == id));
            assert_error(
                page(
                    &f,
                    HistoryFilters {
                        record_id: Some(id),
                        ..kind_filters(kind)
                    },
                    10,
                    None,
                )
                .await,
                HistoryReadError::Unavailable,
            );
        }
    }
    for (kind, id) in [
        (HistoryKind::Mission, r[4].mission),
        (HistoryKind::Event, r[4].event),
    ] {
        let p = page(
            &f,
            HistoryFilters {
                record_id: Some(id),
                ..kind_filters(kind)
            },
            10,
            None,
        )
        .await?;
        assert_eq!(p.entries[0].actor_id, None);
        assert_eq!(p.entries[0].actor_name, None);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_cursors_are_positions_not_authority_and_bind_normalized_queries(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    seed(&f, f.ids.room_id, 4).await?;
    let filters = kind_filters(HistoryKind::Task);
    let p = page(&f, filters.clone(), 2, None).await?;
    let cursor = p.next_cursor.as_deref().unwrap();
    for changed in [
        kind_filters(HistoryKind::Run),
        HistoryFilters {
            search: "history".into(),
            ..filters.clone()
        },
        HistoryFilters {
            attributed_actor_id: Some(f.agent_actor),
            ..filters.clone()
        },
    ] {
        assert_error(
            page(&f, changed, 2, Some(cursor)).await,
            HistoryReadError::InvalidCursor,
        );
    }
    assert_error(
        page(&f, filters.clone(), 3, Some(cursor)).await,
        HistoryReadError::InvalidCursor,
    );
    assert_error(
        f.store
            .history_page(
                f.ids.corp_id,
                f.ids.bob_actor_id,
                filters.clone(),
                2,
                Some(cursor),
            )
            .await,
        HistoryReadError::InvalidCursor,
    );
    let mut forged: Value = serde_json::from_slice(&hex::decode(cursor)?)?;
    forged["observed_at"] = json!((Utc::now() - Duration::minutes(31)).to_rfc3339());
    assert_error(
        page(
            &f,
            filters.clone(),
            2,
            Some(&hex::encode(serde_json::to_vec(&forged)?)),
        )
        .await,
        HistoryReadError::InvalidCursor,
    );
    for size in [0, 101, u32::MAX] {
        assert_error(
            page(&f, filters.clone(), size, None).await,
            HistoryReadError::InvalidQuery,
        );
    }
    assert_error(
        page(
            &f,
            HistoryFilters {
                search: "x".repeat(161),
                ..filters.clone()
            },
            10,
            None,
        )
        .await,
        HistoryReadError::InvalidQuery,
    );
    // A fabricated query/position can select another authorized slice, never grant a room.
    sqlx::query("DELETE FROM room_memberships WHERE room_id=$1 AND actor_id=$2")
        .bind(f.ids.room_id)
        .bind(f.ids.alice_actor_id)
        .execute(&f.store.pool)
        .await?;
    assert!(page(&f, filters, 2, Some(cursor)).await?.entries.is_empty());
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_event_gaps_bigint_and_late_commit_require_explicit_refresh(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    sqlx::query("SELECT setval(pg_get_serial_sequence('events','seq'),9007199254740992)")
        .execute(&f.store.pool)
        .await?;
    seed(&f, f.ids.room_id, 5).await?;
    let filters = HistoryFilters {
        status: Some("run.failed".into()),
        ..Default::default()
    };
    let first = page(&f, filters.clone(), 2, None).await?;
    assert!(first.entries[0].seq.as_ref().unwrap().parse::<i64>()? > 9_007_199_254_740_991);
    let mut pending = f.store.pool.begin().await?;
    let late = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO events(id,corp_id,type,aggregate_type,aggregate_id,idempotency_key,created_at)
      VALUES($1,$2,'run.failed','corp',$2,$1::text,now()-interval '2 days')",
    )
    .bind(late)
    .bind(f.ids.corp_id)
    .execute(&mut *pending)
    .await?;
    // Rollback consumes a sequence; neither a gap nor a later commit is a missing page error.
    let mut rolled_back = f.store.pool.begin().await?;
    sqlx::query("SELECT nextval(pg_get_serial_sequence('events','seq'))")
        .execute(&mut *rolled_back)
        .await?;
    rolled_back.rollback().await?;
    pending.commit().await?;
    let second = page(&f, filters.clone(), 2, first.next_cursor.as_deref()).await?;
    let third = page(&f, filters.clone(), 2, second.next_cursor.as_deref()).await?;
    let ids: HashSet<_> = first
        .entries
        .iter()
        .chain(&second.entries)
        .chain(&third.entries)
        .map(|e| e.id)
        .collect();
    assert_eq!(ids.len(), 5);
    assert!(!ids.contains(&late));
    assert!(third.next_cursor.is_none());
    let refreshed = page(&f, filters, 100, None).await?;
    assert_eq!(refreshed.entries[0].id, late);
    assert_eq!(refreshed.entries.len(), 6);
    Ok(())
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_sequence_reserved_before_search_but_committed_after_cursor_requires_refresh(
    pool: PgPool,
) -> Result<()> {
    let f = fixture(pool).await?;
    seed(&f, f.ids.room_id, 3).await?;
    let late = Uuid::new_v4();
    let mut pending = f.store.pool.begin().await?;
    sqlx::query(
        "INSERT INTO events(id,corp_id,type,aggregate_type,aggregate_id,idempotency_key)
      VALUES($1,$2,'run.failed','corp',$2,$1::text)",
    )
    .bind(late)
    .bind(f.ids.corp_id)
    .execute(&mut *pending)
    .await?;
    seed(&f, f.ids.room_id, 3).await?;
    let filters = HistoryFilters {
        status: Some("run.failed".into()),
        ..Default::default()
    };
    let first = page(&f, filters.clone(), 2, None).await?;
    let second = page(&f, filters.clone(), 2, first.next_cursor.as_deref()).await?;
    // The second page has already passed the uncommitted sequence position.
    pending.commit().await?;
    let third = page(&f, filters.clone(), 2, second.next_cursor.as_deref()).await?;
    let ids: HashSet<_> = first
        .entries
        .iter()
        .chain(&second.entries)
        .chain(&third.entries)
        .map(|e| e.id)
        .collect();
    assert_eq!(ids.len(), 6);
    assert!(!ids.contains(&late));
    assert!(third.next_cursor.is_none());
    let refreshed = page(&f, filters, 100, None).await?;
    assert_eq!(refreshed.entries.len(), 7);
    assert!(refreshed.entries.iter().any(|e| e.id == late));
    Ok(())
}

fn event_scan_work(plan: &Value) -> f64 {
    let own = if plan["Relation Name"] == "events" {
        (plan["Actual Rows"].as_f64().unwrap_or_default()
            + plan["Rows Removed by Filter"].as_f64().unwrap_or_default()
            + plan["Rows Removed by Index Recheck"]
                .as_f64()
                .unwrap_or_default())
            * plan["Actual Loops"].as_f64().unwrap_or_default()
    } else {
        0.0
    };
    own + plan["Plans"]
        .as_array()
        .into_iter()
        .flatten()
        .map(event_scan_work)
        .sum::<f64>()
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned PostgreSQL maintenance database"]
async fn issue258_event_pagination_does_not_scan_the_entire_journal(pool: PgPool) -> Result<()> {
    let f = fixture(pool).await?;
    let source = seed(&f, f.ids.room_id, 1).await?;
    // Synthetic journal records exercise the real query plan, not runtime acceptance.
    // Every page has visible matches and an authorized cause outside that page.
    sqlx::query(
        "INSERT INTO events(id,corp_id,room_id,actor_id,type,aggregate_type,aggregate_id,
         idempotency_key,causation_id,created_at)
         SELECT gen_random_uuid(),$1,$2,$3,'run.failed','run',$4,
                'history-plan-' || n,$5,now() - interval '1 hour'
         FROM generate_series(1,20000) n",
    )
    .bind(f.ids.corp_id)
    .bind(f.ids.room_id)
    .bind(f.agent_actor)
    .bind(source[0].run)
    .bind(source[0].event)
    .execute(&f.store.pool)
    .await?;
    sqlx::query("ANALYZE events").execute(&f.store.pool).await?;
    let upper: i64 = sqlx::query_scalar("SELECT max(seq) FROM events WHERE corp_id=$1")
        .bind(f.ids.corp_id)
        .fetch_one(&f.store.pool)
        .await?;
    let first = page(&f, HistoryFilters::default(), 25, None).await?;
    assert_eq!(first.entries.len(), 25);
    assert!(
        first
            .entries
            .iter()
            .all(|e| e.cause_id == Some(source[0].event))
    );
    let next = page(
        &f,
        HistoryFilters::default(),
        25,
        first.next_cursor.as_deref(),
    )
    .await?;
    assert!(
        next.entries
            .iter()
            .all(|e| e.cause_id == Some(source[0].event))
    );
    assert!(
        !next
            .entries
            .iter()
            .any(|e| first.entries.iter().any(|p| p.id == e.id))
    );

    let mut tx = f.store.pool.begin().await?;
    // SQLx reuses prepared statements. EXPLAINing a parameterized SELECT alone
    // does not demonstrate the generic plan a reused prepared SELECT may use.
    sqlx::raw_sql(&format!(
        "PREPARE history_page_plan(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,
         timestamptz,bigint,bigint,timestamptz,uuid,bigint,text[],text[]) AS {}",
        include_str!("history.sql")
    ))
    .execute(&mut *tx)
    .await?;
    for mode in ["force_custom_plan", "force_generic_plan"] {
        sqlx::query(&format!("SET LOCAL plan_cache_mode = {mode}"))
            .execute(&mut *tx)
            .await?;
        for (scenario, after, exact, scoped) in [
            ("first", None, None, false),
            ("deep-cursor", Some(upper - 5000), None, false),
            ("scoped", None, None, true),
            ("exact-old-record", None, Some(source[0].event), false),
        ] {
            // PostgreSQL quotes the typed synthetic fixture arguments. No external
            // values are interpolated into EXECUTE or the production query.
            let explain: String = sqlx::query_scalar(
                "SELECT format('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
             EXECUTE history_page_plan(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
             $1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,
             $8::text,$9::text,$10::timestamptz,$11::bigint,$12::bigint,
             $13::timestamptz,$14::uuid,$15::bigint,$16::text[],$17::text[])",
            )
            .bind(f.ids.corp_id)
            .bind(f.ids.alice_actor_id)
            .bind("event")
            .bind(scoped.then_some(f.ids.room_id))
            .bind(scoped.then_some(source[0].mission))
            .bind(scoped.then_some(f.agent_actor))
            .bind(exact)
            .bind(scoped.then_some("run.failed"))
            .bind("")
            .bind(Utc::now())
            .bind(upper)
            .bind(after)
            .bind(None::<chrono::DateTime<Utc>>)
            .bind(None::<Uuid>)
            .bind(26_i64)
            .bind(crony_domain::HISTORY_EVENT_TYPES)
            .bind(HistoryKind::Event.known_statuses())
            .fetch_one(&mut *tx)
            .await?;
            let plan: Value = sqlx::query_scalar(&explain).fetch_one(&mut *tx).await?;
            let scanned = event_scan_work(&plan[0]["Plan"]);
            eprintln!(
                "history-plan mode={mode} scenario={scenario} journal_rows=20000 returned={} event_rows_examined={scanned} execution_ms={}",
                plan[0]["Plan"]["Actual Rows"], plan[0]["Execution Time"]
            );
            assert!(
                scanned <= 260.0,
                "bounded page scanned {scanned} journal rows: {plan}"
            );
        }
    }
    let (generic, custom): (i64, i64) = sqlx::query_as(
        "SELECT generic_plans, custom_plans FROM pg_prepared_statements
         WHERE name='history_page_plan'",
    )
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!((generic, custom), (4, 4));
    sqlx::query("DEALLOCATE history_page_plan")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
