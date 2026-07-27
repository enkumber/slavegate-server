-- Historical semantic job-type allowlist removed.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
