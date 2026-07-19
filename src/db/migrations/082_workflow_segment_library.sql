-- Automatically learned, telemetry-validated workflow segments.
-- Categories are deliberately explicit: Android/device navigation lives under
-- system/android, while product navigation is isolated per Android package.

CREATE TABLE IF NOT EXISTS workflow_segment_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  package_name TEXT NULL,
  placement TEXT NOT NULL DEFAULT 'body',
  semantic_tokens TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  steps JSONB NOT NULL,
  source_cache_key TEXT NOT NULL,
  source_workflow_id TEXT NOT NULL,
  source_workflow_version TEXT NOT NULL,
  source_intent TEXT NULL,
  validation_state TEXT NOT NULL DEFAULT 'promoted',
  compiler_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  success_count INT NOT NULL DEFAULT 1,
  failure_count INT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_workflow_segment_category
    CHECK (category = 'system/android' OR category LIKE 'app/%'),
  CONSTRAINT chk_workflow_segment_placement
    CHECK (placement IN ('prefix', 'body', 'suffix')),
  CONSTRAINT chk_workflow_segment_validation_state
    CHECK (validation_state IN ('promoted', 'quarantined', 'revoked')),
  CONSTRAINT chk_workflow_segment_counts
    CHECK (success_count >= 0 AND failure_count >= 0),
  CONSTRAINT chk_workflow_segment_steps_array
    CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) > 0)
);

CREATE INDEX IF NOT EXISTS idx_workflow_segment_library_category
  ON workflow_segment_library(category, validation_state, compiler_eligible, success_count DESC, last_success_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_segment_library_semantic_tokens
  ON workflow_segment_library USING GIN(semantic_tokens);
