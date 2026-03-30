-- Migration: screen_detection_logs
-- Story: US-SCREEN-CASCADE
-- Date: 2026-03-29
-- Author: VOLT ⚡

-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE: screen_detection_logs
-- Logs every screen detection event from the cascade (L1/L2/L3)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS screen_detection_logs (
  id                  SERIAL PRIMARY KEY,
  device_id           TEXT NOT NULL,
  platform            TEXT NOT NULL,
  detected_screen     TEXT NOT NULL,
  confidence          NUMERIC(4,3) NOT NULL,   -- 0.000 - 1.000
  method              TEXT NOT NULL,            -- 'ui_tree', 'ocr', 'vlm'
  fallback_chain      TEXT[] NOT NULL DEFAULT '{}',
  latency_ms          INTEGER NOT NULL,
  ui_tree_nodes       INTEGER,
  ocr_text_length     INTEGER,
  vlm_tokens          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_screen_detection_device
  ON screen_detection_logs(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_screen_detection_platform
  ON screen_detection_logs(platform, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_screen_detection_method
  ON screen_detection_logs(method, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_screen_detection_created
  ON screen_detection_logs(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLEANUP FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cleanup_old_screen_detection_logs(retention_days INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM screen_detection_logs
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE screen_detection_logs IS
  'Screen detection cascade event log (L1/L2/L3). Story: US-SCREEN-CASCADE';
