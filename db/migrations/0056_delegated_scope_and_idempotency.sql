-- Preserve existing migration checksums and legacy operation identities.
-- Reject invalid existing links instead of guessing or reassigning authority.
ALTER TABLE missions ADD CONSTRAINT delegated_missions_scope_unique UNIQUE (id, corp_id);
ALTER TABLE tasks ADD CONSTRAINT delegated_tasks_scope_mission_unique UNIQUE (id, corp_id, mission_id);
ALTER TABLE runs ADD CONSTRAINT delegated_runs_scope_task_unique UNIQUE (id, corp_id, task_id);

ALTER TABLE delegated_operations
    ADD CONSTRAINT delegated_operation_actor_scope
        FOREIGN KEY (actor_id, corp_id) REFERENCES actors(id, corp_id),
    ADD CONSTRAINT delegated_operation_mission_scope
        FOREIGN KEY (mission_id, corp_id) REFERENCES missions(id, corp_id),
    ADD CONSTRAINT delegated_operation_task_scope
        FOREIGN KEY (task_id, corp_id, mission_id) REFERENCES tasks(id, corp_id, mission_id),
    ADD CONSTRAINT delegated_operation_run_scope
        FOREIGN KEY (run_id, corp_id, task_id) REFERENCES runs(id, corp_id, task_id),
    ADD COLUMN idempotency_key uuid,
    ADD CONSTRAINT delegated_operation_request_unique UNIQUE (corp_id, actor_id, idempotency_key);
