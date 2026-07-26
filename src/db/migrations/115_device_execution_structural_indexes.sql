-- Structural indexes used by generic device-execution lifecycle queries.
-- No state, transition, action, lifecycle key, or operational policy is
-- encoded in these indexes.

CREATE INDEX IF NOT EXISTS idx_device_execution_events_type_created
  ON device_execution_events(event_type, created_at DESC);
