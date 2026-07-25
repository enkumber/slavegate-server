-- Durable, domain-neutral bridge between Phone Network and an external
-- segment-building agent. This migration contains no application, selector,
-- prompt, URL, or workflow behavior.

CREATE TABLE IF NOT EXISTS segment_build_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{24}$'),
  idempotency_key TEXT NOT NULL UNIQUE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id UUID NULL,
  intent TEXT NOT NULL CHECK (length(intent) BETWEEN 1 AND 2000),
  platform TEXT NOT NULL,
  capability_key TEXT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_agent TEXT NOT NULL,
  agent_session_key TEXT NULL,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  last_dispatch_error TEXT NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  candidate JSONB NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ NULL,
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segment_build_jobs_status
  ON segment_build_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS segment_build_job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES segment_build_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segment_build_job_events_job
  ON segment_build_job_events(job_id, created_at);

-- The OpenClaw container can receive a different private address after an app
-- restart. It therefore registers its current callback address from inside the
-- shared Umbrel network. No credentials are stored here.
CREATE TABLE IF NOT EXISTS segment_builder_dispatchers (
  id TEXT PRIMARY KEY,
  callback_url TEXT NOT NULL,
  registered_ip TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segment_builder_dispatchers_expiry
  ON segment_builder_dispatchers(expires_at);
