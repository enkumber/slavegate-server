CREATE TABLE IF NOT EXISTS job_execution_events (
  id           BIGSERIAL   PRIMARY KEY,
  job_id       UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  workflow_id  UUID,
  source       TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_execution_events_job
  ON job_execution_events(job_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_job_execution_events_device
  ON job_execution_events(device_id, created_at DESC);
