-- Generic operational policy storage for lifecycle-bound resources.
-- No resource, state, transition, action, or policy value is packaged here.

CREATE TABLE IF NOT EXISTS lifecycle_resource_policies (
  resource_table REGCLASS NOT NULL,
  state_column NAME NOT NULL,
  policy JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (resource_table, state_column),
  FOREIGN KEY (resource_table, state_column)
    REFERENCES lifecycle_resource_bindings(resource_table, state_column)
    ON DELETE CASCADE
);
