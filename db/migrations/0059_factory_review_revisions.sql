-- A published result remains immutable. Corrections use separate native missions
-- and a bounded, nonforking publication lineage.
ALTER TABLE runs ADD COLUMN workspace_head_commit TEXT
    CHECK (workspace_head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');

ALTER TABLE factory_work_items DROP CONSTRAINT factory_work_items_state_check;
ALTER TABLE factory_work_items ADD CONSTRAINT factory_work_items_state_check CHECK (
    state IN ('claimed','mission_created','running','blocked','awaiting_approval',
        'verification_failed','verified','publishing','published','review_revision','failed','cancelled')
);

ALTER TABLE pull_request_publications ADD COLUMN supersedes_publication_id UUID;
ALTER TABLE pull_request_publications ADD CONSTRAINT review_publication_scope
    UNIQUE (id,corp_id,factory_work_item_id);
ALTER TABLE pull_request_publications DROP CONSTRAINT pull_request_publications_factory_work_item_id_key;
ALTER TABLE pull_request_publications ADD CONSTRAINT publication_per_mission
    UNIQUE (factory_work_item_id,mission_id);
ALTER TABLE pull_request_publications ADD CONSTRAINT publication_successor_scope
    FOREIGN KEY (supersedes_publication_id,corp_id,factory_work_item_id)
    REFERENCES pull_request_publications(id,corp_id,factory_work_item_id);
CREATE UNIQUE INDEX publication_one_root ON pull_request_publications(factory_work_item_id)
    WHERE supersedes_publication_id IS NULL;
CREATE UNIQUE INDEX publication_one_successor ON pull_request_publications(supersedes_publication_id)
    WHERE supersedes_publication_id IS NOT NULL;

CREATE TABLE factory_review_revisions (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL REFERENCES corps(id),
    factory_work_item_id UUID NOT NULL,
    publication_id UUID NOT NULL UNIQUE,
    source_mission_id UUID NOT NULL,
    source_task_id UUID NOT NULL,
    source_run_id UUID NOT NULL,
    source_deliverable_id UUID NOT NULL,
    source_head_commit TEXT NOT NULL CHECK (source_head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    mission_id UUID NOT NULL UNIQUE,
    task_id UUID NOT NULL UNIQUE,
    authorized_by UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    request JSONB NOT NULL,
    findings JSONB NOT NULL CHECK (jsonb_typeof(findings)='array' AND jsonb_array_length(findings) BETWEEN 1 AND 20),
    source_policy JSONB NOT NULL,
    source_contract JSONB NOT NULL,
    source_verification_policy JSONB NOT NULL,
    source_mission_authority JSONB NOT NULL,
    source_attempts INTEGER NOT NULL CHECK (source_attempts > 0),
    source_required_adapter TEXT NOT NULL,
    replacement_contract JSONB NOT NULL,
    replacement_verification_policy JSONB NOT NULL,
    replacement_attempts INTEGER NOT NULL CHECK (replacement_attempts > 0),
    observed_source_revision TEXT NOT NULL CHECK (length(observed_source_revision) BETWEEN 1 AND 200),
    source_recovery_id UUID REFERENCES factory_verification_recoveries(id),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','adopted','abandoned')),
    result_run_id UUID,
    result_deliverable_id UUID,
    result_commit TEXT CHECK (result_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    review_decision_id UUID,
    settled_by UUID,
    settlement_key UUID,
    settlement_request JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (corp_id,authorized_by,idempotency_key),
    UNIQUE (corp_id,settled_by,settlement_key),
    CHECK (source_mission_id<>mission_id AND source_task_id<>task_id),
    CHECK ((state='pending' AND settled_by IS NULL AND settlement_key IS NULL AND settlement_request IS NULL)
        OR (state IN ('adopted','abandoned') AND settled_by IS NOT NULL AND settlement_key IS NOT NULL AND settlement_request IS NOT NULL)),
    CHECK ((state='adopted' AND result_run_id IS NOT NULL AND result_deliverable_id IS NOT NULL AND result_commit IS NOT NULL AND review_decision_id IS NOT NULL)
        OR (state IN ('pending','abandoned') AND result_run_id IS NULL AND result_deliverable_id IS NULL AND result_commit IS NULL AND review_decision_id IS NULL)),
    FOREIGN KEY (factory_work_item_id,corp_id) REFERENCES factory_work_items(id,corp_id),
    FOREIGN KEY (publication_id,corp_id,factory_work_item_id) REFERENCES pull_request_publications(id,corp_id,factory_work_item_id),
    FOREIGN KEY (source_mission_id,corp_id) REFERENCES missions(id,corp_id),
    FOREIGN KEY (source_task_id,corp_id,source_mission_id) REFERENCES tasks(id,corp_id,mission_id),
    FOREIGN KEY (source_run_id,corp_id,source_task_id) REFERENCES runs(id,corp_id,task_id),
    FOREIGN KEY (source_deliverable_id,corp_id,source_task_id,source_run_id) REFERENCES source_deliverables(id,corp_id,task_id,run_id),
    FOREIGN KEY (mission_id,corp_id) REFERENCES missions(id,corp_id),
    FOREIGN KEY (task_id,corp_id,mission_id) REFERENCES tasks(id,corp_id,mission_id),
    FOREIGN KEY (authorized_by,corp_id) REFERENCES actors(id,corp_id),
    FOREIGN KEY (settled_by,corp_id) REFERENCES actors(id,corp_id),
    FOREIGN KEY (result_run_id,corp_id,task_id) REFERENCES runs(id,corp_id,task_id),
    FOREIGN KEY (result_deliverable_id,corp_id,task_id,result_run_id) REFERENCES source_deliverables(id,corp_id,task_id,run_id),
    FOREIGN KEY (corp_id,result_run_id,review_decision_id) REFERENCES verification_requests(corp_id,run_id,decision_key)
);
CREATE UNIQUE INDEX review_revision_one_pending ON factory_review_revisions(factory_work_item_id) WHERE state='pending';
CREATE INDEX review_revision_source_mission ON factory_review_revisions(source_mission_id);

CREATE FUNCTION review_revision_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'review revision lineage cannot be deleted'; END IF;
    IF OLD.state<>'pending' OR NEW.state='pending' OR
       (to_jsonb(NEW) - ARRAY['state','result_run_id','result_deliverable_id','result_commit',
           'review_decision_id','settled_by','settlement_key','settlement_request','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','result_run_id','result_deliverable_id','result_commit',
           'review_decision_id','settled_by','settlement_key','settlement_request','updated_at']) THEN
        RAISE EXCEPTION 'review revision authority is immutable and settlement is terminal';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER review_revision_identity_guard BEFORE UPDATE OR DELETE ON factory_review_revisions
FOR EACH ROW EXECUTE FUNCTION review_revision_preserve_identity();

CREATE FUNCTION publication_preserve_succession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW.supersedes_publication_id IS DISTINCT FROM OLD.supersedes_publication_id THEN
            RAISE EXCEPTION 'publication succession is immutable';
        END IF;
    ELSIF NEW.supersedes_publication_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM factory_review_revisions r
            JOIN pull_request_publications p ON p.id=r.publication_id AND p.corp_id=r.corp_id
            WHERE r.corp_id=NEW.corp_id AND r.factory_work_item_id=NEW.factory_work_item_id
              AND r.publication_id=NEW.supersedes_publication_id AND r.mission_id=NEW.mission_id
              AND r.result_deliverable_id=NEW.source_deliverable_id AND r.result_run_id=NEW.run_id
              AND r.result_commit=NEW.commit_sha AND r.state='adopted' AND p.state='published'
              AND p.target_repository=NEW.target_repository AND p.base_ref=NEW.base_ref
              AND p.branch<>NEW.branch AND p.id<>NEW.id) THEN
            RAISE EXCEPTION 'publication successor requires an adopted, verified review revision';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER publication_succession_guard BEFORE INSERT OR UPDATE ON pull_request_publications
FOR EACH ROW EXECUTE FUNCTION publication_preserve_succession();

-- Historical missions without these links keep their existing audit hash.
ALTER FUNCTION state_audit_fingerprint(UUID) RENAME TO state_audit_pre_review_revision_fingerprint;
CREATE FUNCTION state_audit_fingerprint(mid UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
SELECT CASE WHEN links.value IS NULL THEN state_audit_pre_review_revision_fingerprint(mid)
    ELSE md5(jsonb_build_array(state_audit_pre_review_revision_fingerprint(mid),links.value)::text) END
FROM (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) AS value FROM factory_review_revisions r
      WHERE r.source_mission_id=mid OR r.mission_id=mid) links
$$;
CREATE FUNCTION state_audit_check_review_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid UUID; expected TEXT;
BEGIN
    FOR mid IN SELECT unnest(ARRAY[NEW.source_mission_id,NEW.mission_id]) LOOP
        SELECT fingerprint INTO expected FROM state_audit_coverage WHERE mission_id=mid;
        IF expected IS NOT NULL AND expected IS DISTINCT FROM state_audit_fingerprint(mid) THEN
            RAISE EXCEPTION 'review revision changed covered governance without an atomic audit decision';
        END IF;
    END LOOP;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER review_revision_audit_guard AFTER INSERT OR UPDATE ON factory_review_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION state_audit_check_review_revision();
