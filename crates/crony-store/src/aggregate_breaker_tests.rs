use super::*;

async fn commit_failure_preserves_transport(pool: PgPool, connected: bool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runs SET status='starting' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    let dispatch_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET idle_in_transaction_session_timeout='250ms'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(store.pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let dispatcher = PgStore {
        pool: dispatch_pool,
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    let receiver = connected.then_some(receiver);
    let outcome = dispatcher
        .with_run_budget_dispatch(CORP, run_id(1), run_id(1), "issue56-runner-1", || {
            let transport = sender.send(run_id(1));
            // PostgreSQL ends the idle transaction after the real enqueue,
            // without a production fault hook or a synthetic commit error.
            std::thread::sleep(std::time::Duration::from_millis(750));
            transport
        })
        .await;
    assert_eq!(
        receiver
            .as_ref()
            .map(|receiver| receiver.try_recv().unwrap()),
        connected.then_some(run_id(1))
    );
    dispatcher.pool.close().await;
    let outcome = outcome.expect("a commit error must retain the known transport outcome");
    assert!(
        outcome.commit_error.is_some(),
        "PostgreSQL must have terminated the transaction"
    );
    assert_eq!(outcome.transport_result.is_ok(), connected);
    if !connected {
        assert_eq!(outcome.transport_result.unwrap_err().0, run_id(1));
    }
    let state: (String, i64) = sqlx::query_as(
        "SELECT status,(SELECT count(*) FROM runner_commands WHERE run_id=$1)
         FROM runs WHERE id=$1",
    )
    .bind(run_id(1))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        ("starting".into(), 0),
        "enqueue is not runner acknowledgement"
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_commit_failure_preserves_enqueued_transport(pool: PgPool) {
    commit_failure_preserves_transport(pool, true).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_commit_failure_preserves_disconnected_transport(pool: PgPool) {
    commit_failure_preserves_transport(pool, false).await;
}

async fn wait_for_budget_operation(pool: &PgPool, application: &str) -> (i32, Vec<i32>, bool) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let blocked = sqlx::query_as(
                "SELECT pid,pg_blocking_pids(pid),
                   EXISTS(SELECT 1 FROM pg_locks lock
                     WHERE lock.pid=activity.pid AND lock.locktype='advisory' AND NOT lock.granted)
                 FROM pg_stat_activity activity
                 WHERE datname=current_database() AND application_name=$1
                   AND cardinality(pg_blocking_pids(pid))>0",
            )
            .bind(application)
            .fetch_optional(pool)
            .await
            .unwrap();
            if let Some(blocked) = blocked {
                return blocked;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual operation must reach an observed database lock")
}

async fn expiry_budget_operation(store: PgStore, approval: Uuid, accounting: bool) -> Result<()> {
    if accounting {
        store
            .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
            .await?;
    } else {
        let outcome = store
            .expire_action_approval(approval)
            .await?
            .context("pending approval must expire")?;
        assert_eq!(outcome.status, "expired");
    }
    Ok(())
}

async fn expiry_and_sibling_accounting(pool: PgPool, accounting_first: bool) {
    let store = fixture(pool).await;
    let approval = pending_approval(&store, 1).await;
    sqlx::query("UPDATE action_approvals SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(approval)
        .execute(&store.pool)
        .await
        .unwrap();
    let mut operation_pools = Vec::new();
    for application in [
        "issue56-expiry-first-operation",
        "issue56-expiry-second-operation",
    ] {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout='10s'")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(
                store
                    .pool
                    .connect_options()
                    .as_ref()
                    .clone()
                    .application_name(application),
            )
            .await
            .unwrap();
        operation_pools.push(pool);
    }
    let mut barrier = store.pool.begin().await.unwrap();
    let barrier_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM missions WHERE id=$1 FOR UPDATE")
        .bind(MISSION)
        .execute(&mut *barrier)
        .await
        .unwrap();
    let first = tokio::spawn(expiry_budget_operation(
        PgStore {
            pool: operation_pools[0].clone(),
        },
        approval,
        accounting_first,
    ));
    let (first_pid, first_blockers, _) =
        wait_for_budget_operation(&store.pool, "issue56-expiry-first-operation").await;
    assert!(first_blockers.contains(&barrier_pid));
    let second = tokio::spawn(expiry_budget_operation(
        PgStore {
            pool: operation_pools[1].clone(),
        },
        approval,
        !accounting_first,
    ));
    let (_, second_blockers, second_waits_on_gate) =
        wait_for_budget_operation(&store.pool, "issue56-expiry-second-operation").await;
    barrier.commit().await.unwrap();
    let (first_result, second_result) =
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            tokio::join!(first, second)
        })
        .await
        .expect("both real operations must finish after releasing the mission barrier");
    for pool in operation_pools {
        pool.close().await;
    }
    first_result
        .unwrap()
        .expect("first operation must commit without a deadlock");
    second_result
        .unwrap()
        .expect("second operation must commit without a deadlock");
    assert!(
        second_waits_on_gate && second_blockers.contains(&first_pid),
        "the second operation must wait at the common Corp advisory gate"
    );
    let tokens: i64 = sqlx::query_scalar("SELECT input_tokens FROM runs WHERE id=$1")
        .bind(run_id(0))
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(tokens, 100, "sibling accounting must be retained");
    let cleanup: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT approval.status,run.status,command.status FROM action_approvals approval
         JOIN runs run ON run.id=approval.run_id AND run.corp_id=approval.corp_id
         JOIN runner_commands command ON command.corp_id=approval.corp_id
           AND command.run_id=approval.run_id AND command.command_kind='approval_decision'
           AND command.payload->>'approval_id'=approval.id::text
           AND command.payload->'approved'='false'::jsonb
         WHERE approval.id=$1",
    )
    .bind(approval)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        cleanup,
        vec![("expired".into(), "cancelled".into(), "pending".into())]
    );
    assert!(
        store
            .expire_action_approval(approval)
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_expiry_serializes_after_sibling_accounting(pool: PgPool) {
    expiry_and_sibling_accounting(pool, true).await;
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_sibling_accounting_serializes_after_expiry(pool: PgPool) {
    expiry_and_sibling_accounting(pool, false).await;
}

const CORP: Uuid = Uuid::from_u128(5601);
const OWNER: Uuid = Uuid::from_u128(5602);
const ROOM: Uuid = Uuid::from_u128(5603);
const MISSION: Uuid = Uuid::from_u128(5604);

async fn fixture(pool: PgPool) -> PgStore {
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,'aggregate56','Aggregate breaker')")
        .bind(CORP)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Owner','human','owner')",
    )
    .bind(OWNER)
    .bind(CORP)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'Budget','Scope test')")
        .bind(ROOM)
        .bind(CORP)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO room_memberships(room_id,actor_id) VALUES($1,$2)")
        .bind(ROOM)
        .bind(OWNER)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,
           original_budget_tokens,budget_cost_microusd,original_budget_cost_microusd)
         VALUES($1,$2,$3,$4,'Concurrent budget','running',100,100,1000000,1000000)",
    )
    .bind(MISSION)
    .bind(CORP)
    .bind(ROOM)
    .bind(OWNER)
    .execute(&pool)
    .await
    .unwrap();
    let store = PgStore { pool };
    for i in 0..2 {
        add_run(&store, i, CORP, MISSION).await;
    }
    store
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_nested_verifier_budget_gate_has_no_actor_corp_inversion(pool: PgPool) {
    let store = fixture(pool).await;
    let mut ingestion = store.pool.begin().await.unwrap();
    aggregate_breaker::lock_corp_tx(&mut ingestion, CORP)
        .await
        .unwrap();
    let competing = store.clone();
    let recovery = tokio::spawn(async move {
        let mut tx = competing.pool.begin().await.unwrap();
        sqlx::query("SET LOCAL application_name='issue56-budget-lock-order'")
            .execute(&mut *tx)
            .await
            .unwrap();
        lock_factory_keys_tx(&mut tx, &budget_scope_lock_keys(CORP, OWNER))
            .await
            .unwrap();
        tx.commit().await.unwrap();
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                 WHERE application_name='issue56-budget-lock-order'
                 AND cardinality(pg_blocking_pids(pid))>0)",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("competing recovery must wait on the ingestion Corp gate");
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        lock_factory_keys_tx(&mut ingestion, &budget_scope_lock_keys(CORP, OWNER)),
    )
    .await
    .expect("nested verifier gate must not invert actor/Corp lock order")
    .unwrap();
    ingestion.commit().await.unwrap();
    recovery.await.unwrap();
}

