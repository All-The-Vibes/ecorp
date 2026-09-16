-- Base is additive: no V1 checkpoint, signing domain, or GitHub schedule changes.
CREATE TABLE base_audit_customer_trust (
    customer_id BYTEA PRIMARY KEY CHECK(octet_length(customer_id)=32),
    authority BYTEA NOT NULL CHECK(octet_length(authority)=32)
);
CREATE TRIGGER base_audit_customer_trust_immutable BEFORE UPDATE OR DELETE ON base_audit_customer_trust
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TABLE base_audit_destinations (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    customer_id BYTEA NOT NULL CHECK(octet_length(customer_id)=32),
    config JSONB NOT NULL,
    manifest_digest TEXT NOT NULL,
    chain_id BIGINT NOT NULL CHECK(chain_id IN (8453,84532)),
    sender BYTEA NOT NULL CHECK(octet_length(sender)=20),
    registry BYTEA NOT NULL CHECK(octet_length(registry)=20),
    stream_id BYTEA NOT NULL CHECK(octet_length(stream_id)=32),
    enabled BOOLEAN NOT NULL DEFAULT false,
    restore_required BOOLEAN NOT NULL DEFAULT true,
    version BIGINT NOT NULL DEFAULT 1,
    validation JSONB,
    validation_expires TIMESTAMPTZ,
    next_due TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'disabled',
    observed_sequence BIGINT NOT NULL DEFAULT 0,
    observed_digest TEXT,
    verified_sequence BIGINT NOT NULL DEFAULT 0,
    verified_digest TEXT,
    scan_block BIGINT,
    scan_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(corp_id,id),
    UNIQUE(chain_id,registry,stream_id,manifest_digest)
);
CREATE UNIQUE INDEX base_audit_one_enabled_stream ON base_audit_destinations(chain_id,registry,stream_id) WHERE enabled;
CREATE FUNCTION base_audit_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.corp_id,NEW.customer_id,NEW.config,NEW.manifest_digest,
           NEW.chain_id,NEW.sender,NEW.registry,NEW.stream_id)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.corp_id,OLD.customer_id,OLD.config,OLD.manifest_digest,
           OLD.chain_id,OLD.sender,OLD.registry,OLD.stream_id) THEN
        RAISE EXCEPTION 'Base destination trust/configuration is immutable; enroll a linked revision';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER base_audit_config_immutable BEFORE UPDATE ON base_audit_destinations
FOR EACH ROW EXECUTE FUNCTION base_audit_config_guard();

CREATE TABLE base_audit_intents (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    checkpoint_digest TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK(sequence > 0),
    previous_digest TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready',
    worker_id UUID,
    fence BIGINT NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ,
    nonce BIGINT CHECK(nonce>=0),
    calldata BYTEA,
    reservation NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK(reservation>=0),
    settled NUMERIC(78,0),
    inclusion_month DATE,
    fee_warning BOOLEAN NOT NULL DEFAULT false,
    terminal BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(corp_id,id),
    UNIQUE(destination_id,checkpoint_digest),
    FOREIGN KEY(corp_id,destination_id) REFERENCES base_audit_destinations(corp_id,id),
    FOREIGN KEY(corp_id,checkpoint_digest) REFERENCES state_audit_checkpoints(corp_id,digest)
);
CREATE UNIQUE INDEX base_audit_one_inflight ON base_audit_intents(destination_id) WHERE NOT terminal;
CREATE FUNCTION base_audit_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.corp_id,NEW.destination_id,NEW.checkpoint_digest,NEW.sequence,NEW.previous_digest)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.corp_id,OLD.destination_id,OLD.checkpoint_digest,OLD.sequence,OLD.previous_digest)
       OR (OLD.nonce IS NOT NULL AND
           ROW(NEW.nonce,NEW.calldata) IS DISTINCT FROM ROW(OLD.nonce,OLD.calldata)) THEN
        RAISE EXCEPTION 'Base intent identity and nonce are immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER base_audit_intent_immutable BEFORE UPDATE ON base_audit_intents
