-- Clear/close stale dashboard human workflow state from the run that exposed
-- RECOVERY_BUDGET_EXCEEDED after vlm_generate_comment used legacy param names.

UPDATE tasks
SET status = 'failed',
    updated_at = NOW(),
    error = COALESCE(error, 'RECOVERY_BUDGET_EXCEEDED')
WHERE routine = 'generated_workflow'
  AND status = 'running'
  AND completed_at IS NOT NULL
  AND params->>'requestKey' = 'd536b61d50299ecc2a839c1b';

UPDATE agency_workflow_runs
SET status = 'failed',
    updated_at = NOW(),
    error = COALESCE(error, 'RECOVERY_BUDGET_EXCEEDED')
WHERE request_key = 'd536b61d50299ecc2a839c1b'
  AND status = 'running'
  AND error = 'RECOVERY_BUDGET_EXCEEDED';
