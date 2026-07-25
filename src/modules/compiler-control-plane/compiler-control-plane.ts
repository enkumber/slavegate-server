import { CompilerPolicyGate } from "../compiler-policy-gates/compiler-policy-gates";
import { resourceLifecycleStateMatches } from "../lifecycle/lifecycle.service";
import { ToolCatalogEntry, listToolCatalog } from "../tool-catalog/tool-catalog";

type JsonObject = Record<string, unknown>;

export interface CompilerControlPlaneInput {
  intent?: string;
  action?: string;
  requestedScope?: string;
  device?: JsonObject | null;
  awareness: JsonObject;
  policyGates: CompilerPolicyGate[];
}

function gateSummary(gates: CompilerPolicyGate[]): JsonObject {
  return {
    gates: gates.map((gate) => ({
      id: gate.id,
      category: gate.category,
      state: gate.state,
      risk: gate.risk,
      owner: gate.owner,
      safeToAutoApply: gate.remediation.safeToAutoApply,
      version: gate.version ?? 1,
      stateCapabilities: gate.stateCapabilities,
    })),
    total: gates.length,
    blocked: gates.filter((gate) =>
      gate.stateCapabilities?.dispatchable !== true &&
      gate.stateCapabilities?.manual !== true
    ).length,
    reviewReady: gates.filter((gate) =>
      gate.stateCapabilities?.manual === true &&
      gate.stateCapabilities?.dispatchable !== true
    ).length,
    enabled: gates.filter((gate) =>
      gate.stateCapabilities?.dispatchable === true
    ).length,
    highRisk: gates.filter((gate) => gate.risk === "high").length,
    safeToAutoApply: 0,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function listValue(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonObject => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function deviceManifestTool(
  tool: ToolCatalogEntry,
  device: JsonObject | null,
  deviceAvailable: boolean,
): JsonObject {
  const available = tool.requiresDevice ? deviceAvailable : true;
  return {
    id: tool.id,
    name: tool.name,
    source: tool.source,
    category: tool.category,
    risk: tool.risk,
    requiresDevice: tool.requiresDevice,
    available,
    availability: {
      directWs: available && tool.availability.directWs,
      edgeWorkflow: available && tool.availability.edgeWorkflow,
      serverRuntime: tool.availability.serverRuntime,
    },
    policy: {
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
    },
    blockers: available ? ["compiler_auto_use_disabled"] : ["device_not_available", "compiler_auto_use_disabled"],
  };
}

async function buildCapabilityManifest(device: JsonObject | null): Promise<JsonObject> {
  const deviceAvailable = typeof device?.status === "string"
    ? await resourceLifecycleStateMatches("devices", device.status, { dispatchable: true })
    : false;
  const tools = (await listToolCatalog({}))
    .map((tool) => deviceManifestTool(tool, device, deviceAvailable));
  const availableTools = tools.filter((tool) => tool.available === true).length;
  return {
    source: "server_inferred_manifest",
    publishedByDevice: false,
    deviceSelected: !!device,
    deviceId: device?.id ?? null,
    deviceName: device?.friendly_name ?? null,
    model: device?.model ?? null,
    androidVersion: device?.android_version ?? null,
    agentVersion: device?.agent_version ?? null,
    status: device?.status ?? null,
    lastSeenAt: device?.last_seen_at instanceof Date ? device.last_seen_at.toISOString() : device?.last_seen_at ?? null,
    compatibility: {
      available: deviceAvailable,
      availableTools,
      totalTools: tools.length,
    },
    tools,
  };
}

function scopeMatches(requestedScope: string | undefined, promotionScope: string | null): boolean {
  if (!requestedScope || !promotionScope) return false;
  return requestedScope === promotionScope;
}

function buildLimitedReusePlan(input: {
  awareness: JsonObject;
  capabilityManifest: JsonObject;
  requestedScope?: string;
}): JsonObject {
  const candidates = objectValue(input.awareness.candidates);
  const steps = listValue(candidates.steps);
  const manifestTools = new Set(listValue(input.capabilityManifest.tools)
    .filter((tool) => tool.available === true)
    .map((tool) => stringValue(tool.id))
    .filter((id): id is string => !!id));

  const items = steps.map((step) => {
    const action = stringValue(step.action);
    const promotionScope = stringValue(step.promotionScope);
    const stepScopeMatches = scopeMatches(input.requestedScope, promotionScope);
    const capabilityMatch = !!action && manifestTools.has(action);
    const blockers = new Set<string>(["compiler_auto_use_disabled"]);
    if (!stepScopeMatches) blockers.add("limited_reuse_scope_mismatch");
    if (!promotionScope) blockers.add("scope_not_declared");
    if (!capabilityMatch) blockers.add("capability_not_available");
    if (step.reusable !== true) blockers.add("limited_reuse_not_promoted");
    if (step.terminal === true) blockers.add("step_library_entry_revoked");
    blockers.add("step_not_compiler_eligible");

    return {
      stepId: step.id ?? null,
      action,
      name: step.name ?? null,
      libraryState: step.libraryState ?? null,
      promotionScope,
      requestedScope: input.requestedScope ?? null,
      scopeMatch: stepScopeMatches,
      capabilityMatch,
      wouldUse: false,
      safeToAutoApply: false,
      blockers: Array.from(blockers),
      notes: [
        "Limited reuse planning is read-only.",
        "No Step Library entry is selected while compiler auto-use is disabled.",
      ],
    };
  });

  return {
    mode: "limited_reuse_planning_read_only",
    requestedScope: input.requestedScope ?? null,
    items,
    summary: {
      candidates: items.length,
      scopeMatches: items.filter((item) => item.scopeMatch === true).length,
      capabilityMatches: items.filter((item) => item.capabilityMatch === true).length,
      wouldUse: 0,
      safeToAutoApply: 0,
    },
  };
}

export async function buildCompilerControlPlane(input: CompilerControlPlaneInput): Promise<JsonObject> {
  const gates = gateSummary(input.policyGates);
  const capabilityManifest = await buildCapabilityManifest(input.device ?? null);
  const limitedReusePlan = buildLimitedReusePlan({
    awareness: input.awareness,
    capabilityManifest,
    requestedScope: input.requestedScope,
  });
  const awarenessSummary = objectValue(input.awareness.summary);
  const decision = objectValue(input.awareness.decision);
  const dryRun = {
    mode: "scoped_compiler_dry_run_read_only",
    intent: input.intent ?? null,
    action: input.action ?? null,
    requestedScope: input.requestedScope ?? null,
    wouldUseStepLibrary: false,
    wouldChangePlan: false,
    wouldExecuteStepLibrary: false,
    selectedStepIds: [],
    selectedToolIds: [],
    safeToAutoApply: false,
    outcome: "blocked_by_policy",
    blockers: Array.from(new Set([
      ...stringList(decision.blockers),
      "compiler_auto_use_disabled",
      "execution_changing_disabled",
    ])),
    candidateCounts: awarenessSummary,
    policyGateSummary: gates,
  };

  return {
    intent: input.intent ?? null,
    action: input.action ?? null,
    requestedScope: input.requestedScope ?? null,
    policy: {
      readOnly: true,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      workflowCacheChanging: false,
      mode: "compiler_control_plane_read_only",
    },
    policyGates: {
      items: input.policyGates,
      summary: gates,
    },
    awareness: input.awareness,
    dryRun,
    capabilityManifest,
    limitedReusePlan,
    guardrails: [
      "Compiler Control Plane is read-only.",
      "Scoped dry-run never changes generated plans.",
      "Step Library entries are not auto-used or executed.",
      "Workflow cache and execution path remain unchanged.",
    ],
  };
}
