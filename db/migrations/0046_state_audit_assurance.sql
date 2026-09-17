ALTER TABLE state_audit_destinations
    ADD COLUMN calendar_schedule JSONB,
    ADD COLUMN overdue_after_seconds BIGINT NOT NULL DEFAULT 86400
        CHECK(overdue_after_seconds BETWEEN 60 AND 630720000),
    ADD COLUMN scheduled_due TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN workflow_gate TEXT NOT NULL DEFAULT 'none'
        CHECK(workflow_gate IN ('none','published','finalized')),
    ADD COLUMN last_successful_publication TIMESTAMPTZ,
    ADD COLUMN last_attempted_publication TIMESTAMPTZ,
    ADD COLUMN last_published_sequence BIGINT
        CHECK(last_published_sequence IS NULL OR last_published_sequence > 0),
    ADD COLUMN last_finalized_sequence BIGINT
        CHECK(last_finalized_sequence IS NULL OR last_finalized_sequence > 0),
    ADD COLUMN publication_disabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN reconciliation_error TEXT;

ALTER TABLE state_audit_anchor_receipts
    DROP CONSTRAINT state_audit_anchor_receipts_status_check,
    ADD CONSTRAINT state_audit_anchor_receipts_status_check
        CHECK(status IN ('pending','published','finalized','superseded'));

CREATE TABLE state_audit_signing_keys (
    corp_id UUID NOT NULL REFERENCES state_audit_ledgers(corp_id),
    key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 128),
    public_key BYTEA NOT NULL CHECK(octet_length(public_key) = 32),
    activated_sequence BIGINT NOT NULL CHECK(activated_sequence > 0),
    retired_sequence BIGINT CHECK(
        retired_sequence IS NULL OR retired_sequence >= activated_sequence
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(corp_id,key_id),
    UNIQUE(corp_id,activated_sequence)
);

CREATE UNIQUE INDEX state_audit_one_active_signing_key
    ON state_audit_signing_keys(corp_id)
    WHERE retired_sequence IS NULL;

CREATE FUNCTION state_audit_signing_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.corp_id <> NEW.corp_id
       OR OLD.key_id <> NEW.key_id
       OR OLD.public_key <> NEW.public_key
       OR OLD.activated_sequence <> NEW.activated_sequence
       OR OLD.created_at <> NEW.created_at
       OR OLD.retired_sequence IS NOT NULL
       OR NEW.retired_sequence IS NULL
       OR NEW.retired_sequence < OLD.activated_sequence THEN
        RAISE EXCEPTION 'state audit signing-key history is immutable';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER state_audit_signing_keys_update_guard
BEFORE UPDATE ON state_audit_signing_keys
FOR EACH ROW EXECUTE FUNCTION state_audit_signing_key_immutable();

CREATE TRIGGER state_audit_signing_keys_delete_guard
BEFORE DELETE ON state_audit_signing_keys
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
