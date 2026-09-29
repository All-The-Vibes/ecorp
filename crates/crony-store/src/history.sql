-- Every relationship explicitly matches Corp. Known aggregate links must be
-- currently visible; payload UUIDs never supply navigation or authorization.
-- Share the repeatedly used visibility relations. Forced inlining expands the
-- event/cause joins into a large planning tree even for a small result page.
WITH visible_rooms AS (
    SELECT r.id FROM rooms r
    JOIN room_memberships rm ON rm.room_id = r.id AND rm.actor_id = $2
    WHERE r.corp_id = $1
), visible_missions AS (
    SELECT m.id, m.room_id, m.title, m.status, m.created_at,
           a.id AS actor_id, a.name AS actor_name
    FROM missions m JOIN visible_rooms r ON r.id = m.room_id
    LEFT JOIN actors a ON a.id = m.requested_by AND a.corp_id = m.corp_id
    WHERE m.corp_id = $1
), visible_tasks AS (
    SELECT t.id, m.id AS mission_id, m.room_id, t.title, t.status, t.created_at,
           a.id AS actor_id, a.name AS actor_name
    FROM tasks t JOIN visible_missions m ON m.id = t.mission_id
    LEFT JOIN agents agent ON agent.id = t.assigned_agent_id AND agent.corp_id = t.corp_id
    LEFT JOIN actors a ON a.id = agent.actor_id AND a.corp_id = t.corp_id
    WHERE t.corp_id = $1
), visible_runs AS (
    SELECT run.id, t.mission_id, t.id AS task_id, t.room_id, t.title,
           run.status, run.created_at, a.id AS actor_id, a.name AS actor_name
    FROM runs run JOIN visible_tasks t ON t.id = run.task_id
    JOIN agents agent ON agent.id = run.agent_id AND agent.corp_id = run.corp_id
    JOIN actors a ON a.id = agent.actor_id AND a.corp_id = run.corp_id
    WHERE run.corp_id = $1
), visible_events AS (
    SELECT e.id, e.seq, e.created_at, e.causation_id,
           CASE WHEN e.type = ANY($16::text[]) THEN e.type ELSE 'other' END AS status,
           coalesce(e.room_id, mr.room_id, tr.room_id, rr.room_id, er.id) AS room_id,
           coalesce(mr.id, tr.mission_id, rr.mission_id) AS mission_id,
           coalesce(tr.id, rr.task_id) AS task_id, rr.id AS run_id,
           a.id AS actor_id, a.name AS actor_name
    FROM events e
    LEFT JOIN visible_missions mr ON e.aggregate_type = 'mission' AND mr.id = e.aggregate_id
    LEFT JOIN visible_tasks tr ON e.aggregate_type = 'task' AND tr.id = e.aggregate_id
    LEFT JOIN visible_runs rr ON e.aggregate_type = 'run' AND rr.id = e.aggregate_id
    LEFT JOIN visible_rooms er ON e.aggregate_type = 'room' AND er.id = e.aggregate_id
    LEFT JOIN actors a ON a.id = e.actor_id AND a.corp_id = e.corp_id
    WHERE e.corp_id = $1 AND e.visibility IN ('corp', 'room')
      AND (e.room_id IS NULL OR EXISTS (SELECT 1 FROM visible_rooms r WHERE r.id = e.room_id))
      AND (e.visibility = 'corp' OR coalesce(e.room_id, mr.room_id, tr.room_id, rr.room_id, er.id) IS NOT NULL)
      AND CASE e.aggregate_type
        WHEN 'mission' THEN mr.id IS NOT NULL AND (e.room_id IS NULL OR e.room_id = mr.room_id)
        WHEN 'task' THEN tr.id IS NOT NULL AND (e.room_id IS NULL OR e.room_id = tr.room_id)
        WHEN 'run' THEN rr.id IS NOT NULL AND (e.room_id IS NULL OR e.room_id = rr.room_id)
        WHEN 'room' THEN er.id IS NOT NULL AND (e.room_id IS NULL OR e.room_id = er.id)
        WHEN 'corp' THEN e.aggregate_id = $1
        ELSE true
      END
), records AS NOT MATERIALIZED (
    SELECT 'mission' AS kind, id, room_id, title, status, created_at, actor_id, actor_name,
           id AS mission_id, NULL::uuid AS task_id, NULL::uuid AS run_id,
           NULL::bigint AS seq, NULL::uuid AS causation_id
    FROM visible_missions
    UNION ALL
    SELECT 'task', id, room_id, title, status, created_at, actor_id, actor_name,
           mission_id, id, NULL::uuid, NULL::bigint, NULL::uuid
    FROM visible_tasks
    UNION ALL
    SELECT 'run', id, room_id, title, status, created_at, actor_id, actor_name,
           mission_id, task_id, id, NULL::bigint, NULL::uuid
    FROM visible_runs
    UNION ALL
    SELECT 'event', id, room_id, status, status, created_at, actor_id, actor_name,
           mission_id, task_id, run_id, seq, causation_id
    FROM visible_events
), labels AS NOT MATERIALIZED (
    SELECT records.*,
      CASE WHEN kind = 'event' OR status = ANY($17::text[]) THEN status ELSE 'unknown' END AS safe_status,
      btrim(left(regexp_replace(title, U&'[\0001-\001F\007F-\009F\202A-\202E\2066-\2069]', '', 'g'), 240)) AS safe_title
    FROM records
), page AS (
    SELECT * FROM labels
    WHERE kind = $3
      AND ($4::uuid IS NULL OR room_id = $4)
      AND ($5::uuid IS NULL OR mission_id = $5)
      AND ($6::uuid IS NULL OR actor_id = $6)
      AND ($7::uuid IS NULL OR id = $7)
      AND ($8::text IS NULL OR safe_status = $8)
      -- strpos gives literal substring matching: % and _ are not wildcards.
      -- Unknown event types are already 'other'; no hidden-type/payload oracle.
      AND ($9 = '' OR strpos(lower(safe_title), lower($9)) > 0
           OR strpos(id::text, lower($9)) > 0 OR strpos(lower(safe_status), lower($9)) > 0)
      AND created_at <= $10
      AND (seq IS NULL OR seq <= $11)
      AND ($12::bigint IS NULL OR seq < $12)
      AND ($13::timestamptz IS NULL OR (created_at, id) < ($13, $14::uuid))
    ORDER BY seq DESC NULLS LAST, created_at DESC, id DESC
    LIMIT $15
)
SELECT page.id, page.room_id, page.safe_title AS title, page.safe_status AS status, page.created_at,
       page.actor_id, page.actor_name, page.mission_id, page.task_id, page.run_id, page.seq,
       cause.id AS cause_id
FROM page LEFT JOIN visible_events cause ON cause.id = page.causation_id AND cause.seq < page.seq
ORDER BY page.seq DESC NULLS LAST, page.created_at DESC, page.id DESC
