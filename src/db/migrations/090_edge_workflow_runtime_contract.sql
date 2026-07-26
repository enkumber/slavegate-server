-- Operational source of truth for the generic Android workflow interpreter.
-- Application-specific navigation data remains in app_runtime_profiles/App Maps;
-- this table defines only portable interpreter primitives and safety limits.

CREATE TABLE IF NOT EXISTS workflow_runtime_contracts (
  contract_id TEXT PRIMARY KEY,
  schema_version INT NOT NULL CHECK (schema_version > 0),
  allowed_actions JSONB NOT NULL CHECK (jsonb_typeof(allowed_actions) = 'array'),
  limits JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_runtime_profiles
  ADD COLUMN IF NOT EXISTS workflow_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE app_runtime_profiles
  DROP CONSTRAINT IF EXISTS app_runtime_profiles_workflow_policy_object;

ALTER TABLE app_runtime_profiles
  ADD CONSTRAINT app_runtime_profiles_workflow_policy_object
  CHECK (jsonb_typeof(workflow_policy) = 'object');

-- Runtime contracts and application policies are operator-managed data.
