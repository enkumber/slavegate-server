export type CompilerPolicyGateState = "blocked" | "review_ready" | "enabled";
export type CompilerPolicyGateRisk = "low" | "medium" | "high";

export interface CompilerPolicyGate {
  id: string;
  title: string;
  category: string;
  state: CompilerPolicyGateState;
  risk: CompilerPolicyGateRisk;
  owner: "product" | "engineering" | "qa" | "security";
  blocks: string[];
  requiredEvidence: string[];
  requiredPolicyChanges: string[];
  remediation: {
    state: "manual_review_required";
    nextActions: string[];
    safeToAutoApply: boolean;
  };
  guardrails: string[];
  notes: string[];
  configState?: CompilerPolicyGateState;
  version?: number;
  config?: Record<string, unknown>;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export interface CompilerPolicyGateConfigRow {
  gate_id?: string | null;
  state?: string | null;
  version?: number | string | null;
  owner?: string | null;
  risk?: string | null;
  config?: Record<string, unknown> | null;
  updated_by?: string | null;
  updated_at?: Date | string | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function state(value: unknown): CompilerPolicyGateState {
  return value === "enabled" || value === "review_ready" ? value : "blocked";
}

function risk(value: unknown): CompilerPolicyGateRisk {
  return value === "low" || value === "medium" ? value : "high";
}

function owner(value: unknown): CompilerPolicyGate["owner"] {
  return value === "product" || value === "engineering" || value === "qa" ? value : "security";
}

function toGate(row: CompilerPolicyGateConfigRow): CompilerPolicyGate {
  const config = object(row.config);
  const gateState = state(row.state);
  return {
    id: String(row.gate_id ?? ""),
    title: String(config.title ?? row.gate_id ?? ""),
    category: String(config.category ?? "execution"),
    state: gateState,
    risk: risk(row.risk),
    owner: owner(row.owner),
    blocks: strings(config.blocks),
    requiredEvidence: strings(config.requiredEvidence),
    requiredPolicyChanges: strings(config.requiredPolicyChanges),
    remediation: {
      state: "manual_review_required",
      nextActions: strings(config.nextActions),
      safeToAutoApply: gateState === "enabled" && config.killSwitch !== true,
    },
    guardrails: strings(config.guardrails),
    notes: strings(config.notes),
    configState: gateState,
    version: Number(row.version ?? 1),
    config,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
  };
}

export function listCompilerPolicyGatesWithConfig(
  rows: CompilerPolicyGateConfigRow[] = [],
  filters: { category?: string; state?: string; risk?: string; owner?: string } = {},
): CompilerPolicyGate[] {
  return rows.map(toGate).filter((gate) => {
    if (filters.category && gate.category !== filters.category) return false;
    if (filters.state && gate.state !== filters.state) return false;
    if (filters.risk && gate.risk !== filters.risk) return false;
    if (filters.owner && gate.owner !== filters.owner) return false;
    return true;
  });
}
