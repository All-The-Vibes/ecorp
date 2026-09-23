-- Full consensus headers remain append-only; progress is derived, never trusted from a summary row.
CREATE TABLE base_audit_ancestry_segments (
    corp_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    ancestry_key BYTEA NOT NULL CHECK (octet_length(ancestry_key) = 32),
    ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
    segment JSONB NOT NULL CHECK (
        jsonb_typeof(segment->'headers') = 'array'
        AND jsonb_array_length(segment->'headers') BETWEEN 1 AND 512
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (corp_id, destination_id, ancestry_key, ordinal),
    FOREIGN KEY (corp_id, destination_id) REFERENCES base_audit_destinations(corp_id, id)
);
CREATE TRIGGER base_audit_ancestry_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON base_audit_ancestry_segments
FOR EACH STATEMENT EXECUTE FUNCTION state_audit_immutable();
