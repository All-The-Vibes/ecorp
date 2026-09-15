CREATE FUNCTION state_audit_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'audit ledger identity cannot be deleted'; END IF;
    IF NEW.corp_id IS DISTINCT FROM OLD.corp_id OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'audit ledger identity cannot be replaced';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER state_audit_identity_guard BEFORE UPDATE OR DELETE ON state_audit_ledgers
FOR EACH ROW EXECUTE FUNCTION state_audit_preserve_identity();

CREATE OR REPLACE FUNCTION state_audit_check_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_mid UUID; after_mid UUID; mid UUID; expected TEXT;
BEGIN
    IF TG_TABLE_NAME='missions' THEN
        IF TG_OP <> 'INSERT' THEN before_mid=OLD.id; END IF;
        IF TG_OP <> 'DELETE' THEN after_mid=NEW.id; END IF;
    ELSE
        IF TG_OP <> 'INSERT' THEN before_mid=OLD.mission_id; END IF;
        IF TG_OP <> 'DELETE' THEN after_mid=NEW.mission_id; END IF;
    END IF;
    FOR mid IN SELECT DISTINCT unnest(ARRAY[before_mid,after_mid]) LOOP
        SELECT fingerprint INTO expected FROM state_audit_coverage WHERE mission_id=mid;
        IF expected IS NOT NULL AND expected IS DISTINCT FROM state_audit_fingerprint(mid) THEN
            RAISE EXCEPTION 'covered governance changed without an atomic state audit decision';
        END IF;
    END LOOP;
    RETURN NULL;
END $$;
