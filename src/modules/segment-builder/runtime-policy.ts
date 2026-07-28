import { getResourceRuntimePolicy } from "../runtime-policy/resource-runtime-policy.service";

export interface SegmentBuilderRuntimePolicy {
  agentId: string;
  dispatcherId: string;
  apiTokenPurpose: string;
  agentTokenHmacContext: string;
  hookTokenHmacContext: string;
  managedBy: string;
  serverActor: string;
  sessionKeyPrefix: string;
  callbackProtocols: string[];
  callbackPort: string;
  callbackPath: string;
  requireCallbackAddressMatch: boolean;
  candidateSafetyClasses: string[];
  capabilityMetadata: Record<string, unknown>;
  dispatcherTtlMs: number;
  agentTokenTtlMs: number;
  leaseDurationMs: number;
  dispatchTimeoutMs: number;
  recoverySweepIntervalMs: number;
  sweepLimit: number;
  offlineQueuedCanaryTimeoutMs: number;
  recoveryRedispatchGuardMs: number;
}

function stringValue(policy: Record<string, unknown>, field: string): string {
  const value = policy[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`segment builder policy ${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringList(policy: Record<string, unknown>, field: string): string[] {
  const value = policy[field];
  if (!Array.isArray(value)) {
    throw new Error(`segment builder policy ${field} must be an array`);
  }
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length !== value.length) {
    throw new Error(`segment builder policy ${field} must contain only non-empty strings`);
  }
  return [...new Set(values)];
}

function positiveInteger(policy: Record<string, unknown>, field: string): number {
  const value = policy[field];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`segment builder policy ${field} must be a positive integer`);
  }
  return Number(value);
}

function booleanValue(policy: Record<string, unknown>, field: string): boolean {
  if (typeof policy[field] !== "boolean") {
    throw new Error(`segment builder policy ${field} must be a boolean`);
  }
  return policy[field] as boolean;
}

function objectValue(policy: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = policy[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`segment builder policy ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export async function segmentBuilderRuntimePolicy(): Promise<SegmentBuilderRuntimePolicy> {
  const policy = await getResourceRuntimePolicy("segment_build_jobs");
  return {
    agentId: stringValue(policy, "agentId"),
    dispatcherId: stringValue(policy, "dispatcherId"),
    apiTokenPurpose: stringValue(policy, "apiTokenPurpose"),
    agentTokenHmacContext: stringValue(policy, "agentTokenHmacContext"),
    hookTokenHmacContext: stringValue(policy, "hookTokenHmacContext"),
    managedBy: stringValue(policy, "managedBy"),
    serverActor: stringValue(policy, "serverActor"),
    sessionKeyPrefix: stringValue(policy, "sessionKeyPrefix"),
    callbackProtocols: stringList(policy, "callbackProtocols"),
    callbackPort: stringValue(policy, "callbackPort"),
    callbackPath: stringValue(policy, "callbackPath"),
    requireCallbackAddressMatch: booleanValue(policy, "requireCallbackAddressMatch"),
    candidateSafetyClasses: stringList(policy, "candidateSafetyClasses"),
    capabilityMetadata: objectValue(policy, "capabilityMetadata"),
    dispatcherTtlMs: positiveInteger(policy, "dispatcherTtlMs"),
    agentTokenTtlMs: positiveInteger(policy, "agentTokenTtlMs"),
    leaseDurationMs: positiveInteger(policy, "leaseDurationMs"),
    dispatchTimeoutMs: positiveInteger(policy, "dispatchTimeoutMs"),
    recoverySweepIntervalMs: positiveInteger(policy, "recoverySweepIntervalMs"),
    sweepLimit: positiveInteger(policy, "sweepLimit"),
    offlineQueuedCanaryTimeoutMs: positiveInteger(policy, "offlineQueuedCanaryTimeoutMs"),
    recoveryRedispatchGuardMs: positiveInteger(policy, "recoveryRedispatchGuardMs"),
  };
}
