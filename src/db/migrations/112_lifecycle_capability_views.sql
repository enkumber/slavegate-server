-- Read projections that expose lifecycle capabilities beside persisted state
-- values. These views contain schema wiring only and no lifecycle semantics.

CREATE OR REPLACE VIEW agency_workflow_definitions_lifecycle AS
SELECT definition.*,
       status_definition.initial AS status_initial,
       status_definition.terminal AS status_terminal,
       status_definition.retryable AS status_retryable,
       status_definition.administrative AS status_administrative,
       status_definition.dispatchable AS status_dispatchable,
       status_definition.manual AS status_manual,
       promotion_definition.initial AS promotion_initial,
       promotion_definition.terminal AS promotion_terminal,
       promotion_definition.retryable AS promotion_retryable,
       promotion_definition.administrative AS promotion_administrative,
       promotion_definition.dispatchable AS promotion_dispatchable,
       promotion_definition.manual AS promotion_manual
  FROM agency_workflow_definitions definition
  JOIN lifecycle_resource_bindings status_binding
    ON status_binding.resource_table = to_regclass('agency_workflow_definitions')
   AND status_binding.state_column = 'status'
  JOIN lifecycle_state_definitions status_definition
    ON status_definition.lifecycle_key = status_binding.lifecycle_key
   AND status_definition.status = definition.status
  JOIN lifecycle_resource_bindings promotion_binding
    ON promotion_binding.resource_table = to_regclass('agency_workflow_definitions')
   AND promotion_binding.state_column = 'promotion_state'
  JOIN lifecycle_state_definitions promotion_definition
    ON promotion_definition.lifecycle_key = promotion_binding.lifecycle_key
   AND promotion_definition.status = definition.promotion_state;

CREATE OR REPLACE VIEW agency_workflow_step_candidates_lifecycle AS
SELECT candidate.*,
       candidate_definition.initial AS candidate_initial,
       candidate_definition.terminal AS candidate_terminal,
       candidate_definition.retryable AS candidate_retryable,
       candidate_definition.administrative AS candidate_administrative,
       candidate_definition.dispatchable AS candidate_reusable,
       candidate_definition.manual AS candidate_manual,
       library_definition.initial AS library_initial,
       library_definition.terminal AS library_terminal,
       library_definition.retryable AS library_retryable,
       library_definition.administrative AS library_administrative,
       library_definition.dispatchable AS library_reusable,
       library_definition.manual AS library_manual
  FROM agency_workflow_step_candidates candidate
  JOIN lifecycle_resource_bindings candidate_binding
    ON candidate_binding.resource_table = to_regclass('agency_workflow_step_candidates')
   AND candidate_binding.state_column = 'candidate_state'
  JOIN lifecycle_state_definitions candidate_definition
    ON candidate_definition.lifecycle_key = candidate_binding.lifecycle_key
   AND candidate_definition.status = candidate.candidate_state
  JOIN lifecycle_resource_bindings library_binding
    ON library_binding.resource_table = to_regclass('agency_workflow_step_candidates')
   AND library_binding.state_column = 'library_state'
  JOIN lifecycle_state_definitions library_definition
    ON library_definition.lifecycle_key = library_binding.lifecycle_key
   AND library_definition.status = candidate.library_state;
