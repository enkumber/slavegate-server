import { afterEach, describe, expect, it, vi } from "vitest";

import { uiGraphRepository } from "../../ui-graph/repository";
import { recoveryLearningCandidate } from "../recovery.service";
import type { CompiledStep, CompiledWorkflow } from "../types";

const workflow: CompiledWorkflow = {
  id: "workflow-1",
  name: "selector learning",
  source: "controlled recovery",
  appId: "com.example.app",
  compiledAt: "2026-07-21T00:00:00.000Z",
  appMapVersion: "1",
  startPage: "search",
  maxRecoveryAttempts: 1,
  maxTotalRecoveryAttempts: 1,
  steps: [],
};

const failedStep: CompiledStep = {
  id: "stale-search",
  action: "tap",
  target: { resourceId: "com.example.app:id/stale_search" },
  expectedPage: "search",
  expectedPageHash: "hash",
  retries: 0,
  retryDelay: 0,
  description: "recover search",
};

describe("recovery learning candidate", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("stages a promotable selector candidate for a verified semantic adaptation", async () => {
    vi.spyOn(uiGraphRepository, "loadStates").mockResolvedValue([{
      id: "state-search",
      key: "search",
      appId: workflow.appId,
      name: "Search",
      kind: "screen",
      safetyClass: "navigation",
      variants: [],
    }]);

    const candidate = await recoveryLearningCandidate({
      workflow,
      failedStep,
      recoveryAction: {
        type: "retry_with_adaptation",
        adaptedStep: { ...failedStep, target: { resourceId: "com.example.app:id/search_bar_field", text: "Search" } },
      },
      reason: "action_failed:selector missing",
      graphContext: { appId: workflow.appId, deviceId: "device-1", workflowId: workflow.id },
      currentFingerprint: "fingerprint",
      screenshotAvailable: false,
      usedVision: false,
    });

    expect(candidate).toMatchObject({
      type: "selector",
      sourceStateId: "state-search",
      payload: {
        elementKey: "search_bar_field",
        strategy: "resource_id",
        selector: { value: "com.example.app:id/search_bar_field" },
        priority: 10,
        dynamic: false,
      },
      discoveryMethod: "llm_recovery",
    });
  });

  it("keeps non-selector adaptations as manually materialized recovery rules", async () => {
    vi.spyOn(uiGraphRepository, "loadStates").mockResolvedValue([]);
    const candidate = await recoveryLearningCandidate({
      workflow,
      failedStep,
      recoveryAction: { type: "navigate_back_and_retry", backSteps: 1 },
      reason: "post_action_mismatch",
      graphContext: { appId: workflow.appId, deviceId: "device-1", workflowId: workflow.id },
      screenshotAvailable: false,
      usedVision: false,
    });
    expect(candidate.type).toBe("recovery_rule");
  });
});
