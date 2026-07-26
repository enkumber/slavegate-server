import { getDb } from "../../db/client";

export interface RuntimeSemanticEntryInput {
  namespace: string;
  entryKey: string;
  platform: string;
  lifecycleKey: string;
  status: string;
  priority: number;
  payload: Record<string, unknown>;
}

function requireKey(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`${field} must be a non-empty string of at most 200 characters`);
  }
  return normalized;
}

export async function listRuntimeSemanticEntries(filters: {
  namespace?: string;
  entryKey?: string;
} = {}): Promise<Record<string, unknown>[]> {
  const result = await getDb().query(
    `SELECT id, namespace, entry_key, platform, lifecycle_key, status, priority,
            payload, created_at, updated_at
       FROM runtime_semantic_entries
      WHERE ($1::text IS NULL OR namespace = $1)
        AND ($2::text IS NULL OR entry_key = $2)
      ORDER BY namespace, entry_key`,
    [filters.namespace ?? null, filters.entryKey ?? null],
  );
  return result.rows;
}

export async function upsertRuntimeSemanticEntry(
  input: RuntimeSemanticEntryInput,
): Promise<Record<string, unknown>> {
  const namespace = requireKey(input.namespace, "namespace");
  const entryKey = requireKey(input.entryKey, "entryKey");
  const platform = requireKey(input.platform, "platform");
  const lifecycleKey = requireKey(input.lifecycleKey, "lifecycleKey");
  const status = requireKey(input.status, "status");
  if (!Number.isSafeInteger(input.priority)) {
    throw new Error("priority must be an integer");
  }
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("payload must be an object");
  }

  const result = await getDb().query(
    `INSERT INTO runtime_semantic_entries
       (namespace, entry_key, platform, lifecycle_key, status, priority, payload)
     SELECT $1, $2, $3, definition.lifecycle_key, definition.status, $6, $7::jsonb
       FROM lifecycle_state_definitions definition
      WHERE definition.lifecycle_key = $4
        AND definition.status = $5
     ON CONFLICT (namespace, entry_key) DO UPDATE
       SET platform = EXCLUDED.platform,
           lifecycle_key = EXCLUDED.lifecycle_key,
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           payload = EXCLUDED.payload,
           updated_at = NOW()
     RETURNING id, namespace, entry_key, platform, lifecycle_key, status, priority,
               payload, created_at, updated_at`,
    [namespace, entryKey, platform, lifecycleKey, status, input.priority, JSON.stringify(input.payload)],
  );
  if (!result.rows[0]) {
    throw new Error("lifecycle state does not exist in PostgreSQL");
  }
  return result.rows[0];
}

export async function deleteRuntimeSemanticEntry(namespaceValue: string, entryKeyValue: string): Promise<boolean> {
  const namespace = requireKey(namespaceValue, "namespace");
  const entryKey = requireKey(entryKeyValue, "entryKey");
  const result = await getDb().query(
    `DELETE FROM runtime_semantic_entries
      WHERE namespace = $1 AND entry_key = $2
      RETURNING id`,
    [namespace, entryKey],
  );
  return result.rowCount === 1;
}
