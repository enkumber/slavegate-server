-- Durable app-mapping recording coordination.
--
-- Schema only. Lifecycle definitions, transitions, initial state, and the
-- resource binding are provisioned operationally in PostgreSQL.

CREATE TABLE IF NOT EXISTS app_mapping_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_status TEXT NOT NULL,
  app_id TEXT NOT NULL,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_mapping_recordings_device_created
  ON app_mapping_recordings(device_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_mapping_recordings_device_open
  ON app_mapping_recordings(device_id)
  WHERE completed_at IS NULL;