pub(super) fn run_id(index: u128) -> Uuid {
    Uuid::from_u128(5610 + index * 4)
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_native_enqueue_rejects_fenced_and_wrong_assignments(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runs SET status='starting' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    for (corp, token, runner) in [
        (Uuid::new_v4(), run_id(1), "issue56-runner-1"),
        (CORP, Uuid::new_v4(), "issue56-runner-1"),
        (CORP, run_id(1), "issue56-runner-0"),
    ] {
        assert!(
            store
                .with_run_budget_dispatch(corp, run_id(1), token, runner, || {
                    panic!("wrong assignment must never enqueue native work")
                })
                .await
                .is_err()
        );
    }
    store
        .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
        .await
        .unwrap();
    let error = store
        .with_run_budget_dispatch(CORP, run_id(1), run_id(1), "issue56-runner-1", || {
            panic!("a fenced starting run must never enqueue StartRun or ResumeRun")
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("breaker"));
    assert_eq!(stage(&store, 1).await, "suspend");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_native_enqueue_precedes_a_concurrent_fence(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runs SET status='starting' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
        .bind(run_id(1))
        .execute(&mut *barrier)
        .await
        .unwrap();
    let enqueued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sent = enqueued.clone();
    let dispatcher = store.clone();
    let dispatch = tokio::spawn(async move {
        dispatcher
            .with_run_budget_dispatch(CORP, run_id(1), run_id(1), "issue56-runner-1", || {
                sent.store(true, std::sync::atomic::Ordering::SeqCst);
                true
            })
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                 WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker)
            .fetch_one(&store.pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("native enqueue must hold the Corp gate while awaiting its assignment row");
    let accounting = store.clone();
    let mut usage = tokio::spawn(async move {
        let outcome = accounting
            .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
            .await;
        assert!(enqueued.load(std::sync::atomic::Ordering::SeqCst));
        outcome
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut usage)
            .await
            .is_err()
    );
    barrier.commit().await.unwrap();
    let dispatched = dispatch.await.unwrap().unwrap();
    assert!(dispatched.transport_result);
    assert!(dispatched.commit_error.is_none());
    assert_eq!(usage.await.unwrap().unwrap().breaker_commands.len(), 2);
    assert_eq!(stage(&store, 1).await, "suspend");
}

pub(super) async fn add_run(store: &PgStore, index: u128, corp: Uuid, mission: Uuid) {
    let run = run_id(index);
    let agent = Uuid::from_u128(run.as_u128() + 1);
    let actor = Uuid::from_u128(run.as_u128() + 2);
    let task = Uuid::from_u128(run.as_u128() + 3);
    sqlx::query(
        "INSERT INTO runner_nodes(id,corp_id,hostname,os,connection_epoch,status)
        VALUES($1,$2,'fixture','test',$3,'connected')",
    )
    .bind(format!("issue56-runner-{index}"))
    .bind(corp)
    .bind(Uuid::new_v4())
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Worker','agent','worker')",
    )
    .bind(actor)
    .bind(corp)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents(id,corp_id,actor_id,name,role,adapter,status,accent,current_run_id)
         VALUES($1,$2,$3,'Worker','worker','fake-process','working','#123456',$4)",
    )
    .bind(agent)
    .bind(corp)
    .bind(actor)
    .bind(run)
    .execute(&store.pool)
    .await
    .unwrap();
    let contract = json!({
        "objective":"Budget boundary", "expected_output":"result.md",
        "acceptance_tests":[], "allowed_tools":["filesystem"],
        "prohibited_actions":[], "references":[], "write_scope":["result.md"],
        "budget_tokens":10000, "budget_cost_microusd":1000000,
        "deadline_at":null, "escalation":"ask owner"
    });
    sqlx::query(
        "INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,
           required_adapter,plan_key,contract,verification_policy,attempt_count,max_attempts)
         VALUES($1,$2,$3,'Worker','Budget boundary','running',$4,'fake-process',$5,$6,
           '{\"checks\":[],\"manual_gate\":null}',1,2)",
    )
    .bind(task)
    .bind(corp)
    .bind(mission)
    .bind(agent)
    .bind(format!("worker-{index}"))
    .bind(contract)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
           workspace_run_id,budget_tokens_limit,budget_cost_microusd_limit)
         VALUES($1,$2,$3,$4,$5,$1,'running',$1,10000,1000000)",
    )
    .bind(run)
    .bind(corp)
    .bind(task)
    .bind(agent)
    .bind(format!("issue56-runner-{index}"))
    .execute(&store.pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_mission_hard_budget_fences_all_active_runs(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runs SET input_tokens=100 WHERE id=$1")
        .bind(run_id(0))
        .execute(&store.pool)
        .await
        .unwrap();
    store
        .evaluate_circuit_breaker(CORP, run_id(0))
        .await
        .unwrap();
    let stages: Vec<String> =
        sqlx::query_scalar("SELECT breaker_stage FROM runs WHERE corp_id=$1 ORDER BY id")
            .bind(CORP)
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(stages, vec!["suspend", "suspend"]);
    let commands: i64 = sqlx::query_scalar("SELECT count(*) FROM runner_commands WHERE corp_id=$1")
        .bind(CORP)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(commands, 2);
}

fn event(index: u128, kind: &str, payload: Value) -> RunnerEventInput {
    RunnerEventInput {
        event_id: Uuid::new_v4(),
        runner_id: format!("issue56-runner-{index}"),
        corp_id: CORP,
        connection_epoch: Uuid::new_v4(),
        run_id: run_id(index),
        agent_id: Uuid::from_u128(run_id(index).as_u128() + 1),
        assignment_token: run_id(index),
        event_type: kind.to_owned(),
        payload,
    }
}

async fn stage(store: &PgStore, index: u128) -> String {
    sqlx::query_scalar("SELECT breaker_stage FROM runs WHERE id=$1")
        .bind(run_id(index))
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

async fn scopes(store: &PgStore) {
    sqlx::query(
        "INSERT INTO actors(id,corp_id,name,kind,role)
        VALUES($1,$2,'Other requester','human','owner')",
    )
    .bind(Uuid::from_u128(5700))
    .bind(CORP)
    .execute(&store.pool)
    .await
    .unwrap();
    for (id, requester, index) in [(5701, OWNER, 2), (5702, Uuid::from_u128(5700), 3)] {
        sqlx::query(
            "INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,
            budget_tokens,budget_cost_microusd,original_budget_tokens,original_budget_cost_microusd)
            VALUES($1,$2,$3,$4,'Other mission','running',10000,1000000,10000,1000000)",
        )
        .bind(Uuid::from_u128(id))
        .bind(CORP)
        .bind(ROOM)
        .bind(requester)
        .execute(&store.pool)
        .await
        .unwrap();
        add_run(store, index, CORP, Uuid::from_u128(id)).await;
    }
    sqlx::query("UPDATE missions SET budget_tokens=10000 WHERE corp_id=$1")
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,'other56','Other tenant')")
        .bind(Uuid::from_u128(5800))
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Other','human','owner')",
    )
    .bind(Uuid::from_u128(5801))
    .bind(Uuid::from_u128(5800))
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO rooms(id,corp_id,name,purpose) VALUES($1,$2,'Other','Other')")
        .bind(Uuid::from_u128(5802))
        .bind(Uuid::from_u128(5800))
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,
        original_budget_tokens,original_budget_cost_microusd)
        VALUES($1,$2,$3,$4,'Other','running',10000,10000,5000000)",
    )
    .bind(Uuid::from_u128(5803))
    .bind(Uuid::from_u128(5800))
    .bind(Uuid::from_u128(5802))
    .bind(Uuid::from_u128(5801))
    .execute(&store.pool)
    .await
    .unwrap();
    add_run(store, 4, Uuid::from_u128(5800), Uuid::from_u128(5803)).await;
}

