-- App Maps — store BFS-mapped app navigation graphs
-- Replaces filesystem-based persistence (DATA_DIR/app-maps/*.json)

CREATE TABLE IF NOT EXISTS app_maps (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      TEXT        NOT NULL UNIQUE,   -- Android package name (e.g. com.reddit.frontpage)
  app_name    TEXT        NOT NULL DEFAULT '',
  map_data    JSONB       NOT NULL,          -- full AppMap JSON (pages, elements, transitions)
  version     TEXT        NOT NULL DEFAULT '1.0.0',
  page_count  INT         NOT NULL DEFAULT 0,
  transition_count INT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_maps_app_id    ON app_maps(app_id);
CREATE INDEX IF NOT EXISTS idx_app_maps_updated_at ON app_maps(updated_at DESC);
