CREATE TABLE IF NOT EXISTS phone_network_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('task', 'workflow', 'audit')),
  source_id TEXT NOT NULL,
  task_id UUID NULL REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_id TEXT NULL,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'execution'
    CHECK (category IN ('execution', 'security', 'integrity', 'availability', 'account', 'unknown')),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL,
  assigned_agent TEXT NOT NULL DEFAULT 'kraken',
  error_code TEXT NULL,
  summary TEXT NOT NULL,
  recovery_exhausted BOOLEAN NOT NULL DEFAULT TRUE,
  recovery_attempts INT NOT NULL DEFAULT 0,
  telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurrence_count INT NOT NULL DEFAULT 1,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ NULL,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_network_incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES phone_network_incidents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'reopened', 'acknowledged', 'investigating', 'shadow_check',
    'quarantined', 'routed', 'resolved', 'closed', 'note'
  )),
  actor TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_network_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_date DATE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Bucharest',
  actor TEXT NOT NULL DEFAULT 'kraken',
  status TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (audit_date, timezone, actor)
);

CREATE TABLE IF NOT EXISTS phone_network_audit_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID NOT NULL REFERENCES phone_network_audit_runs(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NULL,
  summary TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_action TEXT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (audit_run_id, finding_key)
);

CREATE INDEX IF NOT EXISTS idx_phone_network_incidents_status
  ON phone_network_incidents(status, severity, last_detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_network_incidents_device
  ON phone_network_incidents(device_id, last_detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_network_incident_events_incident
  ON phone_network_incident_events(incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_network_audit_findings_run
  ON phone_network_audit_findings(audit_run_id, severity, created_at DESC);
