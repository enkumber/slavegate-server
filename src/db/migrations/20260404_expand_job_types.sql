-- Remove restrictive job_type constraint — validation is done at app level
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
