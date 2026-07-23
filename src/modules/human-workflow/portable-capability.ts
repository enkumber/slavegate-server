import type { GeneratedWorkflowPlanCacheRecord } from "../workflows/workflow.service";
import type { WorkflowTemplate } from "../workflows/types";

const CAPABILITY_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const NON_SEMANTIC_TOKENS = new Set([
  "agent",
  "artifact",
  "cached",
  "canonical",
  "dashboard",
  "generated",
  "human",
  "trace",
  "verified",
  "workflow",
]);
const STOP_WORDS = new Set([
  "a",
  "acest",
  "acestui",
  "ai",
  "al",
  "an",
  "and",
  "app",
  "application",
  "aplicatia",
  "aplicatie",
  "aplicația",
  "aplicație",
  "ca",
  "can",
  "catre",
  "către",
  "cu",
  "de",
  "device",
  "do",
  "for",
  "in",
  "la",
  "mai",
  "on",
  "pe",
  "please",
  "sa",
  "să",
  "the",
  "this",
  "to",
  "un",
  "unei",
  "vreau",
]);

const GENERIC_TOKEN_ALIASES: Record<string, string> = {
  activeaza: "enable",
  activează: "enable",
  activate: "enable",
  activated: "enable",
  activating: "enable",
  activa: "enable",
  enable: "enable",
  enabled: "enable",
  enabling: "enable",
  porneste: "enable",
  pornește: "enable",
  porneasca: "enable",
  pornească: "enable",
  start: "enable",
  started: "enable",
  starting: "enable",
  ecran: "screen",
  screen: "screen",
  share: "share",
  shared: "share",
  shares: "share",
  sharing: "share",
  cauta: "search",
  caută: "search",
  search: "search",
  searching: "search",
  deschide: "open",
  deschisa: "open",
  deschisă: "open",
  open: "open",
  opened: "open",
  opening: "open",
  instaleaza: "install",
  instalează: "install",
  install: "install",
  installed: "install",
  installing: "install",
  opreste: "stop",
  oprește: "stop",
  stop: "stop",
  stopped: "stop",
  stopping: "stop",
};

function asciiFold(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeToken(raw: string): string | null {
  const folded = asciiFold(raw.toLowerCase()).replace(/[^a-z0-9]/g, "");
  if (!folded || STOP_WORDS.has(folded) || NON_SEMANTIC_TOKENS.has(folded) || /^v?\d+$/.test(folded)) {
    return null;
  }
  return GENERIC_TOKEN_ALIASES[raw.toLowerCase()] ?? GENERIC_TOKEN_ALIASES[folded] ?? folded;
}

export function portableCapabilityTokens(value: string): string[] {
  return [...new Set(
    value
      .split(/[^\p{L}\p{N}]+/u)
      .map(normalizeToken)
      .filter((token): token is string => !!token),
  )];
}

export function derivePortableCapabilityKey(
  workflow: Pick<WorkflowTemplate, "id" | "intent" | "name">,
  sourceIntent?: unknown,
): string | null {
  const explicitIntent = typeof workflow.intent === "string" && workflow.intent.trim()
    ? workflow.intent
    : typeof sourceIntent === "string" && sourceIntent.trim()
      ? sourceIntent
      : null;
  const source = explicitIntent ?? workflow.id ?? workflow.name;
  const tokens = portableCapabilityTokens(source);
  return tokens.length >= 2 ? tokens.join("_") : null;
}

function hasRuntimeBinding(value: unknown, key = ""): boolean {
  if (Array.isArray(value)) return value.some((item) => hasRuntimeBinding(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) => {
    const normalizedKey = asciiFold(childKey).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["accountid", "clientid", "deviceid"].includes(normalizedKey)) return true;
    return hasRuntimeBinding(childValue, childKey);
  });
}

