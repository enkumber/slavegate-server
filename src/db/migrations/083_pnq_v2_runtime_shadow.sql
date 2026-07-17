CREATE TABLE IF NOT EXISTS pnq_legacy_job_map (
  legacy_job_id TEXT PRIMARY KEY,
  pnq_job_id UUID NOT NULL REFERENCES pnq_jobs(id) ON DELETE RESTRICT,
  pnq_node_id UUID NOT NULL REFERENCES pnq_nodes(id) ON DELETE RESTRICT,
  attempt_execution_id UUID,
  dispatch_generation BIGINT,
  socket_epoch BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pnq_legacy_job_map_pnq_job_unique UNIQUE (pnq_job_id),
  CONSTRAINT pnq_legacy_job_map_dispatch_generation_check CHECK (
    dispatch_generation IS NULL OR dispatch_generation >= 0
  ),
  CONSTRAINT pnq_legacy_job_map_socket_epoch_check CHECK (
    socket_epoch IS NULL OR socket_epoch >= 0
  )
);

CREATE INDEX IF NOT EXISTS pnq_legacy_job_map_node_idx
  ON pnq_legacy_job_map(pnq_node_id, created_at);

DROP TRIGGER IF EXISTS pnq_legacy_job_map_touch_updated_at ON pnq_legacy_job_map;
CREATE TRIGGER pnq_legacy_job_map_touch_updated_at
  BEFORE UPDATE ON pnq_legacy_job_map
  FOR EACH ROW EXECUTE FUNCTION pnq_touch_updated_at();
