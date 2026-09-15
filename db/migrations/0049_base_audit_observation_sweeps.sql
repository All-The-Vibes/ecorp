-- Mutable sweep progress never replaces or deletes immutable observation evidence.
CREATE TABLE base_audit_observation_sweeps (
    corp_id UUID NOT NULL,
    destination_id UUID NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    after_id BIGINT NOT NULL DEFAULT 0 CHECK (after_id >= 0),
    through_id BIGINT NOT NULL DEFAULT 0 CHECK (through_id >= after_id),
    complete BOOLEAN NOT NULL DEFAULT false,
    anchor JSONB,
    PRIMARY KEY (corp_id, destination_id),
    FOREIGN KEY (corp_id, destination_id) REFERENCES base_audit_destinations(corp_id, id),
    CHECK (NOT complete OR after_id = through_id),
    CHECK (anchor IS NOT NULL OR (after_id = 0 AND through_id = 0 AND NOT complete))
);
CREATE INDEX base_audit_observation_page
ON base_audit_evidence (corp_id, destination_id, id)
WHERE kind IN ('inclusion', 'observed_event', 'finalized', 'spend_finalized');
CREATE INDEX base_audit_orphan_lookup
ON base_audit_evidence (corp_id, destination_id, (evidence->>'old_block_hash'))
WHERE kind = 'reorged';
