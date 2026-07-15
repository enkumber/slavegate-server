-- Controlled workflow definition rollback v3.
-- Adds a manual/audited rollback action. It only changes definition promotion
-- metadata and audit history; it never changes compiler visibility, workflow
-- cache, or execution paths.

ALTER TABLE agency_workflow_definition_promotion_events
  DROP CONSTRAINT IF EXISTS agency_workflow_definition_promotion_events_action_check;

ALTER TABLE agency_workflow_definition_promotion_events
  ADD CONSTRAINT agency_workflow_definition_promotion_events_action_check
  CHECK (action IN ('promote_limited', 'revoke', 'rollback'));
