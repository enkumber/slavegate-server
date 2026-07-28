-- Generic runtime policy storage for PostgreSQL resources that do not
-- necessarily expose a lifecycle state column. Product semantics and policy
-- values are configured through the control plane, never seeded by releases.

CREATE TABLE IF NOT EXISTS resource_runtime_policies (
  resource_table REGCLASS PRIMARY KEY,
  policy JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE segment_build_jobs
  ALTER COLUMN assigned_agent DROP DEFAULT;

CREATE OR REPLACE FUNCTION notify_resource_runtime_policy_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'resource_runtime_policy_changed',
    COALESCE(NEW.resource_table, OLD.resource_table)::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_resource_runtime_policy_changed
  ON resource_runtime_policies;

CREATE TRIGGER trg_resource_runtime_policy_changed
AFTER INSERT OR UPDATE OR DELETE ON resource_runtime_policies
FOR EACH ROW
EXECUTE FUNCTION notify_resource_runtime_policy_changed();
