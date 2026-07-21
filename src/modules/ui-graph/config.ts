import type { RuntimeFlags, UiGraphRuntimeMode } from "./types";

let testOverride: RuntimeFlags | null = null;

function mode(value: string | undefined): UiGraphRuntimeMode {
  return value === "shadow" || value === "enforced" ? value : "disabled";
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const startupFlags: RuntimeFlags = {
  mode: mode(process.env.UI_GRAPH_RUNTIME_MODE),
  selectorFirst: enabled(process.env.UI_GRAPH_SELECTOR_FIRST, true),
  graphRuntime: enabled(process.env.UI_GRAPH_GRAPH_RUNTIME, true),
  aiRecovery: enabled(process.env.UI_GRAPH_AI_RECOVERY, true),
  candidateLearning: enabled(process.env.UI_GRAPH_CANDIDATE_LEARNING, true),
  autoPromotion: enabled(process.env.UI_GRAPH_AUTO_PROMOTION, false),
};

export function getUiGraphRuntimeFlags(): RuntimeFlags {
  return { ...(testOverride ?? startupFlags) };
}

export function setUiGraphRuntimeFlagsForTest(flags: RuntimeFlags | null): void {
  testOverride = flags ? { ...flags } : null;
}

export function describeUiGraphRuntimeFlags(): RuntimeFlags {
  return getUiGraphRuntimeFlags();
}
