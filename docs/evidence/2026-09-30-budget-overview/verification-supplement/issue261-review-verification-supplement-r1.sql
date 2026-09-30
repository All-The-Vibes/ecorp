BEGIN READ ONLY;
SELECT json_build_object(
  'transaction_read_only', current_setting('transaction_read_only'),
  'database', current_database(),
  'data_directory', current_setting('data_directory'),
  'requests', COALESCE((
    SELECT json_agg(row_to_json(v) ORDER BY v.run_id)
    FROM (
      SELECT q.run_id, q.corp_id, q.task_id, t.mission_id, q.gate_type, q.gate,
        q.status, q.requested_at, q.decided_by, q.decision_note, q.decided_at,
        r.status AS run_status, r.verification_status AS run_verification_status,
        t.status AS task_status, t.verification_status AS task_verification_status
      FROM verification_requests q
      JOIN runs r ON r.id = q.run_id AND r.corp_id = q.corp_id AND r.task_id = q.task_id
      JOIN tasks t ON t.id = q.task_id AND t.corp_id = q.corp_id
      WHERE t.mission_id = '8f666cfa-9209-495b-8b6d-448eb124e1b7'::uuid
        AND q.corp_id = '00000000-0000-4000-8000-000000000001'::uuid
    ) v
  ), '[]'::json)
);
ROLLBACK;
