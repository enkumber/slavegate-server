CREATE TABLE IF NOT EXISTS workflow_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  queue_sequence BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'working', 'done', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (workflow_id),
  UNIQUE (device_id, queue_sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_queue_one_working_per_device
  ON workflow_queue (device_id)
  WHERE status = 'working';

CREATE INDEX IF NOT EXISTS workflow_queue_fifo
  ON workflow_queue (device_id, queue_sequence)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS workflow_queue_status
  ON workflow_queue (status, device_id, queue_sequence);
