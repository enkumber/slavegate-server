-- Purge the failed dashboard human preview compile that exposed the overly
-- broad read-only mutation-term validator for Reddit comments navigation.

DELETE FROM human_workflow_compile_jobs
WHERE id = '89728386-9e84-4482-85a8-e7e551231fc6'
   OR request_key = 'ada87b88a36d81065c502b12';

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'ada87b88a36d81065c502b12';
