-- 011_marketing_agency.sql
-- Marketing Agency Schema (P0)
-- Adaugă tabelele necesare pentru Nautilus și echipa de marketing

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLIENTS — Clienții agenției
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS clients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  strategy        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- strategy conține: goal, target_audience, brand_voice, kpis, content_direction, competitors, budget_level
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_active ON clients(active);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACCOUNTS — Extindere pentru marketing
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adăugăm coloane noi la tabela accounts existentă

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'farming' CHECK (type IN ('business', 'farming'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS strategy JSONB DEFAULT '{}'::jsonb;
-- strategy conține: phase, daily_limits, seeds, engagement_windows
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '{}'::jsonb;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS flags JSONB DEFAULT '{}'::jsonb;
-- flags conține: soft_blocked_until, rate_limited_until, paused, pause_reason, anomaly_detected

CREATE INDEX IF NOT EXISTS idx_accounts_client ON accounts(client_id);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MATERIALS — Materiale uploadate de Dan
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS materials (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        REFERENCES clients(id) ON DELETE CASCADE,
  account_id      UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  type            TEXT        NOT NULL CHECK (type IN ('image', 'video', 'text')),
  url             TEXT        NOT NULL,
  description     TEXT,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used            BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_materials_client ON materials(client_id);
CREATE INDEX IF NOT EXISTS idx_materials_account ON materials(account_id);
CREATE INDEX IF NOT EXISTS idx_materials_used ON materials(used);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CONTENT_BRIEFS — Brief-uri generate de Marketer pentru Siren
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_briefs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by      TEXT        NOT NULL DEFAULT 'marketer',
  brief           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- brief conține: type, tone, topics, hashtags_strategy
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_briefs_account ON content_briefs(account_id);
CREATE INDEX IF NOT EXISTS idx_content_briefs_created ON content_briefs(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- POSTS — Postări create de Siren, aprobate de Dan, publicate de Hydra
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS posts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform        TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending_approval'
                              CHECK (status IN ('pending_approval', 'approved', 'rejected', 'published')),
  content         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- content conține: media_url, caption, hashtags, thumbnail_url
  created_by      TEXT        NOT NULL DEFAULT 'siren',
  brief_id        UUID        REFERENCES content_briefs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at     TIMESTAMPTZ,
  published_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TASKS — Task-uri create de Tactician pentru Kraken/Hydra
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        TEXT,
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  scheduled_time  TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'running', 'completed', 'failed', 'paused')),
  routine         TEXT        NOT NULL,
  params          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_device ON tasks(device_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- EXECUTION_LOGS — Loguri de execuție scrise de Hydra
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS execution_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID        REFERENCES tasks(id) ON DELETE SET NULL,
  device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_data        JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_task ON execution_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_logs_device ON execution_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_execution_logs_timestamp ON execution_logs(timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- REPORTS — Rapoarte generate de Business Analyst
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('daily_analytics', 'weekly', 'anomaly')),
  period          TEXT        NOT NULL,
  data            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- NAVIGATION_LOGS — Loguri de navigare pentru cascade tap/verify
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS navigation_logs (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id               UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  app                     TEXT        NOT NULL,
  element_name            TEXT        NOT NULL,
  method_used             TEXT        NOT NULL CHECK (method_used IN ('coords', 'ui_tree', 'vision')),
  method_attempted_first  TEXT,
  fallback_chain          JSONB       DEFAULT '[]'::jsonb,
  coords_used             JSONB,
  verified                BOOLEAN     NOT NULL DEFAULT FALSE,
  verify_method           TEXT        CHECK (verify_method IN ('ui_tree', 'vision')),
  timestamp               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_navigation_logs_device ON navigation_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_navigation_logs_app ON navigation_logs(app);
CREATE INDEX IF NOT EXISTS idx_navigation_logs_timestamp ON navigation_logs(timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- COORDINATE_UPDATES — Actualizări de coordonate învățate de Hydra
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS coordinate_updates (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app                 TEXT        NOT NULL,
  element_name        TEXT        NOT NULL,
  device_id           UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  old_coords          JSONB,
  new_coords          JSONB       NOT NULL,
  app_version         TEXT        NOT NULL,
  screen_resolution   TEXT        NOT NULL,
  occurrence_count    INT         NOT NULL DEFAULT 1,
  applied_to_skill    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_coordinate_updates_app ON coordinate_updates(app, element_name);
CREATE INDEX IF NOT EXISTS idx_coordinate_updates_device ON coordinate_updates(device_id);
CREATE INDEX IF NOT EXISTS idx_coordinate_updates_applied ON coordinate_updates(applied_to_skill);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MAPPING_REPORTS — Rapoarte first-run mapping
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mapping_reports (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id           UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  app                 TEXT        NOT NULL,
  app_version         TEXT        NOT NULL,
  elements_mapped     INT         NOT NULL DEFAULT 0,
  elements_failed     INT         NOT NULL DEFAULT 0,
  unmapped_elements   JSONB       DEFAULT '[]'::jsonb,
  screen_resolution   TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mapping_reports_device ON mapping_reports(device_id);
CREATE INDEX IF NOT EXISTS idx_mapping_reports_app ON mapping_reports(app);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SKILL_UPDATE_JOBS — Jobs pentru Skill Updater
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS skill_update_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app             TEXT        NOT NULL,
  elements        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  failure_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_skill_update_jobs_status ON skill_update_jobs(status);
CREATE INDEX IF NOT EXISTS idx_skill_update_jobs_app ON skill_update_jobs(app);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SKILL_PATCHES — Istoric patch-uri aplicate de Skill Updater
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS skill_patches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app             TEXT        NOT NULL,
  element         TEXT        NOT NULL,
  old_selector    TEXT,
  new_selector    TEXT        NOT NULL,
  confidence      REAL        NOT NULL,
  backup_path     TEXT        NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_skill_patches_app ON skill_patches(app);
CREATE INDEX IF NOT EXISTS idx_skill_patches_applied ON skill_patches(applied_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEVICES — Adăugăm flags pentru Ops Monitor
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE devices ADD COLUMN IF NOT EXISTS flags JSONB DEFAULT '{}'::jsonb;
-- flags conține: offline_since, needs_attention, last_health_check

-- ═══════════════════════════════════════════════════════════════════════════════
-- Done
-- ═══════════════════════════════════════════════════════════════════════════════
