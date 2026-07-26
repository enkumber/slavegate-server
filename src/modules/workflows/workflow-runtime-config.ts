import { getDb } from "../../db/client";

export interface WorkflowQueueRuntimePolicy {
  maxAttempts: number;
  backoffType: string;
  backoffDelayMs: number;
}

export interface WorkflowQueueRuntimePolicyStatus {
  ready: boolean;
  candidateCount: number;
  policy: WorkflowQueueRuntimePolicy | null;
  error: string | null;
}

let runtimePolicy: WorkflowQueueRuntimePolicy | null = null;
let runtimePolicyCandidateCount = 0;
let runtimePolicyError: string | null = null;
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

export async function initializeWorkflowQueueRuntimePolicy(): Promise<WorkflowQueueRuntimePolicy | null> {
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
  runtimePolicyCandidateCount = result.rows.length;
  if (result.rows.length !== 1) {
    runtimePolicy = null;
    runtimePolicyError = result.rows.length === 0
      ? "PostgreSQL has no active workflow queue runtime policy"
      : "PostgreSQL exposes multiple active workflow queue runtime policies";
    return null;
  }
  try {
    runtimePolicy = parsePolicy(result.rows[0].payload);
    runtimePolicyError = null;
  } catch (err) {
    runtimePolicy = null;
    runtimePolicyError = (err as Error).message;
    return null;
  }
  return { ...runtimePolicy };
}

export function describeWorkflowQueueRuntimePolicy(): WorkflowQueueRuntimePolicyStatus {
  const policy = testOverride ?? runtimePolicy;
  return {
    ready: policy !== null,
    candidateCount: testOverride ? 1 : runtimePolicyCandidateCount,
    policy: policy ? { ...policy } : null,
    error: policy ? null : runtimePolicyError,
  };
}

export function getWorkflowQueueRuntimePolicy(): WorkflowQueueRuntimePolicy {
  const policy = testOverride ?? runtimePolicy;
  if (!policy) {
    throw new Error(runtimePolicyError ?? "workflow queue runtime policy was not initialized");
  }
  return { ...policy };
}

export function setWorkflowQueueRuntimePolicyForTest(policy: WorkflowQueueRuntimePolicy | null): void {
  testOverride = policy;
}