FOR EACH ROW EXECUTE FUNCTION base_audit_intent_guard();

-- Deliberately global uniqueness, with an explicit customer security boundary.
CREATE TABLE base_audit_sender_lanes (
    chain_id BIGINT NOT NULL,
    sender BYTEA NOT NULL CHECK(octet_length(sender)=20),
    customer_id BYTEA NOT NULL CHECK(octet_length(customer_id)=32),
    active_corp_id UUID,
    active_intent UUID,
    next_nonce BIGINT NOT NULL DEFAULT 0 CHECK(next_nonce>=0),
    paused BOOLEAN NOT NULL DEFAULT true,
    journal_epoch TEXT,
    journal_cursor BIGINT NOT NULL DEFAULT 0,
    monthly_budget NUMERIC(78,0) NOT NULL CHECK(monthly_budget>0),
    PRIMARY KEY(chain_id,sender),
    FOREIGN KEY(active_corp_id,active_intent) REFERENCES base_audit_intents(corp_id,id),
    CHECK((active_corp_id IS NULL)=(active_intent IS NULL))
);
CREATE TABLE base_audit_attempts (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL,
    intent_id UUID NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    frozen JSONB NOT NULL,
    liability NUMERIC(78,0) NOT NULL CHECK(liability>=0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(intent_id,ordinal),
    UNIQUE(corp_id,id),
    FOREIGN KEY(corp_id,intent_id) REFERENCES base_audit_intents(corp_id,id)
);
CREATE TRIGGER base_audit_attempts_immutable BEFORE UPDATE OR DELETE ON base_audit_attempts
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TABLE base_audit_signed_results (
    attempt_id UUID PRIMARY KEY,
    corp_id UUID NOT NULL,
    raw_tx BYTEA NOT NULL CHECK(octet_length(raw_tx) BETWEEN 1 AND 131072),
    tx_hash TEXT NOT NULL,
    journal_sequence BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY(corp_id,attempt_id) REFERENCES base_audit_attempts(corp_id,id)
);
CREATE TRIGGER base_audit_signed_immutable BEFORE UPDATE OR DELETE ON base_audit_signed_results
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TABLE base_audit_evidence (
    id BIGSERIAL PRIMARY KEY,
    corp_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    intent_id UUID,
    kind TEXT NOT NULL,
    identity TEXT NOT NULL,
    evidence JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(destination_id,kind,identity),
    FOREIGN KEY(corp_id,destination_id) REFERENCES base_audit_destinations(corp_id,id),
    FOREIGN KEY(corp_id,intent_id) REFERENCES base_audit_intents(corp_id,id)
);
CREATE TRIGGER base_audit_evidence_immutable BEFORE UPDATE OR DELETE ON base_audit_evidence
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TABLE base_audit_retained_history (
    corp_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    checkpoint_digest TEXT NOT NULL,
    archive JSONB NOT NULL,
    retained_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(destination_id,checkpoint_digest),
    FOREIGN KEY(corp_id,destination_id) REFERENCES base_audit_destinations(corp_id,id),
    FOREIGN KEY(corp_id,checkpoint_digest) REFERENCES state_audit_checkpoints(corp_id,digest)
);
CREATE TRIGGER base_audit_history_immutable BEFORE UPDATE OR DELETE ON base_audit_retained_history
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
CREATE TABLE base_audit_operations (
    corp_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES actors(id),
    operation_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    intent_id UUID NOT NULL,
    PRIMARY KEY(corp_id,actor_id,operation_id),
    FOREIGN KEY(corp_id,destination_id) REFERENCES base_audit_destinations(corp_id,id),
    FOREIGN KEY(corp_id,intent_id) REFERENCES base_audit_intents(corp_id,id)
);
CREATE TRIGGER base_audit_operations_immutable BEFORE UPDATE OR DELETE ON base_audit_operations
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
