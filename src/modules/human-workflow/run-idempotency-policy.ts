import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import { getResourceRuntimePolicy } from "../runtime-policy/resource-runtime-policy.service";

type Queryable = Pick<Pool | PoolClient, "query">;

function humanRunPolicyObject(policy: Record<string, unknown>): Record<string, unknown> {
  const nested = policy.humanWorkflowRun;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return policy;
}

export function requireHumanRunIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value)) {
    throw Object.assign(new Error("idempotencyKey must be a safe non-empty identifier"), {
      status: 400,
      code: "IDEMPOTENCY_KEY_INVALID",
    });
  }
  return value;
}

export async function resolveHumanRunIdempotencyKey(input: {
  explicitIdempotencyKey?: string | null;
  generatedFreshKey: string;
  db?: Queryable;
}): Promise<string> {
  if (input.explicitIdempotencyKey) return input.explicitIdempotencyKey;
  const policy = humanRunPolicyObject(await getResourceRuntimePolicy(
    "agency_workflow_runs",
    input.db ?? getDb(),
  ));
  if (policy.freshRunIdempotencyByDefault === true) return input.generatedFreshKey;
  if (policy.replayOnlyWithoutIdempotencyKey === true) {
    throw Object.assign(new Error("PostgreSQL policy requires an explicit idempotency key for replay-only human workflow runs"), {
      status: 409,
      code: "WORKFLOW_IDEMPOTENCY_REPLAY_ONLY",
    });
  }
  throw Object.assign(new Error("PostgreSQL human workflow run idempotency policy is not configured"), {
    status: 503,
    code: "WORKFLOW_IDEMPOTENCY_POLICY_REQUIRED",
  });
}
