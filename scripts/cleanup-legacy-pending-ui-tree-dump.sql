\set ON_ERROR_STOP on

-- Controlled one-time cleanup for the six legacy ui_tree_dump jobs observed
-- before the generated-workflow cache repair. The operator must supply an
-- audited UTC cutoff that excludes every current queue entry:
--
--   psql "$DATABASE_URL" \
--     --set=cleanup_before='2026-07-18T00:00:00Z' \
--     --file=scripts/cleanup-legacy-pending-ui-tree-dump.sql
--
-- The transaction aborts unless the predicate identifies exactly six rows.

BEGIN;

CREATE TEMP TABLE legacy_ui_tree_dump_cleanup_targets ON COMMIT DROP AS
SELECT id, device_id, created_at
FROM jobs
WHERE job_type = 'ui_tree_dump'
  AND status = 'pending'
  AND started_at IS NULL
  AND created_at < :'cleanup_before'::timestamptz
ORDER BY created_at, id
FOR UPDATE;

DO $$
DECLARE
  target_count integer;
BEGIN
  SELECT COUNT(*) INTO target_count
  FROM legacy_ui_tree_dump_cleanup_targets;

  IF target_count <> 6 THEN
    RAISE EXCEPTION
      'legacy ui_tree_dump cleanup expected exactly 6 rows, found %',
      target_count;
  END IF;
END
$$;

UPDATE jobs AS job
SET status = 'cancelled',
    completed_at = NOW(),
    error = 'Controlled cleanup: legacy pending ui_tree_dump never started'
FROM legacy_ui_tree_dump_cleanup_targets AS target
WHERE job.id = target.id;

UPDATE command_log AS audit
SET result_status = 'cancelled',
    result_payload = jsonb_build_object(
      'reason', 'legacy_pending_ui_tree_dump_cleanup',
      'cleanupBefore', :'cleanup_before'::text
    )
FROM legacy_ui_tree_dump_cleanup_targets AS target
WHERE audit.job_id = target.id
  AND audit.result_status IS NULL;

SELECT
  target.id AS job_id,
  target.device_id,
  target.created_at,
  job.status,
  job.completed_at,
  job.error
FROM legacy_ui_tree_dump_cleanup_targets AS target
JOIN jobs AS job ON job.id = target.id
ORDER BY target.created_at, target.id;

COMMIT;
