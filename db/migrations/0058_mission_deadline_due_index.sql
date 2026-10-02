-- Derived scheduling index only. The immutable policy and post-lock database
-- clock remain authoritative; existing applied deadline SQL is unchanged.
ALTER TABLE tasks ADD COLUMN deadline_cutoff_at TIMESTAMPTZ;

CREATE FUNCTION task_deadline_cutoff_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    policy JSONB;
    deadline TIMESTAMPTZ;
    reserve_seconds BIGINT;
BEGIN
    SELECT deadline_policy INTO policy FROM missions
      WHERE id=NEW.mission_id AND corp_id=NEW.corp_id;
    IF policy IS NULL THEN
        NEW.deadline_cutoff_at := NULL;
        RETURN NEW;
    END IF;
    deadline := (policy->>'deadline_at')::timestamptz;
    NEW.deadline_cutoff_at := deadline;
    IF policy->'reserve' IS NOT NULL AND policy->'reserve' <> 'null'::jsonb
       AND NOT (policy->'reserve'->'task_keys' ? NEW.plan_key) THEN
        reserve_seconds := (policy->'reserve'->>'seconds')::bigint;
        IF reserve_seconds IS NULL OR reserve_seconds <= 0 THEN
            RAISE EXCEPTION 'mission deadline reserve must be a positive duration';
        END IF;
        -- Split whole days and seconds so large supported reserves do not lose
        -- precision through a floating point count of microseconds. UTC avoids
        -- session time zone/DST changing a duration measured in seconds.
        NEW.deadline_cutoff_at := ((deadline AT TIME ZONE 'UTC') - make_interval(
            days => (reserve_seconds / 86400)::integer,
            secs => (reserve_seconds % 86400)::double precision)) AT TIME ZONE 'UTC';
    END IF;
    IF NOT isfinite(NEW.deadline_cutoff_at) THEN
        RAISE EXCEPTION 'mission deadline cutoff must be finite';
    END IF;
    RETURN NEW;
END $$;

-- Recompute even a direct write to the derived column: callers cannot renew it.
CREATE TRIGGER task_deadline_cutoff_refresh BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION task_deadline_cutoff_refresh();

CREATE INDEX tasks_due_mission_deadline_idx ON tasks(deadline_cutoff_at, mission_id, corp_id)
WHERE deadline_cutoff_at IS NOT NULL AND status <> 'completed';

-- Build before backfill, which queues the existing deferred state-audit triggers.
-- Index maintenance populates the cutoffs without weakening audit enforcement.
UPDATE tasks SET deadline_cutoff_at=NULL;
