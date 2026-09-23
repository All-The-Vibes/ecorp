-- Additive private replay identities. Retained decisions, receipts, request
-- UUIDs and migration checksums are never rewritten. The native Corp/actor
-- authority and Factory operation are validated before establishing an alias.
CREATE TABLE state_audit_factory_replay_aliases (
    corp_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    canonical_request_id UUID NOT NULL,
    request_id UUID NOT NULL,
    PRIMARY KEY(corp_id,actor_id,canonical_request_id),
    UNIQUE(corp_id,actor_id,request_id),
    FOREIGN KEY(corp_id,actor_id,request_id)
        REFERENCES state_audit_decisions(corp_id,actor_id,request_id)
);
CREATE TRIGGER state_audit_factory_replay_aliases_immutable
BEFORE UPDATE OR DELETE ON state_audit_factory_replay_aliases
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
