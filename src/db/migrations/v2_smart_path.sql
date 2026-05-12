-- Migration: v2_smart_path
-- Smart-Path fallback logging for audit and analysis.

CREATE TABLE IF NOT EXISTS smart_path_logs (
  id BIGSERIAL PRIMARY KEY,
  workflow_id UUID NOT NULL,
  device_id UUID NOT NULL,
  step_type TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL,
  analysis TEXT NOT NULL,
  recovery_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smart_path_logs_workflow
  ON smart_path_logs(workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_smart_path_logs_device
  ON smart_path_logs(device_id, created_at DESC);

-- Rollback:
-- DROP TABLE IF EXISTS smart_path_logs;
