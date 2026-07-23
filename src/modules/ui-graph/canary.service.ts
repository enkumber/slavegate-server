import { getDb } from "../../db/client";

export interface CanaryGate {
  ready: boolean;
  requiredDistinctDevices: number;
  requiredDistinctBranches: number;
  distinctDevices: number;
  distinctBranches: number;
  completed: number;
  failed: number;
  recovered: number;
  blockers: string[];
}

export async function evaluateCanaryGate(cacheKey: string, cohortId: string): Promise<CanaryGate> {
  const result = await getDb().query(
    `SELECT c.required_distinct_devices, c.required_distinct_branches,
            COUNT(*) FILTER (WHERE r.status='completed' AND r.postcondition_verified)::int AS completed,
            COUNT(*) FILTER (WHERE r.status='failed' OR NOT r.postcondition_verified)::int AS failed,
            COUNT(DISTINCT r.device_id) FILTER (WHERE r.status='completed' AND r.postcondition_verified)::int AS distinct_devices,
            COUNT(DISTINCT r.branch_key) FILTER (WHERE r.status='completed' AND r.postcondition_verified)::int AS distinct_branches,
            COALESCE(SUM(r.recovery_count) FILTER (WHERE r.status='completed'),0)::int AS recovered
       FROM workflow_canary_cohorts c
       LEFT JOIN workflow_canary_runs r ON r.cohort_id=c.id AND r.cache_key=$1
      WHERE c.id=$2 AND c.status='active'
      GROUP BY c.id`,
    [cacheKey, cohortId],
  );
  if (!result.rows[0]) throw new Error("WORKFLOW_CANARY_COHORT_NOT_FOUND");
  const row = result.rows[0];
  const blockers: string[] = [];
  if (Number(row.distinct_devices) < Number(row.required_distinct_devices)) blockers.push("insufficient_device_coverage");
  if (Number(row.distinct_branches) < Number(row.required_distinct_branches)) blockers.push("insufficient_branch_coverage");
  if (Number(row.failed) > 0) blockers.push("failed_or_unverified_canary");
  if (Number(row.recovered) > 0) blockers.push("recovery_observed_requires_clean_canary");
  return {
    ready: blockers.length === 0,
    requiredDistinctDevices: Number(row.required_distinct_devices),
    requiredDistinctBranches: Number(row.required_distinct_branches),
    distinctDevices: Number(row.distinct_devices),
    distinctBranches: Number(row.distinct_branches),
    completed: Number(row.completed),
    failed: Number(row.failed),
    recovered: Number(row.recovered),
    blockers,
  };
}

export async function recordCanaryResult(input: {
  cohortId: string;
  cacheKey: string;
  deviceId: string;
  workflowId?: string | null;
  branchKey?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  postconditionVerified?: boolean;
  recoveryCount?: number;
  evidence?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const result = await getDb().query(
    `INSERT INTO workflow_canary_runs
       (cohort_id, cache_key, device_id, workflow_id, branch_key, status,
        postcondition_verified, recovery_count, evidence, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
       CASE WHEN $6 IN ('completed','failed','cancelled') THEN NOW() ELSE NULL END)
     ON CONFLICT (cohort_id, cache_key, device_id, branch_key) DO UPDATE SET
       workflow_id=COALESCE(EXCLUDED.workflow_id,workflow_canary_runs.workflow_id),
       status=EXCLUDED.status,
       postcondition_verified=EXCLUDED.postcondition_verified,
       recovery_count=EXCLUDED.recovery_count,
       evidence=EXCLUDED.evidence,
       completed_at=CASE WHEN EXCLUDED.status IN ('completed','failed','cancelled') THEN NOW() ELSE NULL END,
       updated_at=NOW()
     RETURNING *`,
    [
      input.cohortId, input.cacheKey, input.deviceId, input.workflowId ?? null,
      input.branchKey ?? "default", input.status, input.postconditionVerified === true,
      Math.max(0, Number(input.recoveryCount ?? 0)), JSON.stringify(input.evidence ?? {}),
    ],
  );
  return result.rows[0];
}
