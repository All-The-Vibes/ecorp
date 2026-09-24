-- Audit coverage is explicit. Never regenerate a missing/restored ledger identity.
CREATE TABLE state_audit_ledgers (
    corp_id UUID PRIMARY KEY REFERENCES corps(id),
    ledger_id UUID NOT NULL UNIQUE,
    last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
    last_row_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE state_audit_coverage (
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    mission_id UUID PRIMARY KEY REFERENCES missions(id),
    fingerprint TEXT NOT NULL
);
CREATE TABLE state_audit_objects (
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('content','version','policy')),
    bytes BYTEA NOT NULL CHECK(octet_length(bytes) <= 262144),
    value JSONB NOT NULL,
    PRIMARY KEY(corp_id,hash)
);
CREATE TABLE state_audit_decisions (
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    sequence BIGINT NOT NULL CHECK(sequence > 0),
    mission_id UUID NOT NULL REFERENCES missions(id),
    actor_id UUID NOT NULL REFERENCES actors(id),
    request_id UUID NOT NULL,
    request_digest TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    bytes BYTEA NOT NULL CHECK(octet_length(bytes) <= 262144),
    decision JSONB NOT NULL,
    object_hashes JSONB NOT NULL,
    receipt JSONB NOT NULL,
    PRIMARY KEY(corp_id,sequence),
    UNIQUE(corp_id,actor_id,request_id),
    UNIQUE(corp_id,row_hash)
);
CREATE TABLE state_audit_refs (
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    resource_key TEXT NOT NULL,
    version_hash TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision > 0),
    PRIMARY KEY(corp_id,resource_key),
    FOREIGN KEY(corp_id,version_hash) REFERENCES state_audit_objects(corp_id,hash)
);
CREATE TABLE state_audit_checkpoints (
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    sequence BIGINT NOT NULL,
    digest TEXT NOT NULL,
    record JSONB NOT NULL,
    PRIMARY KEY(corp_id,sequence),
    UNIQUE(corp_id,digest),
    FOREIGN KEY(corp_id,sequence) REFERENCES state_audit_decisions(corp_id,sequence)
);
CREATE FUNCTION state_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'state audit history is immutable'; END $$;
CREATE TRIGGER state_audit_objects_immutable BEFORE UPDATE OR DELETE ON state_audit_objects
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TRIGGER state_audit_decisions_immutable BEFORE UPDATE OR DELETE ON state_audit_decisions
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TRIGGER state_audit_checkpoints_immutable BEFORE UPDATE OR DELETE ON state_audit_checkpoints
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();

-- This local drift detector is not a cryptographic audit commitment. Canonical
-- BLAKE3 objects remain the commitments. Deferred checking fails closed when an
-- older/uninstrumented native path changes covered governance state.
CREATE FUNCTION state_audit_fingerprint(mid UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
SELECT md5(jsonb_build_object(
    'mission',jsonb_build_array(m.corp_id,m.room_id,m.requested_by,m.description,
         m.specification_version,m.budget_tokens,m.budget_cost_microusd),
    'tasks',(SELECT jsonb_agg(jsonb_build_array(t.id,t.corp_id,t.mission_id,t.contract,
         t.contract_version,t.verification_policy) ORDER BY t.id) FROM tasks t WHERE t.mission_id=m.id),
    'pending',(SELECT jsonb_agg(jsonb_build_array(b.id,b.status,b.proposed_budget_tokens,
         b.proposed_budget_cost_microusd,b.replacement_contract,b.replacement_verification_policy)
         ORDER BY b.id) FROM mission_budget_revisions b WHERE b.mission_id=m.id AND b.status='pending')
)::text) FROM missions m WHERE m.id=mid
$$;
CREATE FUNCTION state_audit_check_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid UUID; expected TEXT;
BEGIN
    IF TG_TABLE_NAME='missions' THEN mid=COALESCE(NEW.id,OLD.id);
    ELSE mid=COALESCE(NEW.mission_id,OLD.mission_id); END IF;
    SELECT fingerprint INTO expected FROM state_audit_coverage WHERE mission_id=mid;
    IF expected IS NOT NULL AND expected IS DISTINCT FROM state_audit_fingerprint(mid) THEN
        RAISE EXCEPTION 'covered governance changed without an atomic state audit decision';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER state_audit_mission_guard AFTER INSERT OR UPDATE OR DELETE ON missions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION state_audit_check_coverage();
CREATE CONSTRAINT TRIGGER state_audit_task_guard AFTER INSERT OR UPDATE OR DELETE ON tasks
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION state_audit_check_coverage();
CREATE CONSTRAINT TRIGGER state_audit_budget_guard AFTER INSERT OR UPDATE OR DELETE ON mission_budget_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION state_audit_check_coverage();
