-- Optional mission time authority is fixed at creation. Existing untimed
-- missions and their immutable audit objects retain their original bytes.
ALTER TABLE missions ADD COLUMN deadline_policy JSONB;
CREATE INDEX missions_timed_reconciliation ON missions(id)
    WHERE deadline_policy IS NOT NULL;
ALTER TABLE missions ADD CONSTRAINT mission_deadline_policy_object CHECK (
    deadline_policy IS NULL OR ((
        jsonb_typeof(deadline_policy) = 'object'
        AND jsonb_typeof(deadline_policy->'deadline_at') = 'string'
    ) IS TRUE)
);

CREATE FUNCTION mission_deadline_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deadline_policy IS DISTINCT FROM OLD.deadline_policy THEN
        RAISE EXCEPTION 'mission deadline policy is immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER mission_deadline_immutable BEFORE UPDATE ON missions
FOR EACH ROW EXECUTE FUNCTION mission_deadline_immutable();

CREATE FUNCTION task_mission_deadline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy JSONB; old_policy JSONB;
BEGIN
    SELECT deadline_policy INTO policy FROM missions
      WHERE id=NEW.mission_id AND corp_id=NEW.corp_id;
    IF policy IS NOT NULL AND (
        (NEW.contract->>'deadline_at')::timestamptz IS DISTINCT FROM
        (policy->>'deadline_at')::timestamptz
    ) THEN
        RAISE EXCEPTION 'task must retain the immutable mission deadline';
    END IF;
    IF TG_OP='UPDATE' THEN
        SELECT deadline_policy INTO old_policy FROM missions
          WHERE id=OLD.mission_id AND corp_id=OLD.corp_id;
        IF (policy IS NOT NULL OR old_policy IS NOT NULL) AND
           (NEW.plan_key IS DISTINCT FROM OLD.plan_key OR
            NEW.mission_id IS DISTINCT FROM OLD.mission_id OR
            NEW.corp_id IS DISTINCT FROM OLD.corp_id) THEN
            RAISE EXCEPTION 'timed task cannot change its deadline scope';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER task_mission_deadline_guard BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION task_mission_deadline_guard();

-- The optional key is absent, not JSON null, for historical untimed missions.
CREATE OR REPLACE FUNCTION state_audit_fingerprint(mid UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
SELECT md5((jsonb_build_object(
    'mission',jsonb_build_array(m.corp_id,m.room_id,m.requested_by,m.description,
         m.specification_version,m.budget_tokens,m.budget_cost_microusd),
    'tasks',(SELECT jsonb_agg(jsonb_build_array(t.id,t.corp_id,t.mission_id,t.contract,
         t.contract_version,t.verification_policy) ORDER BY t.id) FROM tasks t WHERE t.mission_id=m.id),
    'pending',(SELECT jsonb_agg(jsonb_build_array(b.id,b.status,b.proposed_budget_tokens,
         b.proposed_budget_cost_microusd,b.replacement_contract,b.replacement_verification_policy)
         ORDER BY b.id) FROM mission_budget_revisions b WHERE b.mission_id=m.id AND b.status='pending')
) || CASE WHEN m.deadline_policy IS NULL THEN '{}'::jsonb
     ELSE jsonb_build_object('deadline_policy',m.deadline_policy) END)::text)
FROM missions m WHERE m.id=mid
$$;
