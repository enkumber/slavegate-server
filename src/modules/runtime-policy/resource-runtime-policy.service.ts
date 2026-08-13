import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface ResourceRuntimePolicyRecord {
  resourceTable: string;
  policy: Record<string, unknown>;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface CanonicalPredicateMetadataPolicy {
  resourceTable: string;
  version: number;
  predicateMetadata: Record<string, unknown>;
}

export class ResourceRuntimePolicyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRuntimePolicyUnavailableError";
  }
}

function resourceName(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(normalized)) {
    throw new Error("resourceTable must be a SQL identifier");
  }
  return normalized;
}

function policyValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("policy must be an object");
  }
  return value as Record<string, unknown>;
}

function rowToRecord(row: Record<string, unknown>): ResourceRuntimePolicyRecord {
  return {
    resourceTable: String(row.resource_table),
    policy: policyValue(row.policy),
    version: Number(row.version),
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

export async function getResourceRuntimePolicy(
  resourceTableValue: string,
  db: Queryable = getDb(),
): Promise<Record<string, unknown>> {
  return (await getResourceRuntimePolicyRecord(resourceTableValue, db)).policy;
}

export async function getResourceRuntimePolicyRecord(
  resourceTableValue: string,
  db: Queryable = getDb(),
): Promise<ResourceRuntimePolicyRecord> {
  const resourceTable = resourceName(resourceTableValue);
  const result = await db.query(
    `SELECT resource_table::text, policy, version, updated_by, updated_at
       FROM resource_runtime_policies
      WHERE resource_table = to_regclass($1)`,
    [resourceTable],
  );
  if (!result.rows[0]) {
    throw new ResourceRuntimePolicyUnavailableError(
      `runtime policy for resource ${resourceTable} is not configured`,
    );
  }
  const record = rowToRecord(result.rows[0]);
  const policy = record.policy;
  if (policy.enabled === false || policy.disabled === true) {
    throw new ResourceRuntimePolicyUnavailableError(
      `runtime policy for resource ${resourceTable} is disabled`,
    );
  }
  return record;
}

export async function getCanonicalPredicateMetadataPolicy(
  resourceTableValue: string,
  db: Queryable = getDb(),
): Promise<CanonicalPredicateMetadataPolicy> {
  const record = await getResourceRuntimePolicyRecord(resourceTableValue, db);
  const metadata = record.policy.predicateMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ResourceRuntimePolicyUnavailableError(
      `predicate metadata for resource ${record.resourceTable} is not configured`,
    );
  }
  return {
    resourceTable: record.resourceTable,
    version: record.version,
    predicateMetadata: metadata as Record<string, unknown>,
  };
}

export async function listResourceRuntimePolicies(
  resourceTableValue?: string,
  db: Queryable = getDb(),
): Promise<ResourceRuntimePolicyRecord[]> {
  const resourceTable = resourceTableValue === undefined ? null : resourceName(resourceTableValue);
  const result = await db.query(
    `SELECT resource_table::text, policy, version, updated_by, updated_at
       FROM resource_runtime_policies
      WHERE ($1::text IS NULL OR resource_table = to_regclass($1))
      ORDER BY resource_table::text`,
    [resourceTable],
  );
  return result.rows.map(rowToRecord);
}

export async function upsertResourceRuntimePolicy(input: {
  resourceTable: string;
  policy: Record<string, unknown>;
  updatedBy?: string | null;
}, db: Queryable = getDb()): Promise<ResourceRuntimePolicyRecord> {
  const resourceTable = resourceName(input.resourceTable);
  const policy = policyValue(input.policy);
  const updatedBy = typeof input.updatedBy === "string" && input.updatedBy.trim()
    ? input.updatedBy.trim()
    : null;
  const result = await db.query(
    `INSERT INTO resource_runtime_policies(resource_table, policy, updated_by)
     SELECT resource.oid, $2::jsonb, $3
       FROM pg_class resource
      WHERE resource.oid = to_regclass($1)
     ON CONFLICT (resource_table) DO UPDATE
       SET policy = EXCLUDED.policy,
           version = resource_runtime_policies.version + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING resource_table::text, policy, version, updated_by, updated_at`,
    [resourceTable, JSON.stringify(policy), updatedBy],
  );
  if (!result.rows[0]) throw new Error("resource table does not exist in PostgreSQL");
  return rowToRecord(result.rows[0]);
}

export async function deleteResourceRuntimePolicy(
  resourceTableValue: string,
  db: Queryable = getDb(),
): Promise<boolean> {
  const resourceTable = resourceName(resourceTableValue);
  const result = await db.query(
    `DELETE FROM resource_runtime_policies
      WHERE resource_table = to_regclass($1)
      RETURNING resource_table`,
    [resourceTable],
  );
  return result.rowCount === 1;
}

export async function watchResourceRuntimePolicy(
  resourceTableValue: string,
  onChange: () => void | Promise<void>,
): Promise<() => Promise<void>> {
  const resourceTable = resourceName(resourceTableValue);
  const client = await getDb().connect();
  const connectionError = (error: Error) => {
    console.error(`[runtime-policy] PostgreSQL listener failed: ${error.message}`);
  };
  const notification = (message: { channel: string; payload?: string }) => {
    if (
      message.channel === "resource_runtime_policy_changed"
      && message.payload === resourceTable
    ) {
      void Promise.resolve(onChange()).catch((error) => {
        console.error(
          `[runtime-policy] reload for ${resourceTable} failed: ${(error as Error).message}`,
        );
      });
    }
  };
  client.on("error", connectionError);
  client.on("notification", notification);
  await client.query("LISTEN resource_runtime_policy_changed");
  return async () => {
    client.removeListener("notification", notification);
    client.removeListener("error", connectionError);
    await client.query("UNLISTEN resource_runtime_policy_changed").catch(() => undefined);
    client.release();
  };
}
