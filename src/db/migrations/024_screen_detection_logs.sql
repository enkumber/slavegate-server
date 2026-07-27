-- 024_screen_detection_logs.sql
-- Create screen_detection_logs table for Screen Detection Cascade telemetry.
-- Story: US-SCREEN-CASCADE

CREATE TABLE IF NOT EXISTS screen_detection_logs (
  id              SERIAL PRIMARY KEY,
  device_id       VARCHAR(64)    NOT NULL,
  platform        VARCHAR(32)    NOT NULL,
  detected_screen VARCHAR(64)    NOT NULL,
  confidence      NUMERIC(4, 3)  NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  method          VARCHAR(64)    NOT NULL,
  -- Array of strings like ['L1_failed', 'L2_success']
  fallback_chain  TEXT[]         NOT NULL DEFAULT '{}',
  latency_ms      INTEGER        NOT NULL CHECK (latency_ms >= 0),
  -- Optional raw data from each detector
  ui_tree_nodes   INTEGER,
  ocr_text_length INTEGER,
  vlm_tokens      INTEGER,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Index for device-specific queries (most common: per device, recent first)
CREATE INDEX IF NOT EXISTS idx_screen_detection_device
  ON screen_detection_logs (device_id, created_at DESC);

-- Index for method analysis (VLM call rate tracking)
CREATE INDEX IF NOT EXISTS idx_screen_detection_method
  ON screen_detection_logs (method, created_at DESC);

-- Index for screen frequency analysis
CREATE INDEX IF NOT EXISTS idx_screen_detection_screen
  ON screen_detection_logs (detected_screen, created_at DESC);

-- Index for platform-specific queries
CREATE INDEX IF NOT EXISTS idx_screen_detection_platform
  ON screen_detection_logs (platform, created_at DESC);

-- Comments
COMMENT ON TABLE  screen_detection_logs                IS 'Telemetry for Screen Detection Cascade — US-SCREEN-CASCADE';
COMMENT ON COLUMN screen_detection_logs.method          IS 'Which cascade level produced the result: ui_tree, ocr, or vlm';
COMMENT ON COLUMN screen_detection_logs.fallback_chain  IS 'Which levels were tried and their outcomes, e.g. [''L1_failed'', ''L2_success'']';
COMMENT ON COLUMN screen_detection_logs.ui_tree_nodes   IS 'Number of nodes in the A11y tree (L1)';
COMMENT ON COLUMN screen_detection_logs.ocr_text_length IS 'Character count of OCR full text (L2)';
COMMENT ON COLUMN screen_detection_logs.vlm_tokens      IS 'VLM tokens consumed (L3)';
