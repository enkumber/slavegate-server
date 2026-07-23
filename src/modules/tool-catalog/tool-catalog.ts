import { getDb } from "../../db/client";

export type ToolCatalogRisk = "low" | "medium" | "high";
export type ToolCatalogSource = "device_job" | "workflow_runtime" | "server_skill";

export interface ToolCatalogEntry {
  id: string;
  name: string;
  source: ToolCatalogSource;
  category: string;
  description: string;
  risk: ToolCatalogRisk;
  requiresDevice: boolean;
  sideEffects: string[];
  inputSchema: { required: string[]; optional: string[] };
  outputSchema: { produces: string[] };
  policy: Record<string, unknown>;
  availability: Record<string, boolean>;
  notes: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toEntry(entryKey: string, payload: Record<string, unknown>): ToolCatalogEntry {
  const inputSchema = object(payload.inputSchema);
  const outputSchema = object(payload.outputSchema);
  return {
    id: String(payload.id ?? entryKey),
    name: String(payload.name ?? entryKey),
    source: String(payload.source ?? "workflow_runtime") as ToolCatalogSource,
    category: String(payload.category ?? "workflow"),
    description: String(payload.description ?? ""),
    risk: String(payload.risk ?? "high") as ToolCatalogRisk,
    requiresDevice: payload.requiresDevice === true,
    sideEffects: strings(payload.sideEffects),
    inputSchema: {
      required: strings(inputSchema.required),
      optional: strings(inputSchema.optional),
    },
    outputSchema: { produces: strings(outputSchema.produces) },
    policy: object(payload.policy),
    availability: Object.fromEntries(
      Object.entries(object(payload.availability)).map(([key, value]) => [key, value === true]),
    ),
    notes: strings(payload.notes),
  };
}

export async function listToolCatalog(filters: {
  category?: string;
  risk?: string;
  source?: string;
} = {}): Promise<ToolCatalogEntry[]> {
  const result = await getDb().query(
    `SELECT entry_key, payload
     FROM runtime_semantic_entries
     WHERE namespace = 'tool_catalog' AND status = 'active'
     ORDER BY priority ASC, entry_key ASC`,
  );
  return (result?.rows ?? [])
    .map((row) => toEntry(String(row.entry_key), row.payload ?? {}))
    .filter((entry) => {
      if (filters.category && entry.category !== filters.category) return false;
      if (filters.risk && entry.risk !== filters.risk) return false;
      if (filters.source && entry.source !== filters.source) return false;
      return true;
    });
}
