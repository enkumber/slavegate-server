import type { RuntimeFlags } from "./types";

let testOverride: RuntimeFlags | null = null;

const failClosedFlags: RuntimeFlags = {
  enabled: false,
  selectorFirst: false,
  graphRuntime: false,
  aiRecovery: false,
  candidateLearning: false,
  autoPromotion: false,
  config: {},
};

export function getUiGraphRuntimeFlags(): RuntimeFlags {
  return { ...(testOverride ?? failClosedFlags) };
}

export function setUiGraphRuntimeFlagsForTest(flags: RuntimeFlags | null): void {
  testOverride = flags ? { ...flags } : null;
}

export function describeUiGraphRuntimeFlags(): RuntimeFlags {
  return getUiGraphRuntimeFlags();
}
