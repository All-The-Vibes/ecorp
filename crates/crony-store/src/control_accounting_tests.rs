//! Retrospective regressions with an explicitly owned native PostgreSQL fixture.
use super::*;
use crate::aggregate_breaker_tests::{CORP, MISSION, OWNER, artifact, event, fixture, run_id};

async fn boundary(store: &PgStore, index: u128, stage: &str, age_seconds: i64) {
    // Only this disposable fixture backdates incidents to avoid sleeping in every
    // case. The lock-wait regression below also exercises a real elapsed grace.
    sqlx::query("UPDATE runs SET breaker_stage=$1 WHERE id=$2 AND corp_id=$3")
        .bind(stage)
        .bind(run_id(index))
        .bind(CORP)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO circuit_breaker_incidents
         (id,corp_id,mission_id,task_id,run_id,stage,reason,input,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'retrospective test boundary','{}',
                clock_timestamp()-$7::bigint*interval '1 second')",
    )
    .bind(Uuid::new_v4())
    .bind(CORP)
    .bind(MISSION)
    .bind(Uuid::from_u128(run_id(index).as_u128() + 3))
    .bind(run_id(index))
    .bind(stage)
    .bind(age_seconds)
    .execute(&store.pool)
    .await
    .unwrap();
}

async fn counters(store: &PgStore, index: u128) -> (i64, i64, i64) {
    sqlx::query_as("SELECT input_tokens,output_tokens,cost_microusd FROM runs WHERE id=$1")
        .bind(run_id(index))
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

fn usage(index: u128) -> RunnerEventInput {
    event(
        index,
        "run.usage",
        json!({
            "input_tokens":5, "output_tokens":3, "cost_microusd":7,
            "accounting":{"charged":true,"cutoff_at":"2099-01-01T00:00:00Z"}
        }),
    )
}

pub(super) async fn wait_for_database_blocker(store: &PgStore, blocker: i32) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the native transaction must demonstrably wait on the held lock");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_hard_control_grace_preserves_reports_without_late_charges(pool: PgPool) {
    let store = fixture(pool).await;
    boundary(&store, 0, "suspend", 0).await;
    boundary(&store, 1, "stop", 6).await;
    let within = store
        .apply_runner_event(usage(0))
        .await
        .unwrap()
        .event
        .unwrap();
    assert_eq!(within.event_type, "run.usage");
    assert_eq!(within.payload["accounting"]["charged"], true);
    assert_eq!(within.payload["accounting"]["grace_seconds"], 5);
    assert_eq!(within.payload["accounting"]["generation_time_known"], false);
    assert_eq!(counters(&store, 0).await, (5, 3, 7));
    let late = store.apply_runner_event(usage(1)).await.unwrap();
    assert!(late.breaker_commands.is_empty());
    let late = late.event.unwrap();
    assert_eq!(late.event_type, "run.usage_observed");
    assert_eq!(late.payload["input_tokens"], 5);
    assert_eq!(late.payload["accounting"]["charged"], false);
    assert_eq!(
        late.payload["accounting"]["reason"],
        "hard_control_grace_expired"
    );
    assert_eq!(counters(&store, 1).await, (0, 0, 0));
    let accounting = &late.payload["accounting"];
    let at = |name: &str| {
        chrono::DateTime::parse_from_rfc3339(accounting[name].as_str().unwrap()).unwrap()
    };
    assert_eq!(
        at("cutoff_at") - at("hard_boundary_at"),
        Duration::seconds(5)
    );
    assert!(at("admitted_at") >= at("cutoff_at"));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_suspend_to_stop_preserves_the_first_cutoff(pool: PgPool) {
    let store = fixture(pool).await;
    boundary(&store, 0, "suspend", 6).await;
    boundary(&store, 0, "stop", 0).await;
    let observed = store
        .apply_runner_event(usage(0))
        .await
        .unwrap()
        .event
        .unwrap();
    assert_eq!(observed.event_type, "run.usage_observed");
    let first: chrono::DateTime<Utc> = sqlx::query_scalar(
        "SELECT created_at FROM circuit_breaker_incidents WHERE run_id=$1 AND stage='suspend'",
    )
    .bind(run_id(0))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        observed.payload["accounting"]["hard_boundary_at"],
        json!(first)
    );
    assert_eq!(counters(&store, 0).await, (0, 0, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_usage_replays_remain_idempotent_across_the_cutoff(pool: PgPool) {
    let store = fixture(pool).await;
    let first = usage(0);
    assert!(
        store
            .apply_runner_event(first.clone())
            .await
            .unwrap()
            .event
            .is_some()
    );
    boundary(&store, 0, "stop", 6).await;
    assert!(
        store
            .apply_runner_event(first)
            .await
            .unwrap()
            .event
            .is_none()
    );
    let late = usage(0);
    assert_eq!(
        store
            .apply_runner_event(late.clone())
            .await
            .unwrap()
            .event
            .unwrap()
            .event_type,
        "run.usage_observed"
    );
    assert!(
        store
            .apply_runner_event(late)
            .await
            .unwrap()
            .event
            .is_none()
    );
    assert_eq!(counters(&store, 0).await, (5, 3, 7));
    let types: Vec<(String, i64)> = sqlx::query_as(
        "SELECT type,count(*) FROM events WHERE aggregate_id=$1 GROUP BY type ORDER BY type",
    )
    .bind(run_id(0))
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        types,
        vec![("run.usage".into(), 1), ("run.usage_observed".into(), 1)]
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_terminal_and_unverifiable_hard_states_cannot_reopen_charging(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runs SET breaker_stage='stop' WHERE id=$1")
        .bind(run_id(0))
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE runs SET status='cancelled' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    for (index, reason) in [(0, "hard_boundary_time_unavailable"), (1, "run_terminal")] {
        let observed = store
            .apply_runner_event(usage(index))
            .await
            .unwrap()
            .event
            .unwrap();
        assert_eq!(observed.event_type, "run.usage_observed");
        assert_eq!(observed.payload["accounting"]["reason"], reason);
        assert_eq!(counters(&store, index).await, (0, 0, 0));
    }
    sqlx::query("UPDATE runs SET execution_mode='verification_only' WHERE id=$1")
        .bind(run_id(1))
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .apply_runner_event(usage(1))
            .await
            .unwrap_err()
            .to_string()
            .contains("provider-free verification")
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_accounting_reads_database_time_after_an_observed_lock_wait(pool: PgPool) {
    let store = fixture(pool).await;
    boundary(&store, 0, "suspend", 0).await;
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    aggregate_breaker::lock_corp_tx(&mut barrier, CORP)
        .await
        .unwrap();
    let other = store.clone();
    let delayed = tokio::spawn(async move { other.apply_runner_event(usage(0)).await });
    wait_for_database_blocker(&store, blocker).await;
    // The usage transaction has already started and is blocked. Its transaction
    // timestamp will be before the cutoff; clock_timestamp after admission must not be.
    sqlx::query("SELECT pg_sleep(5.2)")
        .execute(&mut *barrier)
        .await
        .unwrap();
    barrier.commit().await.unwrap();
    let observed = tokio::time::timeout(std::time::Duration::from_secs(5), delayed)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .event
        .unwrap();
    assert_eq!(observed.event_type, "run.usage_observed");
    assert_eq!(
        observed.payload["accounting"]["reason"],
        "hard_control_grace_expired"
    );
    assert_eq!(counters(&store, 0).await, (0, 0, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_operator_stop_uses_transition_time_after_lock_wait(pool: PgPool) {
    let store = fixture(pool).await;
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    aggregate_breaker::lock_corp_tx(&mut barrier, CORP)
        .await
        .unwrap();
    let other = store.clone();
    let delayed = tokio::spawn(async move {
        let agent = Uuid::from_u128(run_id(0).as_u128() + 1);
        other
            .request_emergency_stop(CORP, agent, OWNER, "stop after lock wait")
            .await
    });
    wait_for_database_blocker(&store, blocker).await;
    // This stop transaction began before the lock wait; its authoritative
    // transition happens only after that wait. No backdated fixture timestamps.
    sqlx::query("SELECT pg_sleep(5.2)")
        .execute(&mut *barrier)
        .await
        .unwrap();
    barrier.commit().await.unwrap();
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), delayed)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(stopped.event.payload["command_id"].is_string());
    let transition: chrono::DateTime<Utc> = sqlx::query_scalar(
        "SELECT created_at FROM circuit_breaker_incidents WHERE corp_id=$1 AND run_id=$2 AND stage='stop'"
    ).bind(CORP).bind(run_id(0)).fetch_one(&store.pool).await.unwrap();
    let observed = store
        .apply_runner_event(usage(0))
        .await
        .unwrap()
        .event
        .unwrap();
    assert_eq!(
        observed.event_type, "run.usage",
        "the grace starts at the actual transition"
    );
    assert_eq!(
        observed.payload["accounting"]["hard_boundary_at"],
        json!(transition)
    );
    assert_eq!(counters(&store, 0).await, (5, 3, 7));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_observations_preserve_scope_and_cannot_spoof_server_authority(pool: PgPool) {
    let store = fixture(pool).await;
    let foreign_corp = Uuid::from_u128(8700);
    sqlx::query("INSERT INTO corps(id,slug,name) VALUES($1,'foreign87','Foreign Corp')")
        .bind(foreign_corp)
        .execute(&store.pool)
        .await
        .unwrap();
    let observation = || {
        event(
            0,
            "run.control_observed",
            json!({
                "phase":"usage_observed", "observed_at":"2099-01-01T00:00:00Z", "detail":{},
                "clock_authority":"authoritative", "server_recorded_at":"2099-01-01T00:00:00Z"
            }),
        )
    };
    for original in [usage(0), observation()] {
        for field in ["corp", "runner", "agent", "run", "token"] {
            let mut invalid = original.clone();
            match field {
                "corp" => invalid.corp_id = foreign_corp,
                "runner" => invalid.runner_id = "issue56-runner-1".into(),
                "agent" => invalid.agent_id = Uuid::from_u128(run_id(1).as_u128() + 1),
                "run" => invalid.run_id = run_id(1),
                _ => invalid.assignment_token = run_id(1),
            }
            assert!(store.apply_runner_event(invalid).await.is_err(), "{field}");
        }
    }
    for kind in [
        "run.usage_observed",
        "run.stop_requested",
        "run.breaker_transition",
        "runner.command_socket_sent",
        "runner.command_acknowledged",
        "runner.command_failed",
    ] {
        assert!(
            store
                .apply_runner_event(event(0, kind, json!({})))
                .await
                .unwrap_err()
                .to_string()
                .contains("server-owned")
        );
    }
    for payload in [
        json!({"phase":"unknown","observed_at":Utc::now()}),
        json!({"phase":"process_terminated","observed_at":"invalid"}),
        json!({"phase":"process_terminated","observed_at":Utc::now(),"detail":"x".repeat(16384)}),
    ] {
        assert!(
            store
                .apply_runner_event(event(0, "run.control_observed", payload))
                .await
                .is_err()
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE corp_id=$1")
        .bind(CORP)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("UPDATE runs SET status='cancelled' WHERE id=$1")
        .bind(run_id(0))
        .execute(&store.pool)
        .await
        .unwrap();
    let saved = store
        .apply_runner_event(observation())
        .await
        .unwrap()
        .event
        .unwrap();
    assert_eq!(saved.payload["clock_authority"], "runner_observation_only");
    assert_ne!(
        saved.payload["server_recorded_at"],
        saved.payload["observed_at"]
    );
    assert_eq!(counters(&store, 0).await, (0, 0, 0));
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_historical_operator_stop_fences_artifacts_and_completion(pool: PgPool) {
    let store = fixture(pool).await;
    let upload = event(0, "run.artifact_upload", json!({}));
    let staged = artifact(0, &upload);
    store
        .prepare_artifact_upload(
            upload,
            staged.clone(),
            &format!("staging/corps/{CORP}/{}", staged.id),
        )
        .await
        .unwrap();
    let mut tx = store.pool.begin().await.unwrap();
    append_event_tx(
        &mut tx,
        NewEvent::new(
            CORP,
            Some(OWNER),
            "run.stop_requested",
            "run",
            run_id(0),
            "issue87-historical-stop",
            json!({"reason":"pre-durable-command stop"}),
        ),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for kind in [
        "run.completed",
        "run.verification_started",
        "run.verification_passed",
    ] {
        assert!(
            store
                .apply_runner_event(event(0, kind, json!({})))
                .await
                .unwrap_err()
                .to_string()
                .contains("authoritative stop request"),
            "{kind}"
        );
    }
    assert!(
        store
            .finalize_artifact_upload(CORP, staged.id)
            .await
            .is_err()
    );
    let upload = event(0, "run.artifact_upload", json!({}));
    let fresh = artifact(0, &upload);
    assert!(
        store
            .prepare_artifact_upload(
                upload,
                fresh.clone(),
                &format!("staging/corps/{CORP}/{}", fresh.id)
            )
            .await
            .is_err()
    );
    let accepted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE aggregate_id=$1
         AND type IN ('run.completed','run.artifact','run.verification_passed')",
    )
    .bind(run_id(0))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(accepted, 0);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_emergency_stop_is_durable_offline_and_reuses_its_first_command(pool: PgPool) {
    let store = fixture(pool).await;
    sqlx::query("UPDATE runner_nodes SET status='grace' WHERE id='issue56-runner-0'")
        .execute(&store.pool)
        .await
        .unwrap();
    let agent = Uuid::from_u128(run_id(0).as_u128() + 1);
    let first = store
        .request_emergency_stop(CORP, agent, OWNER, "operator stop")
        .await
        .unwrap();
    let first_id = first.event.payload["command_id"].clone();
    let first_at: chrono::DateTime<Utc> = sqlx::query_scalar(
        "SELECT created_at FROM circuit_breaker_incidents WHERE run_id=$1 AND stage='stop'",
    )
    .bind(run_id(0))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    let second = store
        .request_emergency_stop(CORP, agent, OWNER, "repeated stop")
        .await
        .unwrap();
    assert_eq!(first_id, second.event.payload["command_id"]);
    let commands = store
        .pending_runner_commands("issue56-runner-0")
        .await
        .unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(json!(commands[0].id), first_id);
    assert_eq!(commands[0].payload["stage"], "stop");
    let state: (String, chrono::DateTime<Utc>, i64) = sqlx::query_as(
        "SELECT r.breaker_stage,i.created_at,
         (SELECT count(*) FROM circuit_breaker_incidents WHERE run_id=r.id)
         FROM runs r JOIN circuit_breaker_incidents i ON i.run_id=r.id WHERE r.id=$1",
    )
    .bind(run_id(0))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(state, ("stop".into(), first_at, 1));
    assert!(
        store
            .apply_runner_event(event(0, "run.completed", json!({})))
            .await
            .is_err()
    );
    // A denied request cannot target another run, and retrying does not revive
    // a command that the runner explicitly failed.
    assert!(
        store
            .request_emergency_stop(
                CORP,
                agent,
                Uuid::from_u128(run_id(1).as_u128() + 2),
                "unauthorized stop"
            )
            .await
            .is_err()
    );
    store
        .fail_runner_command(commands[0].id, "issue56-runner-0", "inactive run")
        .await
        .unwrap();
    store
        .request_emergency_stop(CORP, agent, OWNER, "repeat after failure")
        .await
        .unwrap();
    assert!(
        store
            .pending_runner_commands("issue56-runner-0")
            .await
            .unwrap()
            .is_empty()
    );
}
