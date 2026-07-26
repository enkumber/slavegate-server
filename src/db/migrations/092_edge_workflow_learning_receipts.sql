CREATE TABLE IF NOT EXISTS ui_graph_edge_learning_receipts (
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES ui_graph_learning_candidates(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_ui_graph_edge_learning_receipts_candidate
  ON ui_graph_edge_learning_receipts(candidate_id, created_at DESC);