export function inferPortableWorkflow(workflow: WorkflowTemplate, sourceMetadata: Record<string, unknown>): boolean {
  if (sourceMetadata.portable === false || sourceMetadata.portabilityScope === "device" || sourceMetadata.portabilityScope === "account") {
    return false;
  }
  if (sourceMetadata.portable === true) return true;
  return !hasRuntimeBinding(workflow);
}

export function portableCapabilityMetadata(
  workflow: WorkflowTemplate,
  sourceMetadata: Record<string, unknown>,
): { capabilityKey?: string; portable: boolean; portabilityScope: "global" | "contextual" } {
  const explicit = typeof sourceMetadata.capabilityKey === "string"
    && CAPABILITY_KEY_RE.test(sourceMetadata.capabilityKey)
    ? sourceMetadata.capabilityKey
    : null;
  const capabilityKey = explicit ?? derivePortableCapabilityKey(workflow, sourceMetadata.intent);
  const portable = inferPortableWorkflow(workflow, sourceMetadata);
  return {
    ...(capabilityKey ? { capabilityKey } : {}),
    portable,
    portabilityScope: portable ? "global" : "contextual",
  };
}

function capabilityDescriptorTokenSets(record: GeneratedWorkflowPlanCacheRecord): string[][] {
  const metadataKey = typeof record.sourceMetadata.capabilityKey === "string"
    ? record.sourceMetadata.capabilityKey
    : "";
  return [
    metadataKey,
    record.workflow.intent ?? "",
    record.workflow.id,
    record.workflow.name,
    record.workflow.description ?? "",
  ]
    .map(portableCapabilityTokens)
    .filter((tokens) => tokens.length > 0);
}

function platformCompatible(record: GeneratedWorkflowPlanCacheRecord, platform: string): boolean {
  const wanted = asciiFold(platform).trim().toLowerCase();
  const actual = asciiFold(record.platform).trim().toLowerCase();
  if (actual === wanted) return true;
  const supported = record.sourceMetadata.supportedPlatforms;
  return Array.isArray(supported)
    && supported.some((value) => typeof value === "string" && asciiFold(value).trim().toLowerCase() === wanted);
}

function similarity(queryTokens: string[], descriptorTokens: string[]): number {
  if (queryTokens.length === 0 || descriptorTokens.length === 0) return 0;
  const descriptor = new Set(descriptorTokens);
  const shared = queryTokens.filter((token) => descriptor.has(token)).length;
  if (shared < 2) return 0;
  const queryCoverage = shared / queryTokens.length;
  const descriptorCoverage = shared / descriptorTokens.length;
  return (2 * queryCoverage * descriptorCoverage) / (queryCoverage + descriptorCoverage);
}

export interface PortableCapabilityResolution {
  record: GeneratedWorkflowPlanCacheRecord;
  capabilityKey: string;
  score: number;
}

export function resolvePortableCapabilityArtifact(
  intent: string,
  platform: string,
  candidates: GeneratedWorkflowPlanCacheRecord[],
): PortableCapabilityResolution | null {
  const queryTokens = portableCapabilityTokens(intent);
  const ranked = candidates
    .filter((candidate) =>
      candidate.artifactState === "promoted"
      && inferPortableWorkflow(candidate.workflow, candidate.sourceMetadata)
      && platformCompatible(candidate, platform)
    )
    .map((record) => {
      const capabilityKey = typeof record.sourceMetadata.capabilityKey === "string"
        ? record.sourceMetadata.capabilityKey
        : derivePortableCapabilityKey(record.workflow, record.sourceMetadata.intent);
      return {
        record,
        capabilityKey,
        score: Math.max(
          0,
          ...capabilityDescriptorTokenSets(record).map((tokens) => similarity(queryTokens, tokens)),
        ),
      };
    })
    .filter((match): match is PortableCapabilityResolution => !!match.capabilityKey)
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));

  const best = ranked[0];
  if (!best || best.score < 0.62) return null;
  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < 0.12) return null;
  return best;
}
