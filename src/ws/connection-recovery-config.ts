import { getDb } from "../db/client";

export interface ConnectionRecoveryPolicy {
  retry: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  maxAttempts: number;
  healthPollMs: number;
}

let policies = new Map<boolean, ConnectionRecoveryPolicy>();
let candidateCount = 0;
let configurationError: string | null = null;

function parsePolicy(payload: Record<string, unknown>): ConnectionRecoveryPolicy {
  const retry = payload.retry;
  const initialDelayMs = Number(payload.initialDelayMs);
  const maxDelayMs = Number(payload.maxDelayMs);
  const jitterMs = Number(payload.jitterMs);
  const maxAttempts = Number(payload.maxAttempts);
  const healthPollMs = Number(payload.healthPollMs);
  if (
    typeof retry !== "boolean"
    || !Number.isSafeInteger(initialDelayMs)
    || initialDelayMs <= 0
    || !Number.isSafeInteger(maxDelayMs)
    || maxDelayMs < initialDelayMs
    || !Number.isSafeInteger(jitterMs)
    || jitterMs < 0
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts <= 0
    || !Number.isSafeInteger(healthPollMs)
    || healthPollMs <= 0
  ) {
    throw new Error("invalid PostgreSQL connection recovery policy");
  }
  return {
    retry,
    initialDelayMs,
    maxDelayMs,
    jitterMs,
    maxAttempts,
    healthPollMs,
  };
}

export async function initializeConnectionRecoveryPolicies(): Promise<boolean> {
  const result = await getDb().query<{ payload: Record<string, unknown> }>(
    `SELECT entry.payload
       FROM runtime_semantic_entries entry
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE definition.dispatchable
        AND entry.payload ?& ARRAY[
          'retry',
          'initialDelayMs',
          'maxDelayMs',
          'jitterMs',
          'maxAttempts',
          'healthPollMs'
        ]
      ORDER BY entry.priority DESC, entry.id`,
  );
  candidateCount = result.rows.length;
  const next = new Map<boolean, ConnectionRecoveryPolicy>();
  try {
    for (const row of result.rows) {
      const policy = parsePolicy(row.payload);
      if (next.has(policy.retry)) {
        throw new Error("PostgreSQL exposes duplicate connection recovery policies");
      }
      next.set(policy.retry, policy);
    }
    if (!next.has(true) || !next.has(false) || next.size !== 2) {
      throw new Error("PostgreSQL must expose one retry and one stop connection recovery policy");
    }
    policies = next;
    configurationError = null;
    return true;
  } catch (err) {
    policies = new Map();
    configurationError = (err as Error).message;
    return false;
  }
}

export function getConnectionRecoveryPolicy(retry: boolean): ConnectionRecoveryPolicy | null {
  const policy = policies.get(retry);
  return policy ? { ...policy } : null;
}

export function describeConnectionRecoveryPolicies(): {
  ready: boolean;
  candidateCount: number;
  error: string | null;
} {
  return {
    ready: policies.size === 2,
    candidateCount,
    error: configurationError,
  };
}

export function setConnectionRecoveryPoliciesForTest(
  configured: ConnectionRecoveryPolicy[] | null,
): void {
  policies = new Map((configured ?? []).map((policy) => [policy.retry, { ...policy }]));
  candidateCount = configured?.length ?? 0;
  configurationError = null;
}
