-- Migration 020b: Align coordinate_cache schema with FORGE spec
-- Adds: last_used_at, last_success_at columns (spec names)
-- Fixes: UNIQUE constraint to include app_version + screen_type
-- Note: keeps old last_used / last_success columns for backward compat

ALTER TABLE coordinate_cache
  ADD COLUMN IF NOT EXISTS last_used_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS screen_type_key TEXT NOT NULL DEFAULT 'unknown';

-- Sync legacy columns only when upgrading a schema that actually has them.
-- Fresh installations already use the canonical *_at column names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'coordinate_cache'
      AND column_name = 'last_used'
  ) THEN
    EXECUTE 'UPDATE coordinate_cache
             SET last_used_at = last_used
             WHERE last_used_at IS NULL';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'coordinate_cache'
      AND column_name = 'last_success'
  ) THEN
    EXECUTE 'UPDATE coordinate_cache
             SET last_success_at = last_success
             WHERE last_success_at IS NULL';
  END IF;
END
$$;

-- Drop old UNIQUE (no app_version / screen_type)
ALTER TABLE coordinate_cache
  DROP CONSTRAINT IF EXISTS coordinate_cache_app_resolution_device_class_orientation_fo_key;

-- New UNIQUE per FORGE spec (includes app_version + screen_type_key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'coordinate_cache'::regclass
      AND conname = 'coordinate_cache_unique_key'
  ) THEN
    ALTER TABLE coordinate_cache
      ADD CONSTRAINT coordinate_cache_unique_key
      UNIQUE (app, app_version, resolution, device_class, orientation, font_scale_bucket, screen_type_key, element_name);
  END IF;
END
$$;

-- Additional indexes per spec
CREATE INDEX IF NOT EXISTS idx_coord_lookup_v2
  ON coordinate_cache(app, app_version, resolution, screen_type_key, element_name);
CREATE INDEX IF NOT EXISTS idx_coord_confidence_v2
  ON coordinate_cache(confidence) WHERE confidence >= 0.7;
CREATE INDEX IF NOT EXISTS idx_coord_stale
  ON coordinate_cache(last_used_at) WHERE last_used_at IS NOT NULL;
