CREATE TABLE IF NOT EXISTS device_execution_fences (
  device_id TEXT PRIMARY KEY,
  last_token BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_execution_leases (
  device_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ingress TEXT NOT NULL,
  request_key TEXT,
  fencing_token BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  cancel_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS device_execution_leases_request_key
  ON device_execution_leases (device_id, request_key)
  WHERE request_key IS NOT NULL AND state = 'active';
