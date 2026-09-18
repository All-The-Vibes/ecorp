CREATE TABLE delegated_operation_audit (
    id bigserial PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES delegated_operations(id),
    corp_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    task_id uuid NOT NULL,
    run_id uuid,
    status text NOT NULL,
    released boolean NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
-- Transactional metadata-only history; no provider response, token or private preview.
CREATE FUNCTION audit_delegated_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.released IS DISTINCT FROM OLD.released THEN
        INSERT INTO delegated_operation_audit
            (operation_id,corp_id,actor_id,task_id,run_id,status,released)
        VALUES (NEW.id,NEW.corp_id,NEW.actor_id,NEW.task_id,NEW.run_id,NEW.status,NEW.released);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER delegated_operation_audit_trigger AFTER INSERT OR UPDATE ON delegated_operations
    FOR EACH ROW EXECUTE FUNCTION audit_delegated_operation();
