-- Purge the failed dashboard human preview compile that exposed Romanian
-- "lasi/lași un comentariu" safety-class inference as read_only.

DELETE FROM human_workflow_compile_jobs
WHERE id = '6486a672-3f8b-4aae-896a-f7d1586dd5c0'
   OR request_key = 'ada87b88a36d81065c502b12';

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'ada87b88a36d81065c502b12';
