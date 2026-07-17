export type PnqV2RuntimeMode = "disabled" | "shadow";

export interface PnqV2RuntimeConfig {
  mode: PnqV2RuntimeMode;
  sweepIntervalMs: number;
}

let testOverride: PnqV2RuntimeConfig | null = null;

function normalizeMode(value: string | undefined): PnqV2RuntimeMode {
  return value === "shadow" ? "shadow" : "disabled";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const startupConfig: PnqV2RuntimeConfig = {
  mode: normalizeMode(process.env.PNQ_V2_RUNTIME_MODE),
  sweepIntervalMs: parsePositiveInteger(process.env.PNQ_V2_SWEEP_INTERVAL_MS, 30_000),
};

export function getPnqV2RuntimeConfig(): PnqV2RuntimeConfig {
  if (testOverride) return { ...testOverride };
  return {
    ...startupConfig,
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
