// Included only by cfg(test) modules. Keep the selector fixture shared with the
// signed server fixture so neither harness substitutes its own dependency query.
async fn initialize_dependency_artifact_fixture(pool: &sqlx::PgPool) {
    let corp = Uuid::from_u128(1);
    let mission = Uuid::from_u128(2);
    let parent = Uuid::from_u128(3);
    let child = Uuid::from_u128(4);
    let provider = Uuid::from_u128(5);
    let recovered = Uuid::from_u128(6);
    let artifact = Uuid::from_u128(7);
    let agent = Uuid::from_u128(8);
    let recovery = Uuid::from_u128(9);
    let item = Uuid::from_u128(10);
    let peer = Uuid::from_u128(11);
    let peer_run = Uuid::from_u128(12);
    let peer_artifact = Uuid::from_u128(13);
    sqlx::raw_sql(&format!(
        r#"
        CREATE TABLE tasks (
            id UUID PRIMARY KEY, corp_id UUID DEFAULT '{corp}',
            mission_id UUID DEFAULT '{mission}', plan_key TEXT, title TEXT DEFAULT 'handoff',
            contract JSONB DEFAULT '{{}}', status TEXT DEFAULT 'completed',
            verification_status TEXT DEFAULT 'passed'
        );
        CREATE TABLE task_dependencies (task_id UUID, depends_on_task_id UUID);
        CREATE TABLE runs (
            id UUID PRIMARY KEY, corp_id UUID DEFAULT '{corp}', task_id UUID,
            agent_id UUID DEFAULT '{agent}', runner_id TEXT DEFAULT 'fixture-runner',
            workspace_run_id UUID DEFAULT '{provider}', resumed_from_run_id UUID,
            source_repository TEXT DEFAULT 'fixture/repo', source_base_ref TEXT DEFAULT 'main',
            source_base_commit TEXT DEFAULT 'base', workspace_base_commit TEXT DEFAULT 'base',
            status TEXT DEFAULT 'completed', verification_status TEXT DEFAULT 'passed',
            execution_mode TEXT DEFAULT 'provider', summary TEXT,
            artifact_id UUID, artifact_sha256 TEXT DEFAULT 'digest',
            artifact_media_type TEXT DEFAULT 'text/plain',
            artifact_signature TEXT DEFAULT 'fixture-signature',
            verification_sha256 TEXT DEFAULT 'verification', deliverable_sha256 TEXT,
            created_at TIMESTAMPTZ DEFAULT '2000-01-01 00:00:00+00'
        );
        CREATE TABLE artifacts (
            id UUID PRIMARY KEY, corp_id UUID DEFAULT '{corp}', task_id UUID, run_id UUID,
            producer_agent_id UUID DEFAULT '{agent}',
            producer_runner_id TEXT DEFAULT 'fixture-runner', verifier TEXT DEFAULT 'runner',
            object_key TEXT DEFAULT 'fixture', uri TEXT DEFAULT 'fixture',
            sha256 TEXT DEFAULT 'digest', media_type TEXT DEFAULT 'text/plain',
            bytes BIGINT DEFAULT 1, artifact_role TEXT DEFAULT 'provider_evidence',
            file_name TEXT DEFAULT 'result.md', metadata JSONB DEFAULT '{{}}',
            provenance_signature TEXT DEFAULT 'fixture-signature',
            retention_until TIMESTAMPTZ DEFAULT (now() + interval '1 day'),
            status TEXT DEFAULT 'ready'
        );
        CREATE TABLE source_deliverables (
            run_id UUID, task_id UUID, corp_id UUID, artifact_id UUID, form TEXT,
            base_commit TEXT, verification_sha256 TEXT
        );
        CREATE TABLE factory_work_items (
            id UUID PRIMARY KEY, corp_id UUID DEFAULT '{corp}', mission_id UUID DEFAULT '{mission}'
        );
        CREATE TABLE factory_verification_recoveries (
            id UUID PRIMARY KEY, corp_id UUID DEFAULT '{corp}',
            mission_id UUID DEFAULT '{mission}', task_id UUID DEFAULT '{parent}',
            factory_work_item_id UUID DEFAULT '{item}', source_run_id UUID,
            replacement_run_id UUID, mode TEXT DEFAULT 'verifier_only',
            status TEXT DEFAULT 'completed'
        );
        INSERT INTO tasks (id, plan_key) VALUES
            ('{parent}', 'specialist-a'), ('{peer}', 'specialist-b'), ('{child}', 'synthesis');
        INSERT INTO task_dependencies VALUES ('{child}', '{parent}'), ('{child}', '{peer}');
        INSERT INTO runs (id, task_id, artifact_id, status, verification_status)
            VALUES ('{provider}', '{parent}', '{artifact}', 'failed', 'failed');
        INSERT INTO runs (id, task_id, artifact_id, execution_mode, resumed_from_run_id, created_at)
            VALUES ('{recovered}', '{parent}', '{artifact}', 'verification_only',
                    '{provider}', '2000-01-03 00:00:00+00');
        INSERT INTO runs (id, task_id, artifact_id, workspace_run_id)
            VALUES ('{peer_run}', '{peer}', '{peer_artifact}', '{peer_run}');
        INSERT INTO artifacts (id, task_id, run_id)
            VALUES ('{artifact}', '{parent}', '{provider}'), ('{peer_artifact}', '{peer}', '{peer_run}');
        INSERT INTO factory_work_items (id) VALUES ('{item}');
        INSERT INTO factory_verification_recoveries (id, source_run_id, replacement_run_id)
            VALUES ('{recovery}', '{provider}', '{recovered}');
        "#
    ))
    .execute(pool)
    .await
    .expect("create isolated dependency metadata fixture");
    sqlx::query("UPDATE tasks SET contract = $1")
        .bind(json!({
            "objective": "handoff", "expected_output": "result.md",
            "acceptance_tests": ["verified artifact"], "allowed_tools": ["filesystem"],
            "prohibited_actions": [], "references": [], "write_scope": ["result.md"],
            "budget_tokens": 100, "deadline_at": null, "escalation": "stop"
        }))
        .execute(pool)
        .await
        .unwrap();
}
