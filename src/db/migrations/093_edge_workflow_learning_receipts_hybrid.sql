ALTER TABLE ui_graph_edge_learning_receipts
  ADD COLUMN IF NOT EXISTS binding_id TEXT,
  ADD COLUMN IF NOT EXISTS checkpoint_key TEXT;

UPDATE ui_graph_edge_learning_receipts
   SET binding_id = COALESCE(binding_id, candidate_id::text),
       checkpoint_key = COALESCE(checkpoint_key, 'legacy')
 WHERE binding_id IS NULL OR checkpoint_key IS NULL;

ALTER TABLE ui_graph_edge_learning_receipts
  ALTER COLUMN binding_id SET NOT NULL,
  ALTER COLUMN checkpoint_key SET NOT NULL;

ALTER TABLE ui_graph_edge_learning_receipts
  DROP CONSTRAINT IF EXISTS ui_graph_edge_learning_receipts_pkey;

ALTER TABLE ui_graph_edge_learning_receipts
  ADD CONSTRAINT ui_graph_edge_learning_receipts_pkey
  PRIMARY KEY (workflow_id, binding_id, checkpoint_key);

CREATE INDEX IF NOT EXISTS idx_ui_graph_edge_learning_receipts_binding
  ON ui_graph_edge_learning_receipts(binding_id, checkpoint_key, created_at DESC);
