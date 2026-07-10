ALTER TABLE human_workflow_compile_jobs
  ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE agency_workflow_runs
  ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE tasks
  ALTER COLUMN account_id DROP NOT NULL;
