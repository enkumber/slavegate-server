-- Generic generated workflow learning loop.
-- Successful generated_workflow executions can promote reusable artifacts.
-- Failed executions mark weak artifacts failed/quarantined and preserve the
-- failure reason in source_metadata.workflowLearning for recompilation/review.

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_learning_outcome
  ON generated_workflow_plan_cache (
    (source_metadata #>> '{workflowLearning,lastOutcome}'),
    artifact_state,
    updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_learning_decision
  ON generated_workflow_plan_cache (
    (source_metadata #>> '{workflowLearning,decision}'),
    updated_at DESC
  );
