-- Refreshes preserve the accepted source and create a separate verification-only
-- mission. Publication continues to use its existing one-per-Factory aggregate.
ALTER TABLE factory_work_items ADD CONSTRAINT base_refresh_item_scope UNIQUE (id, corp_id);
ALTER TABLE source_deliverables ADD CONSTRAINT base_refresh_deliverable_scope
    UNIQUE (id, corp_id, task_id, run_id);
ALTER TABLE verification_requests ADD CONSTRAINT base_refresh_review_scope
    UNIQUE (corp_id, run_id, decision_key);

CREATE TABLE factory_base_refreshes (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL REFERENCES corps(id),
    factory_work_item_id UUID NOT NULL,
    source_mission_id UUID NOT NULL,
    source_task_id UUID NOT NULL,
    source_run_id UUID NOT NULL,
    source_deliverable_id UUID NOT NULL,
    mission_id UUID NOT NULL UNIQUE,
    task_id UUID NOT NULL UNIQUE,
    run_id UUID NOT NULL UNIQUE,
    authorized_by UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    request JSONB NOT NULL,
    command_id UUID NOT NULL UNIQUE,
    command_payload JSONB NOT NULL,
    source_policy JSONB NOT NULL,
    source_contract JSONB NOT NULL,
    source_verification_policy JSONB NOT NULL,
    refreshed_contract JSONB NOT NULL,
    refreshed_verification_policy JSONB NOT NULL,
    observed_source_revision TEXT NOT NULL CHECK (length(observed_source_revision) BETWEEN 1 AND 200),
    source_recovery_id UUID REFERENCES factory_verification_recoveries(id),
    original_base_commit TEXT NOT NULL CHECK (original_base_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    refreshed_base_commit TEXT NOT NULL CHECK (refreshed_base_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    source_head_commit TEXT NOT NULL CHECK (source_head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','adopted','abandoned')),
    result_deliverable_id UUID,
    result_commit TEXT CHECK (result_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    review_decision_id UUID,
    settled_by UUID,
    settlement_key UUID,
    settlement_request JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (corp_id, authorized_by, idempotency_key),
    UNIQUE (corp_id, settled_by, settlement_key),
    CHECK (source_mission_id <> mission_id AND source_task_id <> task_id AND source_run_id <> run_id),
    CHECK (original_base_commit <> refreshed_base_commit),
    CHECK ((state='pending' AND settled_by IS NULL AND settlement_key IS NULL AND settlement_request IS NULL)
        OR (state IN ('adopted','abandoned') AND settled_by IS NOT NULL AND settlement_key IS NOT NULL
            AND settlement_request IS NOT NULL)),
    CHECK ((state='adopted' AND result_deliverable_id IS NOT NULL AND result_commit IS NOT NULL AND review_decision_id IS NOT NULL)
        OR (state IN ('pending','abandoned') AND result_deliverable_id IS NULL AND result_commit IS NULL
            AND review_decision_id IS NULL)),
    FOREIGN KEY (factory_work_item_id,corp_id) REFERENCES factory_work_items(id,corp_id),
    FOREIGN KEY (source_mission_id,corp_id) REFERENCES missions(id,corp_id),
    FOREIGN KEY (source_task_id,corp_id,source_mission_id) REFERENCES tasks(id,corp_id,mission_id),
    FOREIGN KEY (source_run_id,corp_id,source_task_id) REFERENCES runs(id,corp_id,task_id),
    FOREIGN KEY (source_deliverable_id,corp_id,source_task_id,source_run_id)
        REFERENCES source_deliverables(id,corp_id,task_id,run_id),
    FOREIGN KEY (mission_id,corp_id) REFERENCES missions(id,corp_id),
    FOREIGN KEY (task_id,corp_id,mission_id) REFERENCES tasks(id,corp_id,mission_id),
    FOREIGN KEY (run_id,corp_id,task_id) REFERENCES runs(id,corp_id,task_id),
    FOREIGN KEY (authorized_by,corp_id) REFERENCES actors(id,corp_id),
    FOREIGN KEY (settled_by,corp_id) REFERENCES actors(id,corp_id),
    FOREIGN KEY (result_deliverable_id,corp_id,task_id,run_id)
        REFERENCES source_deliverables(id,corp_id,task_id,run_id),
    FOREIGN KEY (corp_id,run_id,review_decision_id) REFERENCES verification_requests(corp_id,run_id,decision_key)
);
CREATE UNIQUE INDEX base_refresh_one_pending ON factory_base_refreshes(factory_work_item_id) WHERE state='pending';
CREATE INDEX base_refresh_source_mission ON factory_base_refreshes(source_mission_id);

CREATE FUNCTION base_refresh_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'base refresh lineage cannot be deleted'; END IF;
    IF OLD.state <> 'pending' OR NEW.state = 'pending' OR
       (to_jsonb(NEW) - ARRAY['state','result_deliverable_id','result_commit','review_decision_id',
          'settled_by','settlement_key','settlement_request','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','result_deliverable_id','result_commit','review_decision_id',
          'settled_by','settlement_key','settlement_request','updated_at']) THEN
        RAISE EXCEPTION 'base refresh authority is immutable and settlement is terminal';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER base_refresh_identity_guard BEFORE UPDATE OR DELETE ON factory_base_refreshes
FOR EACH ROW EXECUTE FUNCTION base_refresh_preserve_identity();

-- Keep the original drift hash byte-for-byte when there is no refresh lineage.
ALTER FUNCTION state_audit_fingerprint(UUID) RENAME TO state_audit_pre_refresh_fingerprint;
CREATE FUNCTION state_audit_fingerprint(mid UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
SELECT CASE WHEN links.value IS NULL THEN state_audit_pre_refresh_fingerprint(mid)
    ELSE md5(jsonb_build_array(state_audit_pre_refresh_fingerprint(mid),links.value)::text) END
FROM (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) AS value FROM factory_base_refreshes r
      WHERE r.source_mission_id=mid OR r.mission_id=mid) links
$$;
CREATE FUNCTION state_audit_check_base_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid UUID; expected TEXT;
BEGIN
    FOR mid IN SELECT unnest(ARRAY[NEW.source_mission_id,NEW.mission_id]) LOOP
        SELECT fingerprint INTO expected FROM state_audit_coverage WHERE mission_id=mid;
        IF expected IS NOT NULL AND expected IS DISTINCT FROM state_audit_fingerprint(mid) THEN
            RAISE EXCEPTION 'base refresh changed covered governance without an atomic audit decision';
        END IF;
    END LOOP;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER base_refresh_audit_guard AFTER INSERT OR UPDATE ON factory_base_refreshes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION state_audit_check_base_refresh();
