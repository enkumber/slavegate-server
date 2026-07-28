import { getResourceRuntimePolicy } from "../runtime-policy/resource-runtime-policy.service";
import type { StateResolutionPolicy } from "./state-resolver";

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be configured as an array`);
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length !== value.length) {
    throw new Error(`${field} must contain only non-empty strings`);
  }
  return [...new Set(values)];
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be configured as a positive integer`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${field} must be configured as a finite number >= ${minimum}`);
  }
  return value;
}

export interface UiGraphScopePolicy {
  scopeType: string;
  contextField: string | null;
  scopeValue: string | null;
}

export async function uiGraphScopePolicy(): Promise<UiGraphScopePolicy[]> {
  const policy = await getResourceRuntimePolicy("ui_graph_runtime_flags");
  if (!Array.isArray(policy.scopes) || policy.scopes.length === 0) {
    throw new Error("scopes must be configured as a non-empty array");
  }
  return policy.scopes.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`scopes[${index}] must be an object`);
    }
    const scope = raw as Record<string, unknown>;
    const scopeType = typeof scope.scopeType === "string" ? scope.scopeType.trim() : "";
    const contextField = typeof scope.contextField === "string" ? scope.contextField.trim() : null;
    const scopeValue = typeof scope.scopeValue === "string" ? scope.scopeValue.trim() : null;
    if (!scopeType || (!!contextField === !!scopeValue)) {
      throw new Error(`scopes[${index}] requires scopeType and exactly one value source`);
    }
    return { scopeType, contextField, scopeValue };
  });
}

export async function allowedUiGraphScopeTypes(): Promise<Set<string>> {
  return new Set((await uiGraphScopePolicy()).map((scope) => scope.scopeType));
}

export async function workflowCanaryCohortDefaults(): Promise<{
  safetyClasses: string[];
  requiredDistinctDevices: number;
  requiredDistinctBranches: number;
}> {
  const policy = await getResourceRuntimePolicy("workflow_canary_cohorts");
  return {
    safetyClasses: stringList(policy.safetyClasses, "safetyClasses"),
    requiredDistinctDevices: positiveInteger(
      policy.requiredDistinctDevices,
      "requiredDistinctDevices",
    ),
    requiredDistinctBranches: positiveInteger(
      policy.requiredDistinctBranches,
      "requiredDistinctBranches",
    ),
  };
}

export async function uiGraphStateResolutionPolicy(): Promise<StateResolutionPolicy> {
  const policy = await getResourceRuntimePolicy("ui_graph_state_variants");
  if (!policy.anchorWeights || typeof policy.anchorWeights !== "object" || Array.isArray(policy.anchorWeights)) {
    throw new Error("anchorWeights must be configured as an object");
  }
  const anchorWeights = Object.fromEntries(
    Object.entries(policy.anchorWeights as Record<string, unknown>).map(([key, value]) => [
      key,
      finiteNumber(value, `anchorWeights.${key}`),
    ]),
  );
  return {
    anchorWeights,
    defaultAnchorWeight: finiteNumber(policy.defaultAnchorWeight, "defaultAnchorWeight"),
    emptyRequiredScore: finiteNumber(policy.emptyRequiredScore, "emptyRequiredScore"),
    maximumFuzzyConfidence: finiteNumber(policy.maximumFuzzyConfidence, "maximumFuzzyConfidence"),
    requiredAnchorContribution: finiteNumber(
      policy.requiredAnchorContribution,
      "requiredAnchorContribution",
    ),
    optionalAnchorContribution: finiteNumber(
      policy.optionalAnchorContribution,
      "optionalAnchorContribution",
    ),
    ambiguityMargin: finiteNumber(policy.ambiguityMargin, "ambiguityMargin"),
  };
}
