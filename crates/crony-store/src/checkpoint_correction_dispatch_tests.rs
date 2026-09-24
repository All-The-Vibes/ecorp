//! Source-correction dispatch uses a real competing accounting transaction.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;

async fn sibling_usage(store: &PgStore) -> RunnerEventInput {
    let index = 42;
    crate::aggregate_breaker_tests::add_run(store, index, CORP, MISSION).await;
    let run = crate::aggregate_breaker_tests::run_id(index);
    let runner_id = format!("issue56-runner-{index}");
    let connection_epoch =
        sqlx::query_scalar("SELECT connection_epoch FROM runner_nodes WHERE id=$1")
            .bind(&runner_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    RunnerEventInput {
        event_id: Uuid::new_v4(),
        runner_id,
        corp_id: CORP,
        connection_epoch,
        run_id: run,
        agent_id: Uuid::from_u128(run.as_u128() + 1),
        assignment_token: run,
        event_type: "run.usage".to_owned(),
        payload: json!({"input_tokens":4_700,"output_tokens":0,"cost_microusd":0}),
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_source_correction_holds_authority_inside_enqueue(pool: PgPool) {
    let (store, _, command) = admitted_correction(pool).await;
    let usage = sibling_usage(&store).await;
    assert_correction_dispatch(&store, &command, true).await;
    let dispatch_pool = correction_single_connection_pool(&store.pool).await;
    let dispatch_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&dispatch_pool)
        .await
        .unwrap();
    let dispatcher = PgStore {
        pool: dispatch_pool,
    };
    let options = store.pool.connect_options().as_ref().clone();
    let enqueued = Arc::new(AtomicBool::new(false));
    let observed_enqueue = enqueued.clone();
    let (observed_tx, observed_rx) = mpsc::channel();
    let mut worker = None;
    let outcome = dispatcher.with_source_correction_command_dispatch(&command, || {
        // A separate runtime keeps actual accounting and lock observation moving
        // while the production callback synchronously enqueues on this thread.
        worker = Some(std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let accounting_pool = sqlx::postgres::PgPoolOptions::new().max_connections(1)
                    .connect_with(options.clone()).await.unwrap();
                let observer_pool = sqlx::postgres::PgPoolOptions::new().max_connections(1)
                    .connect_with(options).await.unwrap();
                sqlx::query("SET statement_timeout='15s'").execute(&accounting_pool).await.unwrap();
                let accounting_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                    .fetch_one(&accounting_pool).await.unwrap();
                let accounting = PgStore { pool: accounting_pool };
                let mut apply = Box::pin(accounting.apply_runner_event(usage));
                let observed = tokio::select! {
                    result = &mut apply => {
                        let _ = observed_tx.send(false);
                        return (result, false);
                    }
                    observed = correction_wait_observed(&observer_pool, accounting_pid, dispatch_pid, true) => observed.unwrap(),
                };
                let _ = observed_tx.send(observed);
                let result = apply.await;
                (result, observed_enqueue.load(Ordering::SeqCst))
            })
        }));
        let held = observed_rx.recv_timeout(Duration::from_secs(10))
            .context("accounting observation did not finish inside enqueue")?;
        if !held {
            return Err(anyhow!("sibling accounting committed before the source-correction enqueue"));
        }
        enqueued.store(true, Ordering::SeqCst);
        Ok(true)
    }).await;
    // Join after the dispatch transaction commits/rolls back, including RED.
    let (accounting, enqueue_preceded_fence) = worker
        .expect("enqueue callback reached")
        .join()
        .expect("owned accounting worker");
    assert_eq!(outcome.unwrap(), RunnerCommandDispatchOutcome::Sent);
    assert!(enqueue_preceded_fence);
    assert!(!accounting.unwrap().breaker_commands.is_empty());
    assert_eq!(
        store
            .with_source_correction_command_dispatch(&command, || panic!("fenced replay"))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Obsolete
    );
    let status: String = sqlx::query_scalar("SELECT status FROM runner_commands WHERE id=$1")
        .bind(command.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(status, "pending", "enqueue does not fabricate a runner ACK");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_source_correction_fence_wins_before_enqueue(pool: PgPool) {
    let (store, _, command) = admitted_correction(pool).await;
    let usage = sibling_usage(&store).await;
    assert_correction_dispatch(&store, &command, true).await;
    assert!(
        !store
            .apply_runner_event(usage)
            .await
            .unwrap()
            .breaker_commands
            .is_empty()
    );
    assert_eq!(
        store
            .with_source_correction_command_dispatch(&command, || panic!("stale provider enqueue"))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Obsolete
    );
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue56_source_correction_disconnect_preserves_durable_retry(pool: PgPool) {
    let (store, _, command) = admitted_correction(pool).await;
    let before = correction_state(&store).await;
    assert_eq!(
        store
            .with_source_correction_command_dispatch(&command, || Ok(false))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Disconnected
    );
    assert_eq!(correction_state(&store).await, before);
    assert_eq!(
        store
            .with_source_correction_command_dispatch(&command, || Ok(true))
            .await
            .unwrap(),
        RunnerCommandDispatchOutcome::Sent
    );
    assert_eq!(correction_state(&store).await, before);
}
