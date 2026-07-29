import type { PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";

export async function transitionWorkflowExecutionBinding(
  requestKey: string,
  selector: LifecycleTransitionSelector,
  patch: {
    postconditionVerified?: boolean;
    resultEvidence?: Record<string, unknown>;
  } = {},
  client?: PoolClient,
): Promise<boolean> {
  const db = client ?? getDb();
  const predicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  const result = await db.query(
    `WITH selected AS (
       SELECT execution.request_key, transition.to_status
         FROM workflow_execution_bindings execution
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('workflow_execution_bindings')
          AND binding.state_column = 'status'::name
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = binding.lifecycle_key
          AND transition.from_status = execution.status
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
        WHERE execution.request_key = $1
          AND ${predicate}
        ORDER BY transition.action_key
        LIMIT 1
        FOR UPDATE OF execution
     )
     UPDATE workflow_execution_bindings binding
        SET status = selected.to_status,
            postcondition_verified = COALESCE($3::boolean, binding.postcondition_verified),
            result_evidence = CASE
              WHEN $4::jsonb IS NULL THEN binding.result_evidence
              ELSE binding.result_evidence || $4::jsonb
            END,
            updated_at = NOW()
       FROM selected
      WHERE binding.request_key = selected.request_key
      RETURNING binding.request_key`,
    [
      requestKey,
      serializeLifecycleTransitionSelector(selector),
      patch.postconditionVerified ?? null,
      patch.resultEvidence ? JSON.stringify(patch.resultEvidence) : null,
    ],
  );
  return result.rows.length > 0;
}
