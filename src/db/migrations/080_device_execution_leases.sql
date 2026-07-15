CREATE SEQUENCE IF NOT EXISTS device_execution_fencing_seq;
CREATE TABLE IF NOT EXISTS device_execution_leases (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  owner_id text NOT NULL, ingress text NOT NULL, request_key text NOT NULL,
  idempotency_key text, attempt integer NOT NULL DEFAULT 1,
  state text NOT NULL CHECK (state IN ('queued','active','recovering','released','cancelled','expired')),
  fencing_token bigint NOT NULL DEFAULT nextval('device_execution_fencing_seq'),
  acquired_at timestamptz, heartbeat_at timestamptz, expires_at timestamptz NOT NULL,
  cancel_requested_at timestamptz, cancel_reason text, released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_execution_one_live_lease ON device_execution_leases(device_id) WHERE state IN ('active','recovering');
CREATE TABLE IF NOT EXISTS device_execution_lease_queue (
  id bigserial PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_id text NOT NULL, ingress text NOT NULL, request_key text NOT NULL, idempotency_key text,
  attempt integer NOT NULL DEFAULT 1, deadline_at timestamptz NOT NULL, cancelled_at timestamptz, cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(device_id, request_key)
);
ALTER TABLE device_execution_lease_queue ADD COLUMN IF NOT EXISTS cancel_reason text;
CREATE INDEX IF NOT EXISTS device_execution_queue_fifo ON device_execution_lease_queue(device_id, created_at, id);
CREATE TABLE IF NOT EXISTS device_execution_lease_history (
  id bigserial PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  fencing_token bigint,
  ingress text NOT NULL,
  request_key text NOT NULL,
  event text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_execution_lease_history_device_time ON device_execution_lease_history(device_id,created_at,id);
