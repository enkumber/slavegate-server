ALTER TABLE human_workflow_compile_jobs
  ADD COLUMN IF NOT EXISTS provider_error_code TEXT;
