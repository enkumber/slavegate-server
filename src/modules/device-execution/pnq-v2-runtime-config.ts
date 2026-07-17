export type PnqV2RuntimeMode = "disabled" | "shadow";

export interface PnqV2RuntimeConfig {
  mode: PnqV2RuntimeMode;
  sweepIntervalMs: number;
}

let testOverride: PnqV2RuntimeConfig | null = null;

function normalizeMode(value: string | undefined): PnqV2RuntimeMode {
  return value === "shadow" ? "shadow" : "disabled";
}

export function getPnqV2RuntimeConfig(): PnqV2RuntimeConfig {
  if (testOverride) return testOverride;
  return {
    mode: normalizeMode(process.env.PNQ_V2_RUNTIME_MODE),
    sweepIntervalMs: Number(process.env.PNQ_V2_SWEEP_INTERVAL_MS ?? 30_000),
  };
}

export function isPnqV2ShadowRuntimeEnabled(): boolean {
  return getPnqV2RuntimeConfig().mode === "shadow";
}

export function describePnqV2RuntimeConfig(): PnqV2RuntimeConfig {
  return getPnqV2RuntimeConfig();
}

export function setPnqV2RuntimeConfigForTest(config: PnqV2RuntimeConfig | null): void {
  testOverride = config;
}
