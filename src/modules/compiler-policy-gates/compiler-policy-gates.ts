export type CompilerPolicyGateState = "blocked" | "review_ready" | "enabled";
export type CompilerPolicyGateRisk = "low" | "medium" | "high";

export interface CompilerPolicyGate {
  id: string;
  title: string;
  category: "visibility" | "auto_use" | "eligibility" | "scope" | "safety" | "execution";
  state: CompilerPolicyGateState;
  risk: CompilerPolicyGateRisk;
  owner: "product" | "engineering" | "qa" | "security";
  blocks: string[];
  requiredEvidence: string[];
  requiredPolicyChanges: string[];
  remediation: {
    state: "manual_review_required";
    nextActions: string[];
    safeToAutoApply: false;
  };
  guardrails: string[];
  notes: string[];
  configState?: CompilerPolicyGateState;
  version?: number;
  config?: Record<string, unknown>;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

const manualRemediation = (nextActions: string[]): CompilerPolicyGate["remediation"] => ({
  state: "manual_review_required",
  nextActions,
  safeToAutoApply: false,
});

export const COMPILER_POLICY_GATES: CompilerPolicyGate[] = [
  {
    id: "compiler_tool_visibility",
    title: "Expose Tool Catalog entries to compiler selection",
    category: "visibility",
    state: "blocked",
    risk: "medium",
    owner: "engineering",
    blocks: ["tool_catalog_read_only"],
    requiredEvidence: ["tool input/output schema", "risk classification", "side-effect classification", "device capability availability"],
    requiredPolicyChanges: ["compiler_tool_visibility"],
    remediation: manualRemediation([
      "Keep Tool Catalog as observability until tool visibility is explicitly approved.",
      "Review tool risk and side effects before making any tool compiler-visible.",
    ]),
    guardrails: [
      "compilerVisible remains false for every Tool Catalog entry.",
      "No workflow plan can select a tool from this registry.",
    ],
    notes: ["This gate is a visibility gate only; it does not grant execution permission."],
  },
  {
    id: "compiler_knowledge_application",
    title: "Allow compiler to apply Knowledge Base guidance",
    category: "visibility",
    state: "blocked",
    risk: "medium",
    owner: "product",
    blocks: ["knowledge_base_read_only"],
    requiredEvidence: ["knowledge entry status", "negative example coverage", "success criteria mapping"],
    requiredPolicyChanges: ["compiler_knowledge_application"],
    remediation: manualRemediation([
      "Keep Knowledge Base read-only until rules have owners and acceptance criteria.",
      "Separate guidance from executable Step Library entries before applying it in compilation.",
    ]),
    guardrails: [
      "Knowledge Base remains guidance only.",
      "No compiler prompt, plan, or workflow cache is changed from these entries.",
    ],
    notes: ["This gate protects against turning advisory rules into hidden compiler behavior."],
  },
  {
    id: "step_compiler_eligibility",
    title: "Mark validated steps eligible for compiler consideration",
    category: "eligibility",
    state: "blocked",
    risk: "high",
    owner: "qa",
    blocks: ["step_not_compiler_eligible"],
    requiredEvidence: ["validation contract", "validation evidence", "readiness score", "scope compatibility", "promotion audit event"],
    requiredPolicyChanges: ["step_compiler_eligibility"],
    remediation: manualRemediation([
      "Keep compilerEligible=false until contract, evidence, readiness, and scope checks pass.",
      "Review revoked entries and create a fresh validated candidate instead of reusing them.",
    ]),
    guardrails: [
      "validated_step does not imply compiler eligibility.",
      "revoked entries cannot become compiler eligible without a new validation path.",
    ],
    notes: ["This is the main gate between a manually validated step and compiler awareness."],
  },
  {
    id: "limited_reuse_scope_match",
    title: "Require limited reuse scope compatibility",
    category: "scope",
    state: "blocked",
    risk: "high",
    owner: "qa",
    blocks: ["limited_reuse_not_promoted", "scope_not_declared", "step_library_entry_revoked"],
    requiredEvidence: ["promotion scope", "device/app/account context", "promotion history", "revocation status"],
    requiredPolicyChanges: ["limited_reuse_scope_match"],
    remediation: manualRemediation([
      "Promote a validated step only to limited_reuse with a narrow declared scope.",
      "Reject global/compiler/auto/all scopes until a later explicit global policy exists.",
    ]),
    guardrails: [
      "limited_reuse must stay scoped.",
      "revoked Step Library entries remain non-reusable.",
    ],
    notes: ["This gate prevents one successful device/account context from becoming global truth."],
  },
  {
    id: "compiler_auto_use",
    title: "Allow compiler to auto-use eligible candidates",
    category: "auto_use",
    state: "blocked",
    risk: "high",
    owner: "product",
    blocks: ["compiler_auto_use_disabled"],
    requiredEvidence: ["tool visibility approval", "step eligibility approval", "scope match", "telemetry rollback plan", "manual override path"],
    requiredPolicyChanges: ["compiler_auto_use"],
    remediation: manualRemediation([
      "Do not enable auto-use until all upstream policy gates are explicitly approved.",
      "Start with limited-scope canary behavior, not global reuse.",
    ]),
    guardrails: [
      "autoUseEnabled remains false.",
      "wouldChangePlan remains false.",
      "wouldExecuteStepLibrary remains false.",
    ],
    notes: ["This is the final gate before compiler behavior can change."],
  },
  {
    id: "execution_path_change",
    title: "Permit compiler output to change execution path",
    category: "execution",
    state: "blocked",
    risk: "high",
    owner: "security",
    blocks: ["execution_changing_disabled"],
    requiredEvidence: ["rollback plan", "audit trail", "side-effect review", "smoke/canary plan"],
    requiredPolicyChanges: ["compiler_execution_changes"],
    remediation: manualRemediation([
      "Keep awareness and policy gates read-only until execution changes have a dedicated rollout plan.",
      "Require explicit review before Step Library can alter generated workflow plans.",
    ]),
    guardrails: [
      "executionChanging remains false.",
      "Workflow cache and generated plans remain unchanged by policy gates.",
    ],
    notes: ["This gate stays closed even after awareness can explain what would be eligible."],
  },
];

export function listCompilerPolicyGates(filters: {
  category?: string;
  state?: string;
  risk?: string;
  owner?: string;
} = {}): CompilerPolicyGate[] {
  return COMPILER_POLICY_GATES.filter((gate) => {
    if (filters.category && gate.category !== filters.category) return false;
    if (filters.state && gate.state !== filters.state) return false;
    if (filters.risk && gate.risk !== filters.risk) return false;
    if (filters.owner && gate.owner !== filters.owner) return false;
    return true;
  });
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

function isGateState(value: unknown): value is CompilerPolicyGateState {
  return value === "blocked" || value === "review_ready" || value === "enabled";
}

function isGateRisk(value: unknown): value is CompilerPolicyGateRisk {
  return value === "low" || value === "medium" || value === "high";
}

function isGateOwner(value: unknown): value is CompilerPolicyGate["owner"] {
  return value === "product" || value === "engineering" || value === "qa" || value === "security";
}

function configObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function applyCompilerPolicyGateConfig(
  gates: CompilerPolicyGate[],
  rows: CompilerPolicyGateConfigRow[] = []
): CompilerPolicyGate[] {
  const rowsById = new Map(rows
    .filter((row) => typeof row.gate_id === "string" && row.gate_id.length > 0)
    .map((row) => [row.gate_id as string, row]));

  return gates.map((gate) => {
    const row = rowsById.get(gate.id);
    if (!row) return { ...gate, configState: gate.state, version: 1, config: {} };
    const configuredState = isGateState(row.state) ? row.state : gate.state;
    const owner = isGateOwner(row.owner) ? row.owner : gate.owner;
    const risk = isGateRisk(row.risk) ? row.risk : gate.risk;
    const version = typeof row.version === "number"
      ? row.version
      : typeof row.version === "string"
        ? parseInt(row.version, 10) || 1
        : 1;
    return {
      ...gate,
      state: configuredState,
      configState: configuredState,
      owner,
      risk,
      version,
      config: configObject(row.config),
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
      remediation: {
        ...gate.remediation,
        safeToAutoApply: false,
      },
    };
  });
}

export function listCompilerPolicyGatesWithConfig(
  rows: CompilerPolicyGateConfigRow[] = [],
  filters: {
    category?: string;
    state?: string;
    risk?: string;
    owner?: string;
  } = {}
): CompilerPolicyGate[] {
  return applyCompilerPolicyGateConfig(COMPILER_POLICY_GATES, rows).filter((gate) => {
    if (filters.category && gate.category !== filters.category) return false;
    if (filters.state && gate.state !== filters.state) return false;
    if (filters.risk && gate.risk !== filters.risk) return false;
    if (filters.owner && gate.owner !== filters.owner) return false;
    return true;
  });
}
