import crypto from "crypto";
import type { Pool, PoolClient } from "pg";
import { getResourceRuntimePolicy } from "../runtime-policy/resource-runtime-policy.service";

type Queryable = Pick<Pool | PoolClient, "query">;

export async function resolveHumanWorkflowRunIdentity(
  explicitIdentity: string | undefined,
  db: Queryable,
): Promise<string> {
  if (explicitIdentity) return explicitIdentity;
  const policy = await getResourceRuntimePolicy("agency_workflow_runs", db);
  if (policy.implicitIdentityOpcode === 1) return crypto.randomUUID();
  throw Object.assign(new Error("PostgreSQL policy does not admit an implicit workflow identity"), {
    status: 409,
    code: "WORKFLOW_RUN_NOT_ADMITTED",
  });
}
