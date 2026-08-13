import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export async function resolveHumanWorkflowRunIdentity(
  explicitIdentity: string | undefined,
  db: Queryable,
): Promise<string> {
  const result = await db.query(
    "SELECT identity, admitted FROM resolve_resource_runtime_identity(to_regclass($1), $2)",
    ["agency_workflow_runs", explicitIdentity ?? null],
  );
  if (result.rows[0]?.admitted === true && typeof result.rows[0]?.identity === "string") {
    return result.rows[0].identity;
  }
  throw Object.assign(new Error("PostgreSQL policy does not admit this workflow identity"), {
    status: 409, code: "WORKFLOW_RUN_NOT_ADMITTED",
  });
}
