-- Private operational idempotency cache: never included in an audit export.
CREATE TABLE state_audit_local_results (
    corp_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    request_id UUID NOT NULL,
    result JSONB NOT NULL,
    PRIMARY KEY(corp_id,actor_id,request_id),
    FOREIGN KEY(corp_id,actor_id,request_id)
        REFERENCES state_audit_decisions(corp_id,actor_id,request_id)
);
CREATE TRIGGER state_audit_local_results_immutable
BEFORE UPDATE OR DELETE ON state_audit_local_results
FOR EACH ROW EXECUTE FUNCTION state_audit_immutable();
