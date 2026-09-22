//! Actual-migration metadata regressions; native process/bytes/browser evidence
//! is provided separately by tools/e2e_factory_run_activity.py.
use super::*;

const CORP: Uuid = Uuid::from_u128(1);
const OWNER: Uuid = Uuid::from_u128(2);
const ROOM: Uuid = Uuid::from_u128(3);
const AGENT: Uuid = Uuid::from_u128(4);
const MISSION: Uuid = Uuid::from_u128(5);
const TASK: Uuid = Uuid::from_u128(6);
const RUN: Uuid = Uuid::from_u128(7);
const REVIEWER: Uuid = Uuid::from_u128(9);
const EPOCH: Uuid = Uuid::from_u128(10);
const RUNNER: &str = "issue265-review-runner";

async fn fixture(pool: PgPool) -> PgStore {
    sqlx::raw_sql(
        r#"
        INSERT INTO corps(id,slug,name) VALUES
          ('00000000-0000-0000-0000-000000000001','issue265','Finished review fixture'),
          ('00000000-0000-0000-0000-000000000011','other','Foreign fixture');
        INSERT INTO actors(id,corp_id,name,kind,role) VALUES
          ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Owner','human','owner'),
          ('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000001','Worker','agent','worker'),
          ('00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-000000000001','Reviewer','human','member');
        INSERT INTO rooms(id,corp_id,name,purpose) VALUES
          ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','QA','Finished review');
        INSERT INTO room_memberships(room_id,actor_id) VALUES
          ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002'),
          ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000009');
        INSERT INTO agents(id,corp_id,actor_id,name,role,adapter,status,current_run_id,accent) VALUES
          ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000008','Worker','worker','fake-process','reviewing',
           '00000000-0000-0000-0000-000000000007','#123456');
        INSERT INTO missions(id,corp_id,room_id,requested_by,title,status,budget_tokens,
                             original_budget_tokens,original_budget_cost_microusd) VALUES
          ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',
           'Finished review','running',100000,100000,1000000);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let gate =
        json!({"type":"independent_review","roles":["owner","member"],"exclude_requester":true});
    let policy =
        json!({"checks":[{"type":"file","path":"result.md","min_bytes":1}],"manual_gate":gate});
    sqlx::query(
        "INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,assigned_agent_id,
                           plan_key,contract,verification_policy,verification_status,attempt_count,max_attempts)
         VALUES($1,$2,$3,'Delivery','result.md','awaiting_approval',$4,'delivery','{}',$5,'waiting_for_approval',1,2)",
    )
    .bind(TASK).bind(CORP).bind(MISSION).bind(AGENT).bind(&policy)
    .execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO runs(id,corp_id,task_id,agent_id,runner_id,assignment_token,status,
                          execution_mode,verification_status,workspace_disposition,workspace_fingerprint,workspace_run_id,
                          input_tokens,output_tokens,cost_microusd,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'waiting_for_approval','provider','waiting_for_approval',
                'preserved',$7,$1,11,13,17,now()-interval '1 minute')",
    )
    .bind(RUN).bind(CORP).bind(TASK).bind(AGENT).bind(RUNNER).bind(Uuid::new_v4())
    .bind("b".repeat(64)).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO verification_requests(run_id,corp_id,task_id,gate_type,gate,status)
                 VALUES($1,$2,$3,'independent_review',$4,'pending')",
    )
    .bind(RUN)
    .bind(CORP)
    .bind(TASK)
    .bind(gate)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    append_event_tx(
        &mut tx,
        NewEvent {
            room_id: Some(ROOM),
            correlation_id: Some(MISSION),
            ..NewEvent::new(
                CORP,
                None,
                "run.session_terminated",
                "run",
                RUN,
                "terminated".to_owned(),
                json!({"provider_process_alive":false}),
            )
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let store = PgStore { pool };
    store
        .runner_connected(RunnerConnectInput {
            id: RUNNER.to_owned(),
            corp_id: CORP,
            hostname: "fixture".to_owned(),
            os: "windows".to_owned(),
            capabilities: json!({}),
            connection_epoch: EPOCH,
        })
        .await
        .unwrap();
    store
}

async fn state(store: &PgStore) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
          'run',(SELECT to_jsonb(r) FROM runs r WHERE id=$1),
          'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$2),
          'mission',(SELECT to_jsonb(m) FROM missions m WHERE id=$3),
          'request',(SELECT to_jsonb(v) FROM verification_requests v WHERE run_id=$1),
          'agent',(SELECT to_jsonb(a) FROM agents a WHERE id=$4))",
    )
    .bind(RUN)
    .bind(TASK)
    .bind(MISSION)
    .bind(AGENT)
    .fetch_one(&store.pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue265_finished_review_survives_reconnect_and_keeps_independent_decision(pool: PgPool) {
    let store = fixture(pool).await;
    let before = state(&store).await;
    for _ in 0..2 {
        assert!(
            store
                .mark_unclaimed_runner_runs_lost(RUNNER, EPOCH, &[])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(state(&store).await, before);
    }
    assert!(
        store
            .decide_verification(CORP, RUN, OWNER, true, "not independent", None)
            .await
            .is_err()
    );
    assert_eq!(state(&store).await, before);
    store
        .decide_verification(CORP, RUN, REVIEWER, true, "independent review", None)
        .await
        .unwrap();
    let after = state(&store).await;
    assert_eq!(after["run"]["status"], "completed");
    assert_eq!(after["request"]["decided_by"], REVIEWER.to_string());
    for field in [
        "input_tokens",
        "output_tokens",
        "cost_microusd",
        "workspace_fingerprint",
        "workspace_disposition",
    ] {
        assert_eq!(after["run"][field], before["run"][field]);
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue265_finished_review_survives_grace_expiry_with_epoch_fencing(pool: PgPool) {
    let store = fixture(pool).await;
    let before = state(&store).await;
    store.runner_disconnected(RUNNER, EPOCH, 1).await.unwrap();
    sqlx::query("UPDATE runner_nodes SET grace_expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(RUNNER)
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .expire_runner_grace(RUNNER, Uuid::new_v4())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(state(&store).await, before);
    assert!(
        store
            .expire_runner_grace(RUNNER, EPOCH)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(state(&store).await, before);
    let status: String = sqlx::query_scalar("SELECT status FROM runner_nodes WHERE id=$1")
        .bind(RUNNER)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(status, "offline");
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue265_incomplete_or_unsafe_review_still_follows_native_loss(pool: PgPool) {
    let store = fixture(pool).await;
    let cases = [
        "DELETE FROM verification_requests",
        "UPDATE verification_requests SET status='rejected'",
        "UPDATE verification_requests SET corp_id='00000000-0000-0000-0000-000000000011'",
        "UPDATE verification_requests SET gate=gate || '{\"exclude_requester\":false}'",
        "UPDATE runs SET verification_status='pending'",
        "UPDATE tasks SET verification_status='pending'",
        "UPDATE tasks SET status='running'",
        "UPDATE missions SET status='failed'",
        "UPDATE runs SET execution_mode='verification_only'",
        "UPDATE runs SET workspace_disposition='quarantined'",
        "UPDATE runs SET breaker_stage='stop'",
        "UPDATE runs SET breaker_stage='suspend'",
        "DELETE FROM events WHERE type='run.session_terminated'",
        "UPDATE events SET payload='{\"provider_process_alive\":true}' WHERE type='run.session_terminated'",
        "UPDATE events SET payload='{\"provider_process_alive\":\"false\"}' WHERE type='run.session_terminated'",
        "UPDATE events SET correlation_id=NULL WHERE type='run.session_terminated'",
        "UPDATE events SET room_id=NULL WHERE type='run.session_terminated'",
        "UPDATE events SET corp_id='00000000-0000-0000-0000-000000000011' WHERE type='run.session_terminated'",
        "UPDATE events SET aggregate_type='task' WHERE type='run.session_terminated'",
        "UPDATE events SET aggregate_id='00000000-0000-0000-0000-000000000099' WHERE type='run.session_terminated'",
        "UPDATE verification_requests SET gate_type='human_approval'",
        r#"INSERT INTO tasks(id,corp_id,mission_id,title,objective,status,plan_key,contract,verification_policy)
           SELECT '00000000-0000-0000-0000-000000000020',corp_id,mission_id,'Other','Other','pending','other',contract,verification_policy FROM tasks;
           UPDATE verification_requests SET task_id='00000000-0000-0000-0000-000000000020'"#,
        r#"INSERT INTO action_approvals(id,corp_id,room_id,mission_id,task_id,run_id,agent_id,
                action_key,action,risk,rationale,required_roles,expires_at)
           SELECT '00000000-0000-0000-0000-000000000020',run.corp_id,mission.room_id,mission.id,
                  task.id,run.id,run.agent_id,'tool','Tool approval','high','Live tool wait',ARRAY['owner'],now()+interval '1 hour'
           FROM runs run JOIN tasks task ON task.id=run.task_id JOIN missions mission ON mission.id=task.mission_id"#,
    ];
    let original = state(&store).await;
    for change in cases {
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::raw_sql(change).execute(&mut *tx).await.unwrap();
        let events = mark_runner_runs_lost_tx(&mut tx, RUNNER, &[], None, "fixture loss")
            .await
            .unwrap();
        assert_eq!(events.len(), 1, "{change}");
        assert_eq!(events[0].event_type, "run.lost", "{change}");
        tx.rollback().await.unwrap();
        assert_eq!(state(&store).await, original);
    }
}

#[sqlx::test(migrations = "../../db/migrations")]
#[ignore = "requires explicitly owned SQLx maintenance database"]
async fn issue265_later_teardown_uncertainty_prevents_finished_review_exception(pool: PgPool) {
    let store = fixture(pool).await;
    let mut tx = store.pool.begin().await.unwrap();
    append_event_tx(
        &mut tx,
        NewEvent {
            room_id: Some(ROOM),
            correlation_id: Some(MISSION),
            ..NewEvent::new(
                CORP,
                None,
                "run.teardown_uncertain",
                "run",
                RUN,
                "uncertain".to_owned(),
                json!({"provider_process_state":"unverified"}),
            )
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let events = store
        .mark_unclaimed_runner_runs_lost(RUNNER, EPOCH, &[])
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(state(&store).await["run"]["status"], "lost");
}
