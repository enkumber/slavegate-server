import {
  uiGraphActionLatency,
  uiGraphActions,
  uiGraphLearningCandidates,
  uiGraphRecovery,
  uiGraphStateResolutions,
  uiGraphTargetResolutions,
} from "../observability/metrics";
import type { StateResolution, TargetResolution, TargetResolutionMethod } from "./types";

export function observeStateResolution(appId: string, resolution: StateResolution): void {
  uiGraphStateResolutions?.labels(appId, resolution.method, resolution.stateId ? "resolved" : "unknown").inc();
}

export function observeTargetResolution(appId: string, resolution: TargetResolution): void {
  uiGraphTargetResolutions?.labels(appId, resolution.method, resolution.found ? "resolved" : "unknown").inc();
}

export function observeUiGraphAction(input: {
  appId: string;
  path: TargetResolutionMethod | "graph" | "legacy" | "recovery";
  outcome: string;
  latencyMs: number;
}): void {
  uiGraphActions?.labels(input.appId, input.path, input.outcome).inc();
  uiGraphActionLatency?.labels(input.appId, input.path).observe(Math.max(0, input.latencyMs) / 1000);
}

export function observeRecovery(appId: string, level: "deterministic" | "ui_tree_llm" | "vlm", outcome: string): void {
  uiGraphRecovery?.labels(appId, level, outcome).inc();
}

export function observeLearningCandidate(appId: string, type: string, event: string): void {
  uiGraphLearningCandidates?.labels(appId, type, event).inc();
}
