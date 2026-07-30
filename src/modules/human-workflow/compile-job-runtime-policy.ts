import { getDb } from "../../db/client";

export interface HumanWorkflowCompileJobRuntimePolicy {
  version: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  reconcileIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
}

export class HumanWorkflowCompileJobPolicyUnavailableError extends Error {
  readonly code = "HUMAN_WORKFLOW_COMPILE_JOB_POLICY_UNAVAILABLE";
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new HumanWorkflowCompileJobPolicyUnavailableError(
      `human workflow compile-job runtime policy field ${field} must be a positive integer`,
    );
  }
  return Number(value);
}

export async function humanWorkflowCompileJobRuntimePolicy(): Promise<HumanWorkflowCompileJobRuntimePolicy> {
  const result = await getDb().query(
    `SELECT runtime.policy AS runtime_policy,
            runtime.version AS runtime_version,
            lifecycle.policy AS lifecycle_policy
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_resource_policies lifecycle
         ON lifecycle.resource_table = binding.resource_table
        AND lifecycle.state_column = binding.state_column
       JOIN resource_runtime_policies runtime
         ON runtime.resource_table = binding.resource_table
      WHERE binding.resource_table = to_regclass($1)
        AND binding.state_column = $2::name`,
    ["human_workflow_compile_jobs", "status"],
  );
  const row = result.rows[0];
  const runtime = row?.runtime_policy;
  const lifecycle = row?.lifecycle_policy;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
      || !lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)
      || runtime.enabled === false || runtime.disabled === true
      || lifecycle.enabled === false || lifecycle.disabled === true) {
    throw new HumanWorkflowCompileJobPolicyUnavailableError(
      "human workflow compile-job lifecycle/runtime policy is missing or disabled",
    );
  }
  const worker = runtime.compileWorker;
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
    throw new HumanWorkflowCompileJobPolicyUnavailableError(
      "human workflow compile-job runtime policy has no compileWorker contract",
    );
  }
  const policy = worker as Record<string, unknown>;
  const leaseDurationMs = positiveInteger(policy.leaseDurationMs, "leaseDurationMs");
  const heartbeatIntervalMs = positiveInteger(policy.heartbeatIntervalMs, "heartbeatIntervalMs");
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new HumanWorkflowCompileJobPolicyUnavailableError(
      "human workflow compile-job heartbeatIntervalMs must be shorter than leaseDurationMs",
    );
  }
  return {
    version: Number(row.runtime_version),
    leaseDurationMs,
    heartbeatIntervalMs,
    reconcileIntervalMs: positiveInteger(policy.reconcileIntervalMs, "reconcileIntervalMs"),
    batchSize: positiveInteger(policy.batchSize, "batchSize"),
    maxAttempts: positiveInteger(policy.maxAttempts, "maxAttempts"),
  };
}
