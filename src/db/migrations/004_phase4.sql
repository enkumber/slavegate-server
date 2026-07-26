-- Migration 004 — Phase 4: Anti-Detection + Observability
-- Run: psql $DATABASE_URL -f migrations/004_phase4.sql

BEGIN;

-- ─── Devices: cloak + dns profile storage ────────────────────────────────────

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS cloak_profile JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS dns_config    JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_canary     BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── Kill switch log ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kill_switch_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  activated    BOOLEAN     NOT NULL,                  -- true = activate, false = deactivate
  scope        TEXT        NOT NULL DEFAULT 'fleet',  -- 'fleet' | 'device:{id}' | 'platform:{name}'
  initiated_by TEXT        NOT NULL DEFAULT 'admin',
  reason       TEXT,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Detection events ─────────────────────────────────────────────────────────
-- Logged when ban-detector or canary flags anomalies

CREATE TABLE IF NOT EXISTS detection_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID        REFERENCES devices(id) ON DELETE SET NULL,
  account_id   UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  platform     TEXT,
  event_type   TEXT        NOT NULL,
  confidence   REAL        NOT NULL DEFAULT 1.0,
  details      JSONB       NOT NULL DEFAULT '{}',
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_detection_events_device ON detection_events(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_detection_events_type   ON detection_events(event_type, ts DESC);

-- ─── Canary workflows: staged rollout tracking ────────────────────────────────

CREATE TABLE IF NOT EXISTS canary_rollouts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       TEXT        REFERENCES workflow_templates(id) ON DELETE CASCADE,
  canary_device_id  UUID        REFERENCES devices(id) ON DELETE SET NULL,
  status            TEXT        NOT NULL,
  observe_until     TIMESTAMPTZ NOT NULL,          -- auto-promote after this if no failures
  error_rate        REAL,                          -- populated on completion
  total_runs        INT         NOT NULL DEFAULT 0,
  failed_runs       INT         NOT NULL DEFAULT 0,
  promoted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── System config: persistent server-side key-value ────────────────────────
-- Used by kill switch, future server settings

CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: kill switch starts inactive
INSERT INTO system_config (key, value) VALUES ('kill_switch_active', 'false')
  ON CONFLICT (key) DO NOTHING;

COMMIT;
