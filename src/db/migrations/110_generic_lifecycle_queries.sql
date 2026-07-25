-- Generic lifecycle capability queries for runtime consumers.
--
-- This migration contains mechanism only. It does not name or seed a product
-- lifecycle, state, transition, action, or policy.

CREATE OR REPLACE FUNCTION lifecycle_state_matches(
  target_table REGCLASS,
  state_value TEXT,
  selector JSONB DEFAULT '{}'::jsonb,
  target_state_column NAME DEFAULT 'status'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT
      (NOT (selector ? 'initial') OR definition.initial = (selector->>'initial')::boolean)
      AND (NOT (selector ? 'terminal') OR definition.terminal = (selector->>'terminal')::boolean)
      AND (NOT (selector ? 'retryable') OR definition.retryable = (selector->>'retryable')::boolean)
      AND (NOT (selector ? 'administrative') OR definition.administrative = (selector->>'administrative')::boolean)
      AND (NOT (selector ? 'dispatchable') OR definition.dispatchable = (selector->>'dispatchable')::boolean)
      AND (NOT (selector ? 'manual') OR definition.manual = (selector->>'manual')::boolean)
    FROM lifecycle_resource_bindings binding
    JOIN lifecycle_state_definitions definition
      ON definition.lifecycle_key = binding.lifecycle_key
    WHERE binding.resource_table = target_table
      AND binding.state_column = target_state_column
      AND definition.status = state_value
  ), FALSE);
$$;

CREATE OR REPLACE FUNCTION lifecycle_transition_target(
  target_table REGCLASS,
  from_state TEXT,
  selector JSONB DEFAULT '{}'::jsonb,
  target_state_column NAME DEFAULT 'status'
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  matched_target TEXT;
  match_count BIGINT;
BEGIN
  SELECT MIN(target.status), COUNT(*)
    INTO matched_target, match_count
    FROM lifecycle_resource_bindings binding
    JOIN lifecycle_transitions transition
      ON transition.lifecycle_key = binding.lifecycle_key
     AND transition.from_status = from_state
    JOIN lifecycle_state_definitions target
      ON target.lifecycle_key = transition.lifecycle_key
     AND target.status = transition.to_status
   WHERE binding.resource_table = target_table
     AND binding.state_column = target_state_column
     AND (NOT (selector ? 'targetInitial') OR target.initial = (selector->>'targetInitial')::boolean)
     AND (NOT (selector ? 'targetTerminal') OR target.terminal = (selector->>'targetTerminal')::boolean)
     AND (NOT (selector ? 'targetRetryable') OR target.retryable = (selector->>'targetRetryable')::boolean)
     AND (NOT (selector ? 'targetAdministrative') OR target.administrative = (selector->>'targetAdministrative')::boolean)
     AND (NOT (selector ? 'targetDispatchable') OR target.dispatchable = (selector->>'targetDispatchable')::boolean)
     AND (NOT (selector ? 'targetManual') OR target.manual = (selector->>'targetManual')::boolean)
     AND (NOT (selector ? 'manualAllowed') OR transition.manual_allowed = (selector->>'manualAllowed')::boolean)
     AND (NOT (selector ? 'externalAllowed') OR transition.external_allowed = (selector->>'externalAllowed')::boolean)
     AND (NOT (selector ? 'automatic') OR transition.automatic = (selector->>'automatic')::boolean)
     AND (NOT (selector ? 'markStarted') OR transition.mark_started = (selector->>'markStarted')::boolean)
     AND (NOT (selector ? 'markCompleted') OR transition.mark_completed = (selector->>'markCompleted')::boolean)
     AND (NOT (selector ? 'clearCompleted') OR transition.clear_completed = (selector->>'clearCompleted')::boolean)
     AND (NOT (selector ? 'clearFailure') OR transition.clear_failure = (selector->>'clearFailure')::boolean)
     AND (NOT (selector ? 'resetRetry') OR transition.reset_retry = (selector->>'resetRetry')::boolean);

  IF match_count = 0 THEN
    RETURN NULL;
  END IF;
  IF match_count <> 1 THEN
    RAISE EXCEPTION 'lifecycle transition selector is ambiguous for configured resource';
  END IF;
  RETURN matched_target;
END;
$$;