async fn scoped_limit(pool: PgPool, scope: &str, cost: bool) {
    let store = fixture(pool).await;
    scopes(&store).await;
    let limit = if cost {
        "budget_cost_microusd"
    } else {
        "budget_tokens"
    };
    match scope {
        "mission" => {
            sqlx::query(&format!(
                "UPDATE missions SET {limit}=100,original_{limit}=100 WHERE id=$1"
            ))
            .bind(MISSION)
            .execute(&store.pool)
            .await
            .unwrap();
        }
        "requester_24h" | "corp_24h" => {
            let actor_tokens = if !cost && scope == "requester_24h" {
                100
            } else {
                10000
            };
            let actor_cost = if cost && scope == "requester_24h" {
                100
            } else {
                10000
            };
            let corp_tokens = if !cost && scope == "corp_24h" {
                100
            } else {
                10000
            };
            let corp_cost = if cost && scope == "corp_24h" {
                100
            } else {
                10000
            };
            store
                .set_budget_policy(
                    CORP,
                    OWNER,
                    actor_tokens,
                    actor_cost,
                    corp_tokens,
                    corp_cost,
                    8,
                    5,
                )
                .await
                .unwrap();
        }
        _ => unreachable!(),
    }
    // Old active work is fenced too, although its usage no longer contributes to rolling totals.
    sqlx::query("UPDATE runs SET created_at=now()-interval '25 hours' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    if scope != "mission" {
        sqlx::query("UPDATE runs SET input_tokens=200,cost_microusd=200 WHERE id=$1")
            .bind(run_id(1))
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let suspended = store
        .apply_runner_event(event(
            0,
            "run.usage",
            json!({
                "input_tokens":if cost {0} else {100},"output_tokens":0,
                "cost_microusd":if cost {100} else {0}
            }),
        ))
        .await
        .unwrap();
    let affected = if scope == "mission" {
        2
    } else if scope == "requester_24h" {
        3
    } else {
        4
    };
    let ids: Vec<_> = (0..affected as u128).map(run_id).collect();
    assert_eq!(suspended.breaker_commands.len(), affected);
    for index in 0..affected as u128 {
        assert_eq!(stage(&store, index).await, "suspend");
    }
    let usage = store
        .apply_runner_event(event(
            0,
            "run.usage",
            json!({
                "input_tokens":if cost {0} else {10},"output_tokens":0,
                "cost_microusd":if cost {10} else {0}
            }),
        ))
        .await
        .unwrap();
    assert_eq!(usage.breaker_commands.len(), affected);
    for index in 0..5 {
        assert_eq!(
            stage(&store, index).await,
            if index < affected as u128 {
                "stop"
            } else {
                "healthy"
            }
        );
    }
    for transition in usage.related_events {
        assert_eq!(transition.payload["input"]["scope"], scope);
        assert_eq!(transition.payload["input"]["used"], 110);
        assert_eq!(transition.payload["input"]["limit"], 100);
        assert_eq!(transition.payload["input"]["affected_run_ids"], json!(ids));
    }
    let replay = store
        .evaluate_circuit_breaker(CORP, run_id(0))
        .await
        .unwrap();
    assert!(replay.commands.is_empty());
    assert!(replay.events.is_empty());
}

macro_rules! scope_test {
    ($name:ident,$scope:literal,$cost:literal) => {
        #[sqlx::test(migrations = "../../db/migrations")]
        #[ignore = "requires an explicitly owned disposable PostgreSQL database"]
        async fn $name(pool: PgPool) {
            scoped_limit(pool, $scope, $cost).await;
        }
    };
}
scope_test!(issue56_mission_tokens, "mission", false);
scope_test!(issue56_mission_cost, "mission", true);
scope_test!(issue56_requester_tokens, "requester_24h", false);
scope_test!(issue56_requester_cost, "requester_24h", true);
scope_test!(issue56_corp_tokens, "corp_24h", false);
scope_test!(issue56_corp_cost, "corp_24h", true);

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_run_only_and_monotonic_aggregate_escalation(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runs SET budget_tokens_limit=10 WHERE id=$1")
        .bind(run_id(0))
        .execute(&store.pool)
        .await
        .unwrap();
    store
        .apply_runner_event(event(0, "run.usage", json!({"input_tokens":11})))
        .await
        .unwrap();
    assert_eq!(stage(&store, 0).await, "stop");
    assert_eq!(stage(&store, 1).await, "healthy");
    for (amount, expected) in [(89, "suspend"), (10, "stop")] {
        let outcome = store
            .apply_runner_event(event(0, "run.usage", json!({"input_tokens":amount})))
            .await
            .unwrap();
        assert_eq!(outcome.breaker_commands.len(), 1);
        assert_eq!(outcome.breaker_commands[0].run_id, run_id(1));
        assert_eq!(stage(&store, 1).await, expected);
    }
    let groups: Vec<(Uuid, String, i64)> = sqlx::query_as(
        "SELECT run_id,payload->>'stage',count(*) FROM runner_commands
         GROUP BY run_id,payload->>'stage'",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(groups.len(), 3);
    assert!(groups.iter().all(|(_, _, count)| *count == 1));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_usage_and_all_commands_rollback_together(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::raw_sql(
        "CREATE FUNCTION fail_breaker56() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture command failure'; END $$;
        CREATE TRIGGER fail_breaker56 BEFORE INSERT ON runner_commands
        FOR EACH ROW EXECUTE FUNCTION fail_breaker56();",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let error = store
        .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("fixture command failure"));
    for index in 0..2 {
        assert_eq!(stage(&store, index).await, "healthy");
    }
    let totals: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT sum(input_tokens)::bigint FROM runs),
         (SELECT count(*) FROM runner_commands),(SELECT count(*) FROM events),
         (SELECT count(*) FROM circuit_breaker_incidents)",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(totals, (0, 0, 0, 0));
}

async fn pending_review(store: &PgStore, index: u128) {
    let run = run_id(index);
    sqlx::query("UPDATE runs SET status='waiting_for_approval' WHERE id=$1")
        .bind(run)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET status='awaiting_approval' WHERE id=$1")
        .bind(Uuid::from_u128(run.as_u128() + 3))
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO verification_requests(run_id,corp_id,task_id,gate_type,gate)
        VALUES($1,$2,$3,'human_approval','{\"type\":\"human_approval\",\"roles\":[\"owner\"]}')",
    )
    .bind(run)
    .bind(CORP)
    .bind(Uuid::from_u128(run.as_u128() + 3))
    .execute(&store.pool)
    .await
    .unwrap();
}

async fn pending_approval(store: &PgStore, index: u128) -> Uuid {
    let approval = Uuid::new_v4();
    store
        .apply_runner_event(event(
            index,
            "run.approval_requested",
            json!({
                "approval_id":approval,"action_key":"fixture","action":"write",
                "risk":"high","rationale":"fixture","required_roles":["owner"],
                "expires_in_seconds":300
            }),
        ))
        .await
        .unwrap();
    approval
}

async fn queued_progress_commands(store: &PgStore) -> Vec<PendingRunnerCommand> {
    let approval = pending_approval(store, 1).await;
    store
        .decide_action_approval(CORP, approval, OWNER, true, "", Uuid::new_v4())
        .await
        .unwrap();
    let agent = Uuid::from_u128(run_id(1).as_u128() + 1);
    let lease = store.acquire_lease(CORP, agent, OWNER).await.unwrap();
    assert!(lease.acquired);
    assert!(
        store
            .queue_message(
                CORP,
                agent,
                OWNER,
                Some(lease.lease.token),
                "Continue",
                Uuid::new_v4()
            )
            .await
            .unwrap()
            .command_queued
    );
    let commands = store
        .pending_runner_commands("issue56-runner-1")
        .await
        .unwrap();
    assert_eq!(commands.len(), 2);
    commands
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_progress_enqueue_binds_durable_identity_and_lifecycle(pool: PgPool) {
    let store = fixture(pool).await;
    let commands = queued_progress_commands(&store).await;
    for command in &commands {
        for field in ["id", "corp", "run", "runner", "kind", "payload"] {
            let mut changed = command.clone();
            match field {
                "id" => changed.id = Uuid::new_v4(),
                "corp" => changed.corp_id = Uuid::new_v4(),
                "run" => changed.run_id = run_id(0),
                "runner" => changed.runner_id = "issue56-runner-0".to_owned(),
                "kind" => {
                    changed.command_kind = if command.command_kind == "control_message" {
                        "approval_decision".to_owned()
                    } else {
                        "control_message".to_owned()
                    }
                }
                "payload" => changed.payload["unexpected"] = json!(true),
                _ => unreachable!(),
            }
            assert_eq!(
                store
                    .with_progress_command_dispatch(&changed, |_| {
                        panic!("mismatched {field} must never enqueue")
                    })
                    .await
                    .unwrap(),
                RunnerCommandDispatchOutcome::Settled
            );
        }
        assert_eq!(
            store
                .with_progress_command_dispatch(command, |_| Ok(false))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Disconnected
        );
        assert_eq!(
            store
                .with_progress_command_dispatch(command, |_| Ok(true))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Sent
        );
    }
    store
        .acknowledge_runner_command(commands[0].id, &commands[0].runner_id)
        .await
        .unwrap();
    assert_eq!(
        store
            .with_progress_command_dispatch(&commands[0], |_| panic!("settled command"))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Settled
    );
    sqlx::query("UPDATE runs SET status='completed' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .with_progress_command_dispatch(&commands[1], |_| panic!("terminal run"))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Obsolete
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_expired_approval_cleanup_reaches_terminal_fenced_runner(pool: PgPool) {
    let store = fixture(pool).await;
    let approval = pending_approval(&store, 1).await;
    sqlx::query("UPDATE action_approvals SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(approval)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .expire_action_approval(approval)
            .await
            .unwrap()
            .unwrap()
            .status,
        "expired"
    );
    let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE id=$1")
        .bind(run_id(1))
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(status, "cancelled");
    sqlx::query("UPDATE runs SET breaker_stage='stop' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    let commands = store
        .pending_runner_commands("issue56-runner-1")
        .await
        .unwrap();
    assert_eq!(commands.len(), 1);
    let command = &commands[0];
    assert_eq!(command.payload["approved"], false);
    assert_eq!(
        store.runner_command_dispatch_state(command).await.unwrap(),
        RunnerCommandDispatchState::Pending
    );
    assert_eq!(
        store
            .with_progress_command_dispatch(command, |_| Ok(false))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Disconnected
    );
    assert_eq!(
        store
            .with_progress_command_dispatch(command, |_| Ok(true))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Sent
    );
    // Enqueue must not manufacture a provider acknowledgement or revive the run.
    let durable: (String, String) = sqlx::query_as(
        "SELECT command.status,run.status FROM runner_commands command
         JOIN runs run ON run.id=command.run_id WHERE command.id=$1",
    )
    .bind(command.id)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(durable, ("pending".into(), "cancelled".into()));
    store
        .acknowledge_runner_command(command.id, &command.runner_id)
        .await
        .unwrap();
    assert_eq!(
        store
            .with_progress_command_dispatch(command, |_| panic!("already acknowledged"))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Settled
    );
    assert!(
        store
            .expire_action_approval(approval)
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_rejection_cleanup_requires_durable_negative_approval_scope(pool: PgPool) {
    let store = fixture(pool).await;
    let unrelated = pending_approval(&store, 0).await;
    let approval = pending_approval(&store, 1).await;
    store
        .decide_action_approval(CORP, approval, OWNER, false, "deny", Uuid::new_v4())
        .await
        .unwrap();
    let commands = store
        .pending_runner_commands("issue56-runner-1")
        .await
        .unwrap();
    assert_eq!(commands.len(), 1);
    let command = &commands[0];
    // Persist usage without evaluation: a denial may still release the suspended
    // provider when progress would already be blocked by aggregate accounting.
    sqlx::query("UPDATE runs SET input_tokens=100 WHERE id=$1")
        .bind(run_id(0))
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .with_progress_command_dispatch(command, |_| Ok(true))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Sent
    );
    sqlx::query("UPDATE runs SET breaker_stage='suspend' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    for field in ["id", "corp", "run", "runner", "kind", "payload"] {
        let mut changed = command.clone();
        match field {
            "id" => changed.id = Uuid::new_v4(),
            "corp" => changed.corp_id = Uuid::new_v4(),
            "run" => changed.run_id = run_id(0),
            "runner" => changed.runner_id = "issue56-runner-0".into(),
            "kind" => changed.command_kind = "control_message".into(),
            "payload" => changed.payload["approved"] = json!(true),
            _ => unreachable!(),
        }
        assert_eq!(
            store.runner_command_dispatch_state(&changed).await.unwrap(),
            RunnerCommandDispatchState::Settled
        );
        assert_eq!(
            store
                .with_progress_command_dispatch(&changed, |_| panic!("mismatched {field}"))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Settled
        );
    }
    // Even a durable false payload is insufficient when its approval is missing,
    // belongs to a different run, or does not have a final negative decision.
    for payload in [
        json!({"approval_id":Uuid::new_v4(),"approved":false}),
        json!({"approval_id":unrelated,"approved":false}),
        json!({"approval_id":approval,"approved":true}),
        json!({"approval_id":approval,"approved":"false"}),
        json!({"approval_id":approval}),
    ] {
        sqlx::query("UPDATE runner_commands SET payload=$1 WHERE id=$2")
            .bind(&payload)
            .bind(command.id)
            .execute(&store.pool)
            .await
            .unwrap();
        let changed = PendingRunnerCommand {
            payload,
            ..command.clone()
        };
        assert_eq!(
            store.runner_command_dispatch_state(&changed).await.unwrap(),
            RunnerCommandDispatchState::Obsolete
        );
        assert_eq!(
            store
                .with_progress_command_dispatch(&changed, |_| panic!("unproven negative decision"))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Obsolete
        );
    }
    sqlx::query("UPDATE runner_commands SET payload=$1 WHERE id=$2")
        .bind(&command.payload)
        .bind(command.id)
        .execute(&store.pool)
        .await
        .unwrap();
    for status in ["pending", "approved", "rejected"] {
        sqlx::query("UPDATE action_approvals SET status=$1 WHERE id=$2")
            .bind(status)
            .bind(approval)
            .execute(&store.pool)
            .await
            .unwrap();
        if status == "rejected" {
            assert_eq!(
                store.runner_command_dispatch_state(command).await.unwrap(),
                RunnerCommandDispatchState::Pending
            );
            assert_eq!(
                store
                    .with_progress_command_dispatch(command, |_| Ok(true))
                    .await
                    .unwrap(),
                RunnerCommandDispatchOutcome::Sent
            );
        } else {
            assert_eq!(
                store.runner_command_dispatch_state(command).await.unwrap(),
                RunnerCommandDispatchState::Obsolete
            );
            assert_eq!(
                store
                    .with_progress_command_dispatch(command, |_| panic!("approval is not rejected"))
                    .await
                    .unwrap(),
                RunnerCommandDispatchOutcome::Obsolete
            );
        }
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_progress_enqueue_checks_usage_before_persisted_fence(pool: PgPool) {
    let store = fixture(pool).await;
    let commands = queued_progress_commands(&store).await;
    sqlx::query("UPDATE runs SET input_tokens=100 WHERE id=$1")
        .bind(run_id(0))
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(!breaker_is_hard(&stage(&store, 1).await));
    for command in &commands {
        assert_eq!(
            store
                .with_progress_command_dispatch(command, |_| panic!("aggregate budget reached"))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Obsolete
        );
    }
    store
        .evaluate_circuit_breaker(CORP, run_id(0))
        .await
        .unwrap();
    assert_eq!(stage(&store, 1).await, "suspend");
    for command in &commands {
        assert_eq!(
            store
                .with_progress_command_dispatch(command, |_| panic!("persisted fence"))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Obsolete
        );
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_progress_enqueue_precedes_concurrent_accounting(pool: PgPool) {
    let store = fixture(pool).await;
    let commands = queued_progress_commands(&store).await;
    // Exercise the production lock order: the dispatcher holds the Corp gate
    // while waiting for this run, so accounting cannot fence between check/send.
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
        .bind(run_id(1))
        .execute(&mut *barrier)
        .await
        .unwrap();
    let enqueued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sent = enqueued.clone();
    let dispatcher = store.clone();
    let command = commands[0].clone();
    let dispatch = tokio::spawn(async move {
        dispatcher
            .with_progress_command_dispatch(&command, |_| {
                sent.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(true)
            })
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                 WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker)
            .fetch_one(&store.pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("progress dispatch must reach its run lock under the Corp gate");
    let accounting = store.clone();
    let mut usage = tokio::spawn(async move {
        let outcome = accounting
            .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
            .await;
        assert!(enqueued.load(std::sync::atomic::Ordering::SeqCst));
        outcome
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut usage)
            .await
            .is_err()
    );
    barrier.commit().await.unwrap();
    assert_eq!(
        dispatch.await.unwrap().unwrap(),
        RunnerCommandDispatchOutcome::Sent
    );
    assert_eq!(usage.await.unwrap().unwrap().breaker_commands.len(), 2);
    for command in &commands {
        assert_eq!(
            store
                .with_progress_command_dispatch(command, |_| panic!("late progress enqueue"))
                .await
                .unwrap(),
            RunnerCommandDispatchOutcome::Obsolete
        );
    }
}

async fn queue_control(store: &PgStore, index: u128) -> (ControlLease, PendingRunnerCommand) {
    let agent = Uuid::from_u128(run_id(index).as_u128() + 1);
    let acquired = store.acquire_lease(CORP, agent, OWNER).await.unwrap();
    assert!(acquired.acquired);
    let message = store
        .queue_message(
            CORP,
            agent,
            OWNER,
            Some(acquired.lease.token),
            "Continue",
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert!(message.command_queued);
    let command = store
        .pending_runner_commands(&format!("issue56-runner-{index}"))
        .await
        .unwrap()
        .into_iter()
        .find(|command| command.payload["message_id"] == json!(message.message.id))
        .unwrap();
    (acquired.lease, command)
}

async fn wait_for_control_blocker(pool: &PgPool, blocker: i32) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                 WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker)
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("control operation must reach the real PostgreSQL lock barrier");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_control_dispatch_revalidates_lease_after_run_wait(pool: PgPool) {
    let store = fixture(pool).await;
    let recipient = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO actors(id,corp_id,name,kind,role) VALUES($1,$2,'Recipient','human','member')",
    )
    .bind(recipient)
    .bind(CORP)
    .execute(&store.pool)
    .await
    .unwrap();
    for (offset, mutation) in [
        "renew",
        "release",
        "transfer",
        "expire",
        "release_reacquire",
    ]
    .into_iter()
    .enumerate()
    {
        let index = 10 + offset as u128;
        add_run(&store, index, CORP, MISSION).await;
        let (lease, command) = queue_control(&store, index).await;
        let mut barrier = store.pool.begin().await.unwrap();
        let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *barrier)
            .await
            .unwrap();
        sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
            .bind(command.run_id)
            .execute(&mut *barrier)
            .await
            .unwrap();
        let dispatcher = store.clone();
        let dispatch = tokio::spawn(async move {
            dispatcher
                .with_progress_command_dispatch(&command, |_| {
                    panic!("stale control after {mutation}")
                })
                .await
        });
        wait_for_control_blocker(&store.pool, blocker).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            match mutation {
                "renew" => {
                    let renewed = store.acquire_lease(CORP, lease.agent_id, OWNER).await.unwrap();
                    assert!(renewed.acquired);
                    assert!(renewed.lease.lease_version > lease.lease_version);
                    assert_ne!(renewed.lease.token, lease.token);
                }
                "release" | "release_reacquire" => {
                    let released = store.release_lease(CORP, lease.agent_id, OWNER, lease.token).await.unwrap();
                    assert!(released.lease.is_none());
                    if mutation == "release_reacquire" {
                        let reacquired = store.acquire_lease(CORP, lease.agent_id, OWNER).await.unwrap();
                        assert!(reacquired.acquired);
                        assert!(reacquired.lease.lease_version > lease.lease_version, "release must preserve the version fence");
                    }
                }
                "transfer" => {
                    let transferred = store.transfer_lease(CORP, lease.agent_id, OWNER, lease.token, recipient).await.unwrap();
                    assert_eq!(transferred.lease.unwrap().actor_id, recipient);
                }
                "expire" => {
                    sqlx::query("UPDATE control_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE agent_id=$1")
                        .bind(lease.agent_id).execute(&store.pool).await.unwrap();
                }
                _ => unreachable!(),
            }
        }).await.expect("lease mutation must not wait for the blocked run");
        barrier.commit().await.unwrap();
        assert_eq!(
            dispatch.await.unwrap().unwrap(),
            RunnerCommandDispatchOutcome::Obsolete,
            "{mutation}"
        );
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_control_dispatch_locks_and_rechecks_lease_row(pool: PgPool) {
    let store = fixture(pool).await;
    let (lease, command) = queue_control(&store, 1).await;
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT agent_id FROM control_leases WHERE agent_id=$1 FOR UPDATE")
        .bind(lease.agent_id)
        .execute(&mut *barrier)
        .await
        .unwrap();
    let dispatcher = store.clone();
    let dispatch = tokio::spawn(async move {
        dispatcher
            .with_progress_command_dispatch(&command, |_| panic!("stale MVCC lease snapshot"))
            .await
    });
    wait_for_control_blocker(&store.pool, blocker).await;
    sqlx::query(
        "UPDATE control_leases SET token=$2,lease_version=lease_version+1 WHERE agent_id=$1",
    )
    .bind(lease.agent_id)
    .bind(Uuid::new_v4())
    .execute(&mut *barrier)
    .await
    .unwrap();
    barrier.commit().await.unwrap();
    assert_eq!(
        dispatch.await.unwrap().unwrap(),
        RunnerCommandDispatchOutcome::Obsolete
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_control_dispatch_checks_wall_clock_after_lock_wait(pool: PgPool) {
    let store = fixture(pool).await;
    let (lease, command) = queue_control(&store, 1).await;
    let expiry: chrono::DateTime<Utc> = sqlx::query_scalar(
        "UPDATE control_leases SET expires_at=clock_timestamp()+interval '3 seconds' WHERE agent_id=$1 RETURNING expires_at",
    ).bind(lease.agent_id).fetch_one(&store.pool).await.unwrap();
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
        .bind(command.run_id)
        .execute(&mut *barrier)
        .await
        .unwrap();
    let dispatcher = store.clone();
    let dispatch = tokio::spawn(async move {
        dispatcher
            .with_progress_command_dispatch(&command, |_| {
                panic!("lease expired while the transaction waited")
            })
            .await
    });
    wait_for_control_blocker(&store.pool, blocker).await;
    let began_before_expiry: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
         AND $1=ANY(pg_blocking_pids(pid)) AND xact_start < $2)",
    )
    .bind(blocker)
    .bind(expiry)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(
        began_before_expiry,
        "the test must cover expiry after transaction start"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !sqlx::query_scalar::<_, bool>("SELECT clock_timestamp() >= $1")
            .bind(expiry)
            .fetch_one(&store.pool)
            .await
            .unwrap()
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    barrier.commit().await.unwrap();
    assert_eq!(
        dispatch.await.unwrap().unwrap(),
        RunnerCommandDispatchOutcome::Obsolete
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_control_dispatch_uses_locked_token_and_preserves_retry(pool: PgPool) {
    let store = fixture(pool).await;
    let (lease, command) = queue_control(&store, 1).await;
    let error = store
        .with_progress_command_dispatch(&command, |token| {
            assert_eq!(token, Some(lease.token));
            Err(anyhow!("fixture decode failure"))
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("fixture decode failure"));
    let status: String = sqlx::query_scalar("SELECT status FROM runner_commands WHERE id=$1")
        .bind(command.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(status, "pending");
    assert_eq!(
        store
            .with_progress_command_dispatch(&command, |token| {
                assert_eq!(token, Some(lease.token));
                Ok(true)
            })
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Sent
    );
    let status: String = sqlx::query_scalar("SELECT status FROM runner_commands WHERE id=$1")
        .bind(command.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(status, "pending", "enqueue is not a runner acknowledgement");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_interrupt_waits_for_run_without_holding_lease(pool: PgPool) {
    let store = fixture(pool).await;
    let (lease, _) = queue_control(&store, 1).await;
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM runs WHERE id=$1 FOR UPDATE")
        .bind(run_id(1))
        .execute(&mut *barrier)
        .await
        .unwrap();
    let controller = store.clone();
    let agent = lease.agent_id;
    let token = lease.token;
    let interrupt = tokio::spawn(async move {
        controller
            .request_interrupt(CORP, agent, OWNER, token, "Stop stale work")
            .await
    });
    wait_for_control_blocker(&store.pool, blocker).await;
    let renewed = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        store.acquire_lease(CORP, agent, OWNER),
    )
    .await
    .expect("interrupt must not hold the lease while waiting for the run")
    .unwrap();
    assert!(renewed.acquired);
    assert_ne!(renewed.lease.token, token);
    barrier.commit().await.unwrap();
    let error = interrupt.await.unwrap().unwrap_err();
    assert!(
        error
            .to_string()
            .contains("stale or unauthorized control lease token")
    );
}

fn artifact(index: u128, input: &RunnerEventInput) -> StoredArtifact {
    StoredArtifact {
        id: input.event_id,
        corp_id: CORP,
        task_id: Uuid::from_u128(run_id(index).as_u128() + 3),
        run_id: run_id(index),
        producer_agent_id: input.agent_id,
        producer_runner_id: input.runner_id.clone(),
        verifier: "fixture".to_owned(),
        object_key: format!("corps/{CORP}/{}", input.event_id),
        uri: "fixture".to_owned(),
        sha256: "a".repeat(64),
        media_type: "text/plain".to_owned(),
        bytes: 1,
        artifact_role: "provider_evidence".to_owned(),
        file_name: "result.md".to_owned(),
        metadata: json!({}),
        provenance_signature: "b".repeat(64),
        retention_until: Utc::now() + Duration::days(1),
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_pending_effects_and_staged_artifacts_cannot_cross_fence(pool: PgPool) {
    let store = fixture(pool).await;
    let approval = pending_approval(&store, 1).await;
    pending_review(&store, 1).await;
    let input = event(1, "run.artifact_upload", json!({}));
    let staged = artifact(1, &input);
    store
        .prepare_artifact_upload(
            input,
            staged.clone(),
            &format!("staging/corps/{CORP}/{}", staged.id),
        )
        .await
        .unwrap();
    store
        .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
        .await
        .unwrap();
    assert!(
        store
            .decide_action_approval(CORP, approval, OWNER, true, "", Uuid::new_v4())
            .await
            .is_err()
    );
    assert!(
        store
            .decide_verification(CORP, run_id(1), OWNER, true, "", Some(Uuid::new_v4()))
            .await
            .is_err()
    );
    assert!(
        store
            .finalize_artifact_upload(CORP, staged.id)
            .await
            .is_err()
    );
    for kind in ["run.completed", "run.verification_passed", "run.artifact"] {
        assert!(
            store
                .apply_runner_event(event(1, kind, json!({})))
                .await
                .is_err(),
            "{kind}"
        );
    }
    let input = event(1, "run.artifact_upload", json!({}));
    let new_artifact = artifact(1, &input);
    assert!(
        store
            .prepare_artifact_upload(
                input,
                new_artifact.clone(),
                &format!("staging/corps/{CORP}/{}", new_artifact.id)
            )
            .await
            .is_err()
    );
    let state: (String, String, String) = sqlx::query_as(
        "SELECT (SELECT status FROM action_approvals WHERE id=$1),
         (SELECT status FROM verification_requests WHERE run_id=$2),
         (SELECT status FROM artifacts WHERE id=$3)",
    )
    .bind(approval)
    .bind(run_id(1))
    .bind(staged.id)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        (
            "pending".to_owned(),
            "pending".to_owned(),
            "staged".to_owned()
        )
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_exhausted_dispatch_has_no_assignment_side_effects(pool: PgPool) {
    let store = fixture(pool).await;
    for scope in ["mission", "requester", "corp"] {
        sqlx::query("UPDATE missions SET budget_tokens=$1 WHERE id=$2")
            .bind(if scope == "mission" { 100_i64 } else { 10000 })
            .bind(MISSION)
            .execute(&store.pool)
            .await
            .unwrap();
        store
            .set_budget_policy(
                CORP,
                OWNER,
                if scope == "requester" { 100 } else { 10000 },
                10000,
                if scope == "corp" { 100 } else { 10000 },
                10000,
                8,
                5,
            )
            .await
            .unwrap();
        sqlx::query("UPDATE runs SET input_tokens=100 WHERE id=$1")
            .bind(run_id(0))
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE runs SET status='cancelled' WHERE id=$1")
            .bind(run_id(1))
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET status='ready' WHERE id=$1")
            .bind(Uuid::from_u128(run_id(1).as_u128() + 3))
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE agents SET status='idle',current_run_id=NULL WHERE id=$1")
            .bind(Uuid::from_u128(run_id(1).as_u128() + 1))
            .execute(&store.pool)
            .await
            .unwrap();
        let error = store
            .create_task_run(
                CORP,
                MISSION,
                Uuid::from_u128(run_id(1).as_u128() + 3),
                Some(OWNER),
                "issue56-runner-1",
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("no remaining"),
            "{scope}: {error}"
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM runs")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_concurrent_usage_is_serialized_and_replay_is_exact(pool: PgPool) {
    let store = fixture(pool).await;
    let a = event(0, "run.usage", json!({"input_tokens":50}));
    let b = event(1, "run.usage", json!({"input_tokens":50}));
    let (first, second) = tokio::join!(
        store.apply_runner_event(a.clone()),
        store.apply_runner_event(b.clone())
    );
    let commands = first.unwrap().breaker_commands.len() + second.unwrap().breaker_commands.len();
    assert_eq!(commands, 2);
    for index in 0..2 {
        assert_eq!(stage(&store, index).await, "suspend");
    }
    for replay in [a, b] {
        let replay = store.apply_runner_event(replay).await.unwrap();
        assert!(replay.event.is_none());
        assert!(replay.related_events.is_empty());
        assert!(replay.breaker_commands.is_empty());
    }
    let used: i64 = sqlx::query_scalar("SELECT sum(input_tokens)::bigint FROM runs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(used, 100);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_pending_review_waits_for_atomic_fanout_and_then_rejects(pool: PgPool) {
    let store = fixture(pool).await;
    pending_review(&store, 1).await;
    sqlx::raw_sql(
        "CREATE FUNCTION hold_breaker56() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock(560056::bigint); RETURN NEW; END $$;
            CREATE TRIGGER hold_breaker56 BEFORE INSERT ON runner_commands
            FOR EACH ROW EXECUTE FUNCTION hold_breaker56();",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let mut barrier = store.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(560056::bigint)")
        .execute(&mut *barrier)
        .await
        .unwrap();
    let writer = store.clone();
    let usage = tokio::spawn(async move {
        writer
            .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_locks lock
                     JOIN pg_stat_activity activity ON activity.pid=lock.pid
                     WHERE activity.datname=current_database() AND lock.objid=560056
                       AND lock.locktype='advisory' AND NOT lock.granted)",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("usage must reach the command barrier within three seconds");
    assert_eq!(
        stage(&store, 0).await,
        "healthy",
        "partial fanout must be invisible"
    );
    let reader = store.clone();
    let mut decision = tokio::spawn(async move {
        reader
            .decide_verification(CORP, run_id(1), OWNER, true, "", Some(Uuid::new_v4()))
            .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut decision)
            .await
            .is_err()
    );
    barrier.commit().await.unwrap();
    assert_eq!(usage.await.unwrap().unwrap().breaker_commands.len(), 2);
    assert!(
        decision
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("breaker")
    );
    assert_eq!(stage(&store, 1).await, "suspend");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_already_queued_approval_becomes_obsolete(pool: PgPool) {
    let store = fixture(pool).await;
    let approval = pending_approval(&store, 1).await;
    store
        .decide_action_approval(CORP, approval, OWNER, true, "", Uuid::new_v4())
        .await
        .unwrap();
    let queued = store
        .pending_runner_commands("issue56-runner-1")
        .await
        .unwrap();
    let command = queued
        .iter()
        .find(|command| command.command_kind == "approval_decision")
        .unwrap();
    assert_eq!(
        store.runner_command_dispatch_state(command).await.unwrap(),
        RunnerCommandDispatchState::Pending
    );
    store
        .apply_runner_event(event(0, "run.usage", json!({"input_tokens":100})))
        .await
        .unwrap();
    assert_eq!(
        store.runner_command_dispatch_state(command).await.unwrap(),
        RunnerCommandDispatchState::Obsolete
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue56_all_active_states_but_no_terminal_or_unproven_verifier_exemption(pool: PgPool) {
    let store = fixture(pool).await;
    let statuses = [
        "provisioning",
        "starting",
        "running",
        "waiting_for_input",
        "waiting_for_approval",
        "verifying",
        "completed",
        "failed",
        "cancelled",
        "lost",
    ];
    for (index, status) in statuses.iter().enumerate() {
        let index = index as u128;
        if index >= 2 {
            add_run(&store, index, CORP, MISSION).await;
        }
        sqlx::query("UPDATE runs SET status=$1 WHERE id=$2")
            .bind(status)
            .bind(run_id(index))
            .execute(&store.pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "UPDATE runs SET execution_mode='verification_only',
        budget_tokens_limit=0,budget_cost_microusd_limit=0 WHERE id=$1",
    )
    .bind(run_id(5))
    .execute(&store.pool)
    .await
    .unwrap();
    let outcome = store
        .apply_runner_event(event(0, "run.usage", json!({"input_tokens":110})))
        .await
        .unwrap();
    assert_eq!(outcome.breaker_commands.len(), 6);
    for index in 0..10 {
        assert_eq!(
            stage(&store, index).await,
            if index < 6 { "stop" } else { "healthy" }
        );
    }
}
