CREATE TABLE state_audit_destinations (
    id UUID PRIMARY KEY,
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    kind TEXT NOT NULL CHECK(kind IN ('github','ethereum')),
    config JSONB NOT NULL,
    interval_seconds BIGINT NOT NULL CHECK(interval_seconds BETWEEN 60 AND 315360000),
    next_due TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_commit TEXT,
    last_checkpoint_digest TEXT,
    failures BIGINT NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE(corp_id,id)
);
CREATE TABLE state_audit_anchor_receipts (
    corp_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    checkpoint_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','published','superseded')),
    witness JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(destination_id,checkpoint_digest),
    FOREIGN KEY(corp_id,destination_id) REFERENCES state_audit_destinations(corp_id,id),
    FOREIGN KEY(corp_id,checkpoint_digest) REFERENCES state_audit_checkpoints(corp_id,digest)
);
CREATE FUNCTION state_audit_enqueue_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO state_audit_anchor_receipts(corp_id,destination_id,checkpoint_digest,status)
    SELECT NEW.corp_id,id,NEW.digest,'pending' FROM state_audit_destinations WHERE corp_id=NEW.corp_id;
    RETURN NEW;
END $$;
CREATE TRIGGER state_audit_checkpoint_outbox AFTER INSERT ON state_audit_checkpoints
FOR EACH ROW EXECUTE FUNCTION state_audit_enqueue_checkpoint();
