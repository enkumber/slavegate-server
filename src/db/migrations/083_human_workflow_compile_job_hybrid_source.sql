ALTER TABLE human_workflow_compile_jobs
  DROP CONSTRAINT IF EXISTS human_workflow_compile_jobs_source_check;

ALTER TABLE human_workflow_compile_jobs
  ADD CONSTRAINT human_workflow_compile_jobs_source_check
  CHECK (source IN ('cache', 'shortcut', 'llm', 'hybrid'));
