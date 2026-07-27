-- Schema for database-owned application runtime profiles. Product profiles,
-- recipes, selectors and safety policy are created through the control plane.

CREATE TABLE IF NOT EXISTS app_runtime_profiles (
  app_id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  package_name TEXT NOT NULL UNIQUE,
  profile_version INT NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  reset_recipe JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapping_recipe JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(reset_recipe) = 'array'),
  CHECK (jsonb_typeof(mapping_recipe) = 'array'),
  CHECK (jsonb_typeof(safety_policy) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_app_runtime_profiles_active
  ON app_runtime_profiles(active, updated_at DESC);
