import { getDb } from "../../db/client";

export interface PnqV2RuntimeConfig {
  enabled: boolean;
  sweepIntervalMs: number;
}

let runtimeConfig: PnqV2RuntimeConfig = {
  enabled: false,
  sweepIntervalMs: 0,
};
let testOverride: PnqV2RuntimeConfig | null = null;

export async function initializePnqV2RuntimeConfig(): Promise<PnqV2RuntimeConfig> {
  const result = await getDb().query<{ payload: Record<string, unknown> }>(
    `SELECT entry.payload
       FROM runtime_semantic_entries entry
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table = to_regclass('runtime_semantic_entries')
        AND binding.lifecycle_key = entry.lifecycle_key
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE entry.namespace = $1
        AND entry.entry_key = $2
        AND definition.dispatchable
      LIMIT 1`,
    ["device_execution_runtime", "pnq_v2"],
  );
  const payload = result.rows[0]?.payload;
  if (!payload) {
    runtimeConfig = { enabled: false, sweepIntervalMs: 0 };
    return { ...runtimeConfig };
  }
  if (
    typeof payload.enabled !== "boolean"
    || !Number.isInteger(payload.sweepIntervalMs)
    || Number(payload.sweepIntervalMs) <= 0
  ) {
    throw new Error("invalid PostgreSQL PNQ runtime policy");
  }
  runtimeConfig = {
    enabled: payload.enabled,
    sweepIntervalMs: Number(payload.sweepIntervalMs),
  };
  return { ...runtimeConfig };
}

export function getPnqV2RuntimeConfig(): PnqV2RuntimeConfig {
  return { ...(testOverride ?? runtimeConfig) };
}

export function isPnqV2ShadowRuntimeEnabled(): boolean {
  return getPnqV2RuntimeConfig().enabled;
}

export function describePnqV2RuntimeConfig(): PnqV2RuntimeConfig {
  return getPnqV2RuntimeConfig();
}

export function setPnqV2RuntimeConfigForTest(config: PnqV2RuntimeConfig | null): void {
  testOverride = config;
}
