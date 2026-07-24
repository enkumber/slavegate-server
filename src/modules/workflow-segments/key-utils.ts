import crypto from "crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function shortKey(namespace: string, value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${namespace}:${stableJson(value)}`)
    .digest("hex")
    .slice(0, 24);
}

export function fullFingerprint(namespace: string, value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${namespace}:${stableJson(value)}`)
    .digest("hex");
}

export function computeExecutionKey(input: {
  deviceId: string;
  accountId: string | null;
  compositionKey: string;
  runtimeInputs: Record<string, unknown>;
}): string {
  return shortKey("workflow-execution-v1", input);
}
