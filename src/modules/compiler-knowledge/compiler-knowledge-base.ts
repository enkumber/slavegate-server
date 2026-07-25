import { getDb } from "../../db/client";

export type CompilerKnowledgeType = string;
export type CompilerKnowledgeRisk = string;

export interface CompilerKnowledgeEntry {
  id: string;
  title: string;
  type: CompilerKnowledgeType;
  domain: string;
  appliesTo: string[];
  summary: string;
  guidance: string[];
  risk: CompilerKnowledgeRisk;
  source: string;
  status: string;
  policy: Record<string, unknown>;
  evidence: Record<string, unknown>;
  notes: string[];
}

function toEntry(entryKey: string, payload: Record<string, unknown>): CompilerKnowledgeEntry {
  return {
    id: String(payload.id ?? entryKey),
    title: String(payload.title ?? entryKey),
    type: String(payload.type ?? ""),
    domain: String(payload.domain ?? ""),
    appliesTo: Array.isArray(payload.appliesTo) ? payload.appliesTo.map(String) : [],
    summary: String(payload.summary ?? ""),
    guidance: Array.isArray(payload.guidance) ? payload.guidance.map(String) : [],
    risk: String(payload.risk ?? ""),
    source: String(payload.source ?? ""),
    status: String(payload.status ?? ""),
    policy: payload.policy && typeof payload.policy === "object" && !Array.isArray(payload.policy)
      ? payload.policy as Record<string, unknown>
      : {},
    evidence: payload.evidence && typeof payload.evidence === "object" && !Array.isArray(payload.evidence)
      ? payload.evidence as Record<string, unknown>
      : {},
    notes: Array.isArray(payload.notes) ? payload.notes.map(String) : [],
  };
}

export async function listCompilerKnowledge(filters: {
  type?: string;
  domain?: string;
  risk?: string;
  source?: string;
}): Promise<CompilerKnowledgeEntry[]> {
  const result = await getDb().query(
    `SELECT entry_key, payload
     FROM runtime_semantic_entries entry
     JOIN lifecycle_resource_bindings binding
       ON binding.resource_table = to_regclass('runtime_semantic_entries')
      AND binding.lifecycle_key = entry.lifecycle_key
     JOIN lifecycle_state_definitions definition
       ON definition.lifecycle_key = entry.lifecycle_key
      AND definition.status = entry.status
     WHERE namespace = 'compiler_knowledge'
       AND definition.dispatchable
     ORDER BY priority ASC, entry_key ASC`,
  );
  return (result?.rows ?? [])
    .map((row) => toEntry(String(row.entry_key), row.payload ?? {}))
    .filter((entry) => {
      if (filters.type && entry.type !== filters.type) return false;
      if (filters.domain && entry.domain !== filters.domain) return false;
      if (filters.risk && entry.risk !== filters.risk) return false;
      if (filters.source && entry.source !== filters.source) return false;
      return true;
    });
}
