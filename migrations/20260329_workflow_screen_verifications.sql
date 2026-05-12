-- Migration: workflow_screen_verifications
-- Story: US-WORKFLOW-SCREEN-VERIFY
-- Date: 2026-03-29
-- Author: FORGE 🔨

-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE: workflow_screen_verifications
-- Tracks screen detection verification results after each workflow step
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workflow_screen_verifications (
  id                    SERIAL PRIMARY KEY,
  workflow_id           UUID NOT NULL,  -- references workflows.id (UUID type)
  step_index            INTEGER NOT NULL,
  detected_screen       TEXT NOT NULL,
  detected_confidence   NUMERIC(4,3) NOT NULL,  -- 0.000 - 1.000
  detection_method      TEXT NOT NULL,           -- 'ui_tree', 'ocr', 'vlm'
  expected_screens      TEXT[] NOT NULL,         -- Array of expected ScreenIds
  match                 BOOLEAN NOT NULL,
  latency_ms            INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Foreign key to workflows table (if exists)
-- Note: Using soft reference to avoid migration order issues
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows') THEN
    ALTER TABLE workflow_screen_verifications
      ADD CONSTRAINT fk_workflow_screen_verify_wf 
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Primary lookup by workflow
CREATE INDEX IF NOT EXISTS idx_wf_screen_verify_workflow 
  ON workflow_screen_verifications(workflow_id);

-- Filter by match status (for failure analysis)
CREATE INDEX IF NOT EXISTS idx_wf_screen_verify_match 
  ON workflow_screen_verifications(match) 
  WHERE match = false;

-- Time-based queries (for metrics, cleanup)
CREATE INDEX IF NOT EXISTS idx_wf_screen_verify_created 
  ON workflow_screen_verifications(created_at);

-- Method analysis
CREATE INDEX IF NOT EXISTS idx_wf_screen_verify_method 
  ON workflow_screen_verifications(detection_method);

-- Composite for dashboard queries
CREATE INDEX IF NOT EXISTS idx_wf_screen_verify_method_match_time 
  ON workflow_screen_verifications(detection_method, match, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEW: workflow_screen_verification_stats
-- Aggregated stats for observability dashboards
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW workflow_screen_verification_stats AS
SELECT 
  DATE(created_at) AS date,
  detection_method,
  COUNT(*) AS total_verifications,
  SUM(CASE WHEN match THEN 1 ELSE 0 END) AS matches,
  SUM(CASE WHEN NOT match THEN 1 ELSE 0 END) AS mismatches,
  ROUND(AVG(CASE WHEN match THEN 1 ELSE 0 END)::numeric * 100, 2) AS match_rate_pct,
  ROUND(AVG(latency_ms)::numeric, 2) AS avg_latency_ms,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms)::numeric, 0) AS p50_latency_ms,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric, 0) AS p95_latency_ms,
  ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)::numeric, 0) AS p99_latency_ms,
  ROUND(AVG(detected_confidence)::numeric * 100, 2) AS avg_confidence_pct
FROM workflow_screen_verifications
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at), detection_method
ORDER BY date DESC, detection_method;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEW: workflow_screen_top_failures
-- Top failing screen transitions (for debugging)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW workflow_screen_top_failures AS
SELECT 
  detected_screen,
  expected_screens[1] AS primary_expected,  -- First expected screen
  COUNT(*) AS failure_count,
  ROUND(AVG(detected_confidence)::numeric * 100, 2) AS avg_confidence_pct,
  MODE() WITHIN GROUP (ORDER BY detection_method) AS most_common_method,
  MAX(created_at) AS last_occurrence
FROM workflow_screen_verifications
WHERE NOT match
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY detected_screen, expected_screens[1]
ORDER BY failure_count DESC
LIMIT 20;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEW: workflow_verification_by_workflow
-- Per-workflow stats
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW workflow_verification_by_workflow AS
SELECT 
  workflow_id,
  COUNT(*) AS total_steps_verified,
  SUM(CASE WHEN match THEN 1 ELSE 0 END) AS successful_verifications,
  ROUND(AVG(CASE WHEN match THEN 1 ELSE 0 END)::numeric * 100, 2) AS success_rate_pct,
  ROUND(AVG(latency_ms)::numeric, 2) AS avg_latency_ms,
  MIN(created_at) AS first_verification,
  MAX(created_at) AS last_verification
FROM workflow_screen_verifications
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY workflow_id
ORDER BY last_verification DESC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLEANUP FUNCTION (for cron)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cleanup_old_screen_verifications(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM workflow_screen_verifications
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_screen_verifications IS 
  'Cleanup old screen verification records. Call from cron: SELECT cleanup_old_screen_verifications(30);';

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE workflow_screen_verifications IS 
  'Screen detection verification results after workflow steps. Story: US-WORKFLOW-SCREEN-VERIFY';
