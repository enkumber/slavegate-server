import { getDb } from "../../db/client";

export interface WorkflowQueueRuntimePolicy {
  maxAttempts: number;
  backoffType: string;
  backoffDelayMs: number;
}

let runtimePolicy: WorkflowQueueRuntimePolicy | null = null;
let testOverride: WorkflowQueueRuntimePolicy | null = null;

function parsePolicy(payload: Record<string, unknown>): WorkflowQueueRuntimePolicy {
  const maxAttempts = Number(payload.maxAttempts);
  const backoffDelayMs = Number(payload.backoffDelayMs);
  if (
    !Number.isInteger(maxAttempts)
    || maxAttempts <= 0
    || typeof payload.backoffType !== "string"
    || !payload.backoffType.trim()
    || !Number.isFinite(backoffDelayMs)
    || backoffDelayMs < 0
  ) {
    throw new Error("invalid PostgreSQL workflow queue runtime policy");
  }
  return {
    maxAttempts,
    backoffType: payload.backoffType,
    backoffDelayMs,
  };
}

export async function initializeWorkflowQueueRuntimePolicy(): Promise<WorkflowQueueRuntimePolicy> {
  const result = await getDb().query<{ payload: Record<string, unknown> }>(
    `SELECT entry.payload
       FROM runtime_semantic_entries entry
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE definition.dispatchable
        AND entry.payload ?& ARRAY['maxAttempts','backoffType','backoffDelayMs']
      ORDER BY entry.priority DESC, entry.id`,
  );
  if (result.rows.length !== 1) {
    throw new Error("PostgreSQL must expose exactly one active workflow queue runtime policy");
  }
  runtimePolicy = parsePolicy(result.rows[0].payload);
  return { ...runtimePolicy };
}

export function getWorkflowQueueRuntimePolicy(): WorkflowQueueRuntimePolicy {
  const policy = testOverride ?? runtimePolicy;
  if (!policy) throw new Error("workflow queue runtime policy was not initialized");
  return { ...policy };
}

export function setWorkflowQueueRuntimePolicyForTest(policy: WorkflowQueueRuntimePolicy | null): void {
  testOverride = policy;
}
