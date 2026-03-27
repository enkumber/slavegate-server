-- Phone Network — Database Schema v3.1
-- Bazat pe ARCHITECTURE_AUDIT_v2.md §10
-- Toate timestamp-urile sunt UTC.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Devices ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hardware_uuid    TEXT        UNIQUE,            -- nullable since 005_imei_auth (was mandatory)
  imei             TEXT        UNIQUE,            -- IMEI or persistent fallback ID (primary auth identifier)
  friendly_name    TEXT        NOT NULL DEFAULT '',
  model            TEXT,
  android_version  TEXT,
  agent_version    TEXT,
  -- Locație fizică a device-ului (WiFi, IP nativ per locație)
  -- Format: "loc_a", "loc_b" etc. Constraint: max 1 cont per platformă per locație.
  location_id      TEXT,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','approved','online','offline','maintenance','revoked')),
  last_seen_at     TIMESTAMPTZ,
  last_ip          INET,
  health           JSONB       DEFAULT '{}',
  is_canary        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_status    ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);

-- ─── Auth tokens (dual token: access 24h + refresh 30d) ───────────────────────
-- Plain tokens NEVER stored — SHA256 hashes only.
CREATE TABLE IF NOT EXISTS device_tokens (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id            UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  access_token_hash    TEXT,                          -- SHA256(access_token)
  access_expires_at    TIMESTAMPTZ,
  refresh_token_hash   TEXT,                          -- SHA256(refresh_token)
  refresh_expires_at   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id)   -- one active token set per device
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_access  ON device_tokens(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_device_tokens_refresh ON device_tokens(refresh_token_hash);

-- ─── Registration codes (one-time-use, admin-generated) ───────────────────────
CREATE TABLE IF NOT EXISTS registration_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT        NOT NULL UNIQUE,  -- 8 char alphanumeric, case-insensitive
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  used_by    UUID        REFERENCES devices(id),
  used_at    TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reg_codes_code ON registration_codes(code);

-- ─── Token revocation (Redis is primary — this is for persistence/audit) ───────
-- Redis: SET revoked:<token_hash> EX <ttl_seconds>
-- This table is for auditability and Redis recovery after restart.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash TEXT        PRIMARY KEY,
  device_id  UUID        REFERENCES devices(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL   -- used for cleanup job
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- ─── Jobs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  job_type     TEXT        NOT NULL
                           CHECK (job_type IN (
                             'tap','swipe','type_text','scroll','screenshot',
                             'screen_record','open_app','close_app','ui_tree_dump',
                             'pm_uninstall','reboot','ota_update'
                           )),
  params       JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','running','completed','failed','cancelled','timeout')),
  output       JSONB,
  error        TEXT,
  duration_ms  INTEGER,
  timeout_ms   INTEGER     NOT NULL DEFAULT 30000,
  requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_device_id  ON jobs(device_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);

-- ─── Command Audit Log (server-side ONLY — generated from dispatch + JOB_RESULT) ──────
-- Audit log is NEVER transmitted by device. Device keeps ZERO permanent log.
-- At dispatch: server writes command_type, params, device_id, job_id.
-- At JOB_RESULT: server updates result_status, result_payload, duration.
-- Append-mostly. Do NOT delete records.
CREATE TABLE IF NOT EXISTS command_log (
  id              BIGSERIAL   PRIMARY KEY,
  device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  job_id          UUID        REFERENCES jobs(id) ON DELETE SET NULL,
  command_type    TEXT        NOT NULL,
  command_raw     TEXT,       -- human-readable command string for audit readability
  command_params  JSONB,
  result_status   TEXT,
  result_payload  JSONB,
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_command_log_device ON command_log(device_id, executed_at DESC);

-- ─── OTA Deployments ──────────────────────────────────────────────────────────
-- target_devices UUID[] REMOVED — replaced by junction table (proper FK, per-device status)
CREATE TABLE IF NOT EXISTS ota_deployments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_code      INT         NOT NULL,
  version_name      TEXT        NOT NULL,
  apk_url           TEXT        NOT NULL,
  apk_sha256        TEXT        NOT NULL,
  apk_signature     TEXT        NOT NULL,
  changelog         TEXT        NOT NULL DEFAULT '',
  canary_device_id  UUID        REFERENCES devices(id),  -- NULL = no canary phase
  status            TEXT        NOT NULL DEFAULT 'staged'
                                CHECK (status IN ('staged','canary','rolling','completed','failed','rolled_back')),
  mandatory         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OTA Target Devices — junction table (v3.1: replaces UUID[] array column)
-- NULL deployment targets = broadcast to all approved/online devices (handled in service layer)
CREATE TABLE IF NOT EXISTS ota_deployment_devices (
  deployment_id UUID        NOT NULL REFERENCES ota_deployments(id) ON DELETE CASCADE,
  device_id     UUID        NOT NULL REFERENCES devices(id),
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','installing','success','failed','rolled_back')),
  installed_at  TIMESTAMPTZ,
  PRIMARY KEY (deployment_id, device_id)
);

-- ─── Workflow Templates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_templates (
  id                           TEXT        PRIMARY KEY,
  platform                     TEXT        NOT NULL,
  definition                   JSONB       NOT NULL,   -- DAG definition
  parser_version               TEXT,
  compatible_app_versions      TEXT[],
  data_retention_days          INT         NOT NULL DEFAULT 90,
  default_verification_strategy TEXT       NOT NULL DEFAULT 'local_with_screenshot'
                                           CHECK (default_verification_strategy IN (
                                             'local_only', 'local_with_screenshot',
                                             'full_cascade', 'vlm_required'
                                           )),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Workflow Executions — Phase 2 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  TEXT        REFERENCES workflow_templates(id),
  account_id   UUID,       -- FK to accounts added in Phase 3 migration
  device_id    UUID        REFERENCES devices(id) ON DELETE SET NULL,
  status       TEXT        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
  current_step INT         NOT NULL DEFAULT 0,
  total_steps  INT,
  checkpoint   JSONB       NOT NULL DEFAULT '{}',
  hbe_params   JSONB       NOT NULL DEFAULT '{}',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_device ON workflows(device_id);

-- ─── Accounts — Phase 3 ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              TEXT        NOT NULL
                                    CHECK (platform IN ('instagram','tiktok','reddit','twitter','facebook')),
  username              TEXT        NOT NULL,
  encryption_key_ref    TEXT,       -- Vault reference: "vault:accounts/{id}/creds" — NEVER plaintext
  -- credentials_encrypted NOT stored server-side — device encrypts, Vault holds key
  device_id             UUID        REFERENCES devices(id) ON DELETE SET NULL,
  -- No proxy_config — WiFi with native IP per physical location (v3)
  status                TEXT        NOT NULL DEFAULT 'created'
                                    CHECK (status IN (
                                      'created',       -- just added
                                      'warming_up',    -- 0-14 days conservative behavior
                                      'active',        -- normal operation
                                      'paused',        -- temporarily suspended
                                      'rate_limited',  -- hit rate limit, auto-resume
                                      'challenged',    -- CAPTCHA / phone verify needed
                                      'banned'         -- terminal
                                    )),
  simulated_timezone    TEXT        NOT NULL DEFAULT 'Europe/Bucharest',
  session_count         INT         NOT NULL DEFAULT 0,
  total_actions         INT         NOT NULL DEFAULT 0,
  last_active_at        TIMESTAMPTZ,
  notes                 TEXT,       -- operator notes, ban reason, challenge details
  rate_limit_until      TIMESTAMPTZ,-- non-null while status='rate_limited'; cron resets to 'active'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, username),
  -- Max 1 account per platform per device (enforced at DB + service layer)
  UNIQUE (platform, device_id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_platform_status ON accounts(platform, status);

-- ─── Extracted Data — Phase 3 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS extracted_data (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform       TEXT        NOT NULL,
  content_type   TEXT        NOT NULL,
  content_hash   TEXT        NOT NULL UNIQUE,  -- SHA256(platform+author+text) dedup key
  author         TEXT,
  text_content   TEXT,
  engagement     JSONB       NOT NULL DEFAULT '{}',
  media_urls     JSONB       NOT NULL DEFAULT '[]',
  confidence     REAL        NOT NULL DEFAULT 1.0,
  parser_version TEXT,
  raw_data       JSONB,      -- Optional: raw node data for re-parsing
  workflow_id    UUID        REFERENCES workflows(id) ON DELETE SET NULL,
  device_id      UUID        REFERENCES devices(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extracted_platform_date ON extracted_data(platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extracted_hash          ON extracted_data(content_hash);

-- ─── VLM Usage Log (Phase 3 — for token cost tracking and cascade analytics) ──
CREATE TABLE IF NOT EXISTS vlm_usage_log (
  id           BIGSERIAL   PRIMARY KEY,
  device_id    UUID        REFERENCES devices(id) ON DELETE CASCADE,
  workflow_id  UUID        REFERENCES workflows(id) ON DELETE SET NULL,
  job_id       TEXT        NOT NULL,
  request_type TEXT        NOT NULL,   -- "element_find" | "verify_action" | "screen_understand"
  provider     TEXT        NOT NULL,   -- "google" | "openai" | "local"
  model        TEXT        NOT NULL,
  input_tokens INT         NOT NULL DEFAULT 0,
  output_tokens INT        NOT NULL DEFAULT 0,
  latency_ms   INT         NOT NULL DEFAULT 0,
  success      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vlm_usage_device ON vlm_usage_log(device_id, created_at DESC);

-- ─── Vision Config (server-side runtime config for VLM provider — Phase 3) ───
-- Single row: id='default'. Updated via dashboard or API.
CREATE TABLE IF NOT EXISTS vision_config (
  id                TEXT        PRIMARY KEY DEFAULT 'default',
  provider          TEXT        NOT NULL DEFAULT 'google',
  model             TEXT        NOT NULL DEFAULT 'gemini-2.0-flash',
  endpoint          TEXT        NOT NULL DEFAULT 'https://generativelanguage.googleapis.com/v1beta',
  api_key_ref       TEXT        NOT NULL DEFAULT 'vault:vision/google_api_key',
  max_tokens        INT         NOT NULL DEFAULT 512,
  temperature       REAL        NOT NULL DEFAULT 0.1,
  timeout_ms        INT         NOT NULL DEFAULT 10000,
  fallback_provider TEXT,
  fallback_endpoint TEXT,
  fallback_model    TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default vision config (upsert — safe to run multiple times)
INSERT INTO vision_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- ─── Cleanup job placeholder ──────────────────────────────────────────────────
-- SELECT delete_expired_registration_codes() → DELETE WHERE expires_at < NOW() AND NOT used
-- SELECT delete_expired_revoked_tokens()    → DELETE WHERE expires_at < NOW()
-- Retention policy for extracted_data configurable via env (default 90 days)


-- ─── Coordinate Cache L1.5 — persistent learned coordinates ─────────────────
-- Added: migration 020

CREATE TABLE IF NOT EXISTS coordinate_cache (
  id                BIGSERIAL   PRIMARY KEY,
  app               TEXT        NOT NULL,
  app_version       TEXT        NOT NULL,
  resolution        TEXT        NOT NULL,
  density           REAL,
  device_class      TEXT        NOT NULL DEFAULT 'phone',
  orientation       TEXT        NOT NULL DEFAULT 'portrait',
  font_scale_bucket TEXT        NOT NULL DEFAULT 'normal',
  screen_type_key   TEXT        NOT NULL DEFAULT 'unknown',
  element_name      TEXT        NOT NULL,
  x                 REAL        NOT NULL,
  y                 REAL        NOT NULL,
  width             REAL,
  height            REAL,
  success_count     INT         NOT NULL DEFAULT 1,
  fail_count        INT         NOT NULL DEFAULT 0,
  confidence        REAL        NOT NULL DEFAULT 1.0,
  learn_method      TEXT        NOT NULL DEFAULT 'ui_tree',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app, app_version, resolution, device_class, orientation, font_scale_bucket, screen_type_key, element_name)
);

CREATE INDEX IF NOT EXISTS idx_coord_lookup     ON coordinate_cache(app, app_version, resolution, screen_type_key, element_name);
CREATE INDEX IF NOT EXISTS idx_coord_confidence ON coordinate_cache(confidence) WHERE confidence >= 0.7;
CREATE INDEX IF NOT EXISTS idx_coord_last_used  ON coordinate_cache(last_used_at);

CREATE TABLE IF NOT EXISTS navigation_logs (
  id                     BIGSERIAL   PRIMARY KEY,
  device_id              UUID        REFERENCES devices(id) ON DELETE CASCADE,
  app                    TEXT        NOT NULL,
  element_name           TEXT        NOT NULL,
  method_used            TEXT        NOT NULL,
  method_attempted_first TEXT,
  fallback_chain         JSONB       DEFAULT '[]',
  coords_used            JSONB,
  verified               BOOLEAN     DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_navlog_device ON navigation_logs(device_id, created_at DESC);

-- system_config: key-value store for server-side persistent state
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seed: kill switch starts inactive
INSERT INTO system_config (key, value) VALUES ('kill_switch_active', 'false')
  ON CONFLICT (key) DO NOTHING;
