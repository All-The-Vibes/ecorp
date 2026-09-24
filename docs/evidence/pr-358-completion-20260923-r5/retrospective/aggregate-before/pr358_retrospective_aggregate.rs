use super::*;

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

pub(super) fn run_id(index: u128) -> Uuid {
    Uuid::from_u128(5610 + index * 4)
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
#[ignore = "requires explicitly owned retrospective PostgreSQL"]
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
