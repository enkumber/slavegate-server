-- Purge Gmail account-creation artifacts generated before explicit Gmail app routing.
-- They can otherwise win by requestKey and keep opening the web/Chrome flow.

UPDATE human_workflow_compile_jobs
SET status = 'failed',
    cache_key = NULL,
    result = NULL,
    error = 'stale Gmail web cache purged; retry compile',
    completed_at = NOW(),
    updated_at = NOW()
WHERE request_key = '4f33ceb7077c0321073f7a6d';

DELETE FROM generated_workflow_plan_cache
WHERE request_key = '4f33ceb7077c0321073f7a6d'
   OR cache_key = 'f1bef12fdab75b5938f569c5';
