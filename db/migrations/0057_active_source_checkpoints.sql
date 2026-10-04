-- Active draft checkpoints do not satisfy final deliverable or verification constraints.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_role_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_role_check
    CHECK (artifact_role IN ('provider_evidence', 'source_deliverable', 'source_checkpoint'));

ALTER TABLE factory_work_items ADD CONSTRAINT active_checkpoint_factory_scope
    UNIQUE (id, corp_id, mission_id);
ALTER TABLE artifacts ADD CONSTRAINT active_checkpoint_artifact_scope
    UNIQUE (id, corp_id, task_id, run_id);

CREATE TABLE active_checkpoint_publications (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL REFERENCES corps(id) ON DELETE RESTRICT,
    work_item_id UUID NOT NULL,
    mission_id UUID NOT NULL,
    task_id UUID NOT NULL,
    run_id UUID NOT NULL,
    artifact_id UUID NOT NULL UNIQUE,
    generation BIGINT NOT NULL CHECK (generation > 0),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    publisher_token UUID NOT NULL,
    lease_operation_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (corp_id, work_item_id, generation),
    UNIQUE (corp_id, id),
    FOREIGN KEY (work_item_id, corp_id, mission_id)
        REFERENCES factory_work_items(id, corp_id, mission_id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, corp_id, mission_id)
        REFERENCES tasks(id, corp_id, mission_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, corp_id, task_id)
        REFERENCES runs(id, corp_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (artifact_id, corp_id, task_id, run_id)
        REFERENCES artifacts(id, corp_id, task_id, run_id) ON DELETE RESTRICT,
    CHECK ((snapshot->>'id' = id::text) IS TRUE),
    CHECK ((snapshot->>'corp_id' = corp_id::text) IS TRUE),
    CHECK ((snapshot->>'work_item_id' = work_item_id::text) IS TRUE),
    CHECK ((snapshot->>'mission_id' = mission_id::text) IS TRUE),
    CHECK ((snapshot->>'task_id' = task_id::text) IS TRUE),
    CHECK ((snapshot->>'run_id' = run_id::text) IS TRUE),
    CHECK ((snapshot->>'artifact_id' = artifact_id::text) IS TRUE),
    CHECK ((snapshot->>'phase' IN ('pending', 'branch_pushed', 'draft_published', 'project_synchronized')) IS TRUE),
    CHECK (((snapshot->>'version')::bigint > 0) IS TRUE)
);

CREATE TABLE active_checkpoint_operations (
    corp_id UUID NOT NULL REFERENCES corps(id) ON DELETE RESTRICT,
    idempotency_key UUID NOT NULL,
    publication_id UUID NOT NULL,
    request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    resulting_version BIGINT NOT NULL CHECK (resulting_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (corp_id, idempotency_key),
    FOREIGN KEY (corp_id, publication_id) REFERENCES active_checkpoint_publications(corp_id, id) ON DELETE RESTRICT
);
