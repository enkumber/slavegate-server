ALTER TABLE phone_network_incidents
  ADD COLUMN IF NOT EXISTS incident_commander TEXT NULL,
  ADD COLUMN IF NOT EXISTS remediation_owner TEXT NULL,
  ADD COLUMN IF NOT EXISTS recovery_budget INT NULL,
  ADD COLUMN IF NOT EXISTS task_retry_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS superseded_by_task_id UUID NULL REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE phone_network_incidents
  ALTER COLUMN incident_commander DROP DEFAULT,
  ALTER COLUMN incident_commander DROP NOT NULL;

ALTER TABLE phone_network_incident_events
  ADD COLUMN IF NOT EXISTS event_key TEXT NULL;

ALTER TABLE phone_network_incident_events
  DROP CONSTRAINT IF EXISTS phone_network_incident_events_event_type_check;

-- Event semantics are operator data, not a release-time constraint.

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_network_incident_events_event_key
  ON phone_network_incident_events(incident_id, event_key)
  WHERE event_key IS NOT NULL;
