CREATE FUNCTION state_audit_preserve_coverage_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'audit coverage identity cannot be deleted';
    END IF;
    IF NEW.corp_id IS DISTINCT FROM OLD.corp_id
       OR NEW.mission_id IS DISTINCT FROM OLD.mission_id THEN
        RAISE EXCEPTION 'audit coverage identity cannot be replaced';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER state_audit_coverage_identity_guard
BEFORE UPDATE OR DELETE ON state_audit_coverage
FOR EACH ROW EXECUTE FUNCTION state_audit_preserve_coverage_identity();
