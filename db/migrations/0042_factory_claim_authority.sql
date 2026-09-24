-- An identity for this Corp's claim ledger, not a credential or distributed lock.
-- Independent databases with identical demo Corp IDs must advertise different IDs.
-- A database copied/restored as an independent lab is not a shared ledger.
ALTER TABLE corps ADD COLUMN claim_authority_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE corps ADD CONSTRAINT corps_claim_authority_non_nil
    CHECK (claim_authority_id <> '00000000-0000-0000-0000-000000000000'::uuid);
CREATE UNIQUE INDEX corps_claim_authority_id_key ON corps (claim_authority_id);

-- Supported runtime operations cannot rotate a ledger identity underneath a
-- successful preflight or a persisted claim. Independent restored databases
-- still require operator isolation; copying this UUID does not copy a lock.
CREATE FUNCTION preserve_corp_claim_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.claim_authority_id IS DISTINCT FROM OLD.claim_authority_id THEN
        RAISE EXCEPTION 'Corp claim authority is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER corps_preserve_claim_authority
    BEFORE UPDATE OF claim_authority_id ON corps
    FOR EACH ROW EXECUTE FUNCTION preserve_corp_claim_authority();
