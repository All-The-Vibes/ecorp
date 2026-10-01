use super::*;
use crate::aggregate_breaker_tests::{CORP, fixture, run_id};
use crate::control_accounting_tests::wait_for_database_blocker;

async fn command(store: &PgStore, stage: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO runner_commands(id,corp_id,runner_id,run_id,command_kind,payload,idempotency_key)
         VALUES($1,$2,'issue56-runner-0',$3,'circuit_breaker',$4,$5)",
    ).bind(id).bind(CORP).bind(run_id(0))
    .bind(json!({"stage":stage,"reason":"retrospective receipt fixture"}))
    .bind(format!("issue87-command:{id}")).execute(&store.pool).await.unwrap();
    id
}

async fn receipt(store: &PgStore, index: u128) -> RunnerCommandReceipt {
    let epoch = sqlx::query_scalar("SELECT connection_epoch FROM runner_nodes WHERE id=$1")
        .bind(format!("issue56-runner-{index}"))
        .fetch_one(&store.pool)
        .await
        .unwrap();
    RunnerCommandReceipt {
        corp_id: CORP,
        connection_epoch: epoch,
        runner_received_at: Some("2026-10-01T00:00:00Z".into()),
    }
}

async fn status(store: &PgStore, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM runner_commands WHERE id=$1")
        .bind(id)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_acknowledgments_persist_all_control_stages_and_distinct_clocks(pool: PgPool) {
    let store = fixture(pool).await;
    for stage in ["constrain", "suspend", "stop"] {
        let id = command(&store, stage).await;
        let received = receipt(&store, 0).await;
        let acknowledged = store
            .acknowledge_runner_command_with_receipt(
                id,
                "issue56-runner-0",
                "  control accepted\nfor delivery  ",
                Some(received.clone()),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(acknowledged.event_type, "runner.command_acknowledged");
        assert_eq!(acknowledged.payload["stage"], stage);
        let details = &acknowledged.payload["receipt"];
        assert_eq!(details["detail"], "control accepted for delivery");
        assert_eq!(
            details["connection_epoch"],
            json!(received.connection_epoch)
        );
        assert_eq!(details["runner_received_at"], "2026-10-01T00:00:00Z");
        assert_eq!(details["runner_timestamp_valid"], true);
        assert_eq!(details["provider_termination_confirmed"], false);
        let stored: chrono::DateTime<Utc> =
            sqlx::query_scalar("SELECT dispatched_at FROM runner_commands WHERE id=$1")
                .bind(id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(details["server_acknowledged_at"], json!(stored));
        assert_eq!(status(&store, id).await, "dispatched");
        assert!(
            store
                .acknowledge_runner_command_with_receipt(
                    id,
                    "issue56-runner-0",
                    "duplicate must not replace receipt",
                    Some(received),
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .fail_runner_command(id, "issue56-runner-0", "late failure")
                .await
                .unwrap()
                .is_none()
        );
    }
    let legacy = command(&store, "stop").await;
    let legacy = store
        .acknowledge_runner_command(legacy, "issue56-runner-0")
        .await
        .unwrap()
        .unwrap();
    assert!(legacy.payload["receipt"]["runner_received_at"].is_null());
    assert_eq!(
        legacy.payload["receipt"]["provider_termination_confirmed"],
        false
    );
    let failure = command(&store, "stop").await;
    let mut invalid_time = receipt(&store, 0).await;
    invalid_time.runner_received_at = Some("invalid runner clock".into());
    let failed = store
        .fail_runner_command_with_receipt(
            failure,
            "issue56-runner-0",
            &"é".repeat(1001),
            Some(invalid_time),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.payload["stage"], "stop");
    assert_eq!(failed.payload["receipt"]["runner_timestamp_valid"], false);
    assert!(failed.payload["receipt"]["runner_received_at"].is_null());
    assert!(failed.payload["detail"].as_str().unwrap().len() <= 1000);
    assert_eq!(status(&store, failure).await, "failed");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_receipts_reject_foreign_runner_corp_and_stale_connection(pool: PgPool) {
    let store = fixture(pool).await;
    let id = command(&store, "stop").await;
    let valid = receipt(&store, 0).await;
    for field in ["corp", "epoch"] {
        let mut invalid = valid.clone();
        if field == "corp" {
            invalid.corp_id = Uuid::new_v4();
        } else {
            invalid.connection_epoch = Uuid::new_v4();
        }
        assert!(
            store
                .acknowledge_runner_command_with_receipt(
                    id,
                    "issue56-runner-0",
                    "spoof",
                    Some(invalid.clone()),
                )
                .await
                .is_err()
        );
        assert!(
            store
                .fail_runner_command_with_receipt(id, "issue56-runner-0", "spoof", Some(invalid),)
                .await
                .is_err()
        );
    }
    let other_runner = receipt(&store, 1).await;
    assert!(
        store
            .acknowledge_runner_command_with_receipt(
                id,
                "issue56-runner-1",
                "foreign runner",
                Some(other_runner.clone()),
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .fail_runner_command_with_receipt(
                id,
                "issue56-runner-1",
                "foreign runner",
                Some(other_runner),
            )
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE runner_nodes SET connection_epoch=$1 WHERE id='issue56-runner-0'")
        .bind(Uuid::new_v4())
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .acknowledge_runner_command_with_receipt(
                id,
                "issue56-runner-0",
                "old socket",
                Some(valid),
            )
            .await
            .is_err()
    );
    assert_eq!(status(&store, id).await, "pending");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE corp_id=$1")
        .bind(CORP)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_reconnect_winning_the_database_lock_rejects_the_old_ack(pool: PgPool) {
    let store = fixture(pool).await;
    let id = command(&store, "stop").await;
    let old = receipt(&store, 0).await;
    let mut barrier = store.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("UPDATE runner_nodes SET connection_epoch=$1 WHERE id='issue56-runner-0'")
        .bind(Uuid::new_v4())
        .execute(&mut *barrier)
        .await
        .unwrap();
    let waiting = store.clone();
    let ack = tokio::spawn(async move {
        waiting
            .acknowledge_runner_command_with_receipt(
                id,
                "issue56-runner-0",
                "old socket",
                Some(old),
            )
            .await
    });
    wait_for_database_blocker(&store, blocker).await;
    barrier.commit().await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), ack)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(status(&store, id).await, "pending");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires an explicitly owned disposable PostgreSQL database"]
async fn issue87_socket_send_is_scoped_and_distinct_from_receipt_after_reconnect(pool: PgPool) {
    let store = fixture(pool).await;
    let command_id = command(&store, "suspend").await;
    let original = RunnerCommandSocketSend {
        corp_id: CORP,
        runner_id: "issue56-runner-0".into(),
        connection_epoch: receipt(&store, 0).await.connection_epoch,
        command_id,
        run_id: run_id(0),
        sent_at: Utc::now(),
    };
    for field in ["corp", "run", "runner", "command"] {
        let mut invalid = original.clone();
        match field {
            "corp" => invalid.corp_id = Uuid::new_v4(),
            "run" => invalid.run_id = run_id(1),
            "runner" => invalid.runner_id = "issue56-runner-1".into(),
            _ => invalid.command_id = Uuid::new_v4(),
        }
        assert!(
            store
                .record_runner_command_socket_send(invalid)
                .await
                .is_err(),
            "{field}"
        );
    }
    // The server captured the authenticated old epoch when it actually sent.
    // Persistence can lag behind a reconnect without becoming a new-epoch send.
    let new_epoch = Uuid::new_v4();
    sqlx::query("UPDATE runner_nodes SET connection_epoch=$1 WHERE id='issue56-runner-0'")
        .bind(new_epoch)
        .execute(&store.pool)
        .await
        .unwrap();
    let first = store
        .record_runner_command_socket_send(original.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.event_type, "runner.command_socket_sent");
    assert_eq!(
        first.payload["connection_epoch"],
        json!(original.connection_epoch)
    );
    assert_eq!(first.payload["socket_sent_at"], json!(original.sent_at));
    assert_eq!(first.payload["stage"], "suspend");
    assert_eq!(first.payload["runner_receipt_confirmed"], false);
    assert_eq!(status(&store, command_id).await, "pending");
    assert!(
        store
            .record_runner_command_socket_send(original.clone())
            .await
            .unwrap()
            .is_none()
    );
    let resend = RunnerCommandSocketSend {
        connection_epoch: new_epoch,
        ..original
    };
    let second = store
        .record_runner_command_socket_send(resend)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.payload["connection_epoch"], json!(new_epoch));
    assert_ne!(first.idempotency_key, second.idempotency_key);
    assert_eq!(status(&store, command_id).await, "pending");
}
