-- Migration 020: Coordinate Cache L1.5 — persistent learned coordinates
-- Replaces non-existent skill_coords_cache and coordinate_updates tables
-- referenced by skill-db.service.ts and skill.service.ts

-- ─── Coordinate cache (L1.5 persistent) ──────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_coord_lookup
  ON coordinate_cache(app, app_version, resolution, screen_type_key, element_name);

CREATE INDEX IF NOT EXISTS idx_coord_confidence
  ON coordinate_cache(confidence) WHERE confidence >= 0.7;

CREATE INDEX IF NOT EXISTS idx_coord_last_used
  ON coordinate_cache(last_used_at);
