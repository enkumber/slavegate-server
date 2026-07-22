import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("uuid", () => ({
  v4: () => "mock-job-id",
}));

vi.mock("../../../transport/transport", () => ({
  sendJobToDevice: vi.fn().mockReturnValue(true),
  sendDeviceExecutionJobToDevice: vi.fn().mockResolvedValue({ sent: true }),
  sendServerWorkflowBatchChildToDevice: vi.fn(),
  isDeviceOnline: vi.fn().mockReturnValue(true),
  waitForResult: vi.fn().mockResolvedValue({ status: "completed", output: {} }),
}));

vi.mock("../../device-execution", () => ({
  deviceExecutionArbiter: {
    observeAdmission: vi.fn().mockResolvedValue({ decision: "admitted", root: null }),
    finishServerWorkflowRoot: vi.fn().mockResolvedValue({ decision: "terminal", root: null }),
    markAmbiguous: vi.fn().mockResolvedValue({ decision: "ambiguous", root: null }),
  },
}));

vi.mock("../../../ws/direct-ws.server", () => ({
  directWsServer: {
    sendBatch: vi.fn(),
    waitForBatchResult: vi.fn(),
  },
}));

vi.mock("../../app-mapping/page-fingerprint", () => ({
  computePageSignature: vi.fn().mockReturnValue("actual_hash"),
  isSamePage: vi.fn().mockReturnValue(false),
}));

vi.mock("../planner.service", () => ({
  updateWorkflowStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../observability/metrics", () => ({
  generatedWorkflowRecoveryAttempts: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
  generatedWorkflowRecoveryBudgetExhausted: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
  uiGraphLearningCandidates: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
}));

vi.mock("../../ui-graph/learning-loop", () => ({
  uiGraphLearningLoop: {
    observe: vi.fn().mockResolvedValue("candidate-1"),
    validate: vi.fn().mockResolvedValue({ ready: false, autoPromotable: false, blockers: ["insufficient_successes"] }),
  },
}));

import {
  runCompiledWorkflow,
  RECOVERY_BUDGET_EXCEEDED,
  reconcileFingerprintWithResolvedState,
} from "../runner.service";
import type { CompiledWorkflow } from "../types";
import { sendDeviceExecutionJobToDevice, sendJobToDevice, waitForResult } from "../../../transport/transport";
import {
  generatedWorkflowRecoveryAttempts,
  generatedWorkflowRecoveryBudgetExhausted,
} from "../../observability/metrics";
import { deviceExecutionArbiter } from "../../device-execution";
import { updateWorkflowStatus } from "../planner.service";
import { uiGraphLearningLoop } from "../../ui-graph/learning-loop";

function makeWorkflow(overrides: Partial<CompiledWorkflow> = {}): CompiledWorkflow {
  return {
    id: "wf-runner-budget",
    name: "Runner Budget Test",
    source: "Open Reddit and read the first visible post",
    appId: "com.reddit.frontpage",
    compiledAt: "2026-05-22T00:00:00.000Z",
    steps: [
      {
        id: "step-1",
        action: "wait",
        expectedPage: "reddit_home",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Wait briefly",
        params: { durationMs: 1 },
      },
    ],
    appMapVersion: "1",
    startPage: "reddit_home",
    maxRecoveryAttempts: 1,
    maxTotalRecoveryAttempts: 10,
    ...overrides,
    recoveryModel: overrides.recoveryModel ?? "openai-codex/gpt-5.5",
  };
}

describe("runCompiledWorkflow recovery budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendJobToDevice).mockReturnValue(true);
    vi.mocked(waitForResult).mockResolvedValue({ status: "completed", output: {} });
    vi.mocked(updateWorkflowStatus).mockResolvedValue(undefined);
    vi.mocked(deviceExecutionArbiter.observeAdmission).mockResolvedValue({ decision: "admitted", root: null });
    vi.mocked(deviceExecutionArbiter.finishServerWorkflowRoot).mockResolvedValue({ decision: "terminal", root: null });
    vi.mocked(deviceExecutionArbiter.markAmbiguous).mockResolvedValue({ decision: "ambiguous", root: null });
  });

  it("keeps happy-path token and recovery usage at zero", async () => {
    const result = await runCompiledWorkflow(
      { deviceId: "device-1", workflow: makeWorkflow() },
      vi.fn().mockResolvedValue(false)
    );

    expect(result.ok).toBe(true);
    expect(result.counters.compileLlmCalls).toBe(0);
    expect(result.counters.recoveryLlmCalls).toBe(0);
    expect(result.counters.runtimeLlmCalls).toBe(0);
    expect(result.counters.vlmCalls).toBe(0);
    expect(result.counters.recoveryAttempts).toBe(0);
    expect(result.counters.recoveryBudgetExhausted).toBe(0);
    expect(generatedWorkflowRecoveryAttempts?.labels).not.toHaveBeenCalled();
    expect(generatedWorkflowRecoveryBudgetExhausted?.labels).not.toHaveBeenCalled();
  });

  it("executes screen readiness actions as normal queued compiled steps", async () => {
    const workflow = makeWorkflow({
      steps: [
        { id: "wake", action: "screen_wake", expectedPage: "", expectedPageHash: "", retries: 0, retryDelay: 0, description: "Wake" },
        { id: "unlock", action: "unlock", expectedPage: "", expectedPageHash: "", retries: 0, retryDelay: 0, description: "Unlock" },
      ],
    });

    const result = await runCompiledWorkflow(
      { deviceId: "device-1", workflow },
      vi.fn().mockResolvedValue(false),
    );

    expect(result.ok).toBe(true);
    const dispatched = vi.mocked(sendDeviceExecutionJobToDevice).mock.calls.map((call) => call[1]);
    expect(dispatched.map((payload) => payload.type)).toEqual([
      "screen_wake",
      "unlock",
    ]);
    expect(dispatched.every((payload) => payload.verificationStrategy === "local_only")).toBe(true);
  });

  it("preserves DB-profile package and action constraints for intent_send", async () => {
    vi.mocked(waitForResult).mockResolvedValueOnce({
      status: "completed",
      output: { resolvedActivity: "com.reddit.frontpage/com.reddit.frontpage.RedditDeepLinkActivity" },
    });
    const workflow = makeWorkflow({
      steps: [{
        id: "canonical-search",
        action: "intent_send",
        expectedPage: "reddit_search_surface",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Open canonical search in the intended package",
        params: {
          uri: "https://www.reddit.com/search/?q=AskReddit",
          packageName: "com.reddit.frontpage",
          action: "android.intent.action.VIEW",
        },
      }],
    });

    const result = await runCompiledWorkflow(
      { deviceId: "device-1", workflow },
      vi.fn().mockResolvedValue(false),
    );

    expect(result.ok).toBe(true);
    expect(sendDeviceExecutionJobToDevice).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        type: "intent_send",
        verificationStrategy: "local_only",
        params: {
          uri: "https://www.reddit.com/search/?q=AskReddit",
          packageName: "com.reddit.frontpage",
          action: "android.intent.action.VIEW",
        },
      }),
      expect.any(Object),
    );
  });

  it("fails closed when a constrained intent resolves outside the requested package", async () => {
    vi.mocked(waitForResult).mockResolvedValueOnce({
      status: "completed",
      output: { resolvedActivity: "com.android.chrome/com.google.android.apps.chrome.Main" },
    });
    const workflow = makeWorkflow({
      steps: [{
        id: "canonical-search",
        action: "intent_send",
        expectedPage: "reddit_search_surface",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Open canonical search in Reddit",
        params: {
          uri: "https://www.reddit.com/search/?q=AskReddit",
          packageName: "com.reddit.frontpage",
          action: "android.intent.action.VIEW",
        },
      }],
    });

    const result = await runCompiledWorkflow(
      { deviceId: "device-1", workflow },
      vi.fn().mockResolvedValue(false),
    );

    expect(result.ok).toBe(false);
    expect(result.results[0]?.error).toContain("Intent package verification failed");
  });

  it("allows one recovery after deterministic failure then fails explicitly when the step budget is exhausted", async () => {
    const workflow = makeWorkflow({
      steps: [
        {
          id: "step-1",
          action: "tap",
          target: { coords: { x: 0.5, y: 0.5 } },
          expectedPage: "reddit_home",
          expectedPageHash: "expected_hash",
          retries: 0,
          retryDelay: 0,
          description: "Tap visible Reddit item",
        },
      ],
    });
    const onRecoveryNeeded = vi.fn().mockResolvedValue(true);

    const result = await runCompiledWorkflow(
      { deviceId: "device-1", workflow },
      onRecoveryNeeded
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(result.recoveryCount).toBe(1);
    expect(result.counters.recoveryAttempts).toBe(1);
    expect(result.counters.recoveryLlmCalls).toBe(1);
    expect(result.counters.runtimeLlmCalls).toBe(1);
    expect(result.counters.recoveryBudgetExhausted).toBe(1);
    expect(result.results[0]?.error).toBe(RECOVERY_BUDGET_EXCEEDED);
    expect(result.results[0]?.stateEvidence).toMatchObject({
      expectedPage: "reddit_home",
      expectedHash: "expected_hash",
      actualHash: "actual_hash",
    });
    expect(generatedWorkflowRecoveryAttempts?.labels).toHaveBeenCalledWith("reddit", "fingerprint_mismatch");
    expect(generatedWorkflowRecoveryBudgetExhausted?.labels).toHaveBeenCalledWith("reddit");
  });

  it("honors an explicit zero recovery budget without calling the recovery model", async () => {
    const workflow = makeWorkflow({
      maxRecoveryAttempts: 0,
      maxTotalRecoveryAttempts: 0,
      steps: [{
        id: "step-1",
        action: "tap",
        target: { coords: { x: 0.5, y: 0.5 } },
        expectedPage: "reddit_home",
        expectedPageHash: "expected_hash",
        retries: 0,
        retryDelay: 0,
        description: "Fail closed without recovery",
      }],
    });
    const onRecoveryNeeded = vi.fn().mockResolvedValue(true);

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, onRecoveryNeeded);

    expect(result.ok).toBe(false);
    expect(onRecoveryNeeded).not.toHaveBeenCalled();
    expect(result.recoveryCount).toBe(0);
    expect(result.counters.recoveryLlmCalls).toBe(0);
    expect(result.counters.runtimeLlmCalls).toBe(0);
    expect(result.counters.recoveryBudgetExhausted).toBe(1);
    expect(result.results[0]?.error).toBe(RECOVERY_BUDGET_EXCEEDED);
  });

  it("does not treat a completed Accessibility transport result with found=false as action success", async () => {
    const workflow = makeWorkflow({
      maxRecoveryAttempts: 0,
      maxTotalRecoveryAttempts: 0,
      steps: [{
        id: "stale-selector",
        action: "tap",
        target: { resourceId: "stale_selector_canary_does_not_exist" },
        expectedPage: "reddit_search_entry",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Exercise a stale selector",
      }],
    });
    vi.mocked(waitForResult).mockResolvedValue({
      status: "completed",
      output: { found: false, error: "Element not found" },
    });

    const result = await runCompiledWorkflow(
      { deviceId: "device-1", workflow },
      vi.fn().mockResolvedValue(false),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.stepsCompleted).toBe(0);
    expect(result.counters.failedSteps).toBe(1);
  });

  it("replays the step on-device after retry_step recovery before declaring success", async () => {
    const workflow = makeWorkflow({
      steps: [{
        id: "stale-selector",
        action: "tap",
        target: { resourceId: "stale_selector" },
        expectedPage: "reddit_search_entry",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Retry a temporarily missing selector",
      }],
    });
    vi.mocked(waitForResult)
      .mockResolvedValueOnce({ status: "completed", output: { found: false, error: "Element not found" } })
      .mockResolvedValueOnce({ status: "completed", output: { screenOn: true } })
      .mockResolvedValueOnce({ status: "completed", output: { unlocked: true } })
      .mockResolvedValueOnce({ status: "completed", output: { found: true } });
    const onRecoveryNeeded = vi.fn().mockResolvedValue(true);

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, onRecoveryNeeded);

    expect(result.ok).toBe(true);
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(waitForResult).toHaveBeenCalledTimes(4);
    expect(result.counters.retriedSteps).toBe(1);
    expect(result.stepsCompleted).toBe(1);
  });

  it("replays an adapted recovery step instead of treating adaptation as execution", async () => {
    const workflow = makeWorkflow({
      steps: [{
        id: "stale-selector",
        action: "tap",
        target: { resourceId: "stale_selector" },
        expectedPage: "reddit_search_entry",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Recover a changed selector",
      }],
    });
    vi.mocked(waitForResult)
      .mockResolvedValueOnce({ status: "completed", output: { found: false, error: "Element not found" } })
      .mockResolvedValueOnce({ status: "completed", output: { screenOn: true } })
      .mockResolvedValueOnce({ status: "completed", output: { unlocked: true } })
      .mockResolvedValueOnce({ status: "completed", output: { found: true } });
    const onRecoveryNeeded = vi.fn().mockImplementation(async (ctx) => {
      ctx.workflow.steps[0] = {
        ...ctx.workflow.steps[0],
        target: { resourceId: "current_selector" },
        description: "Use the current selector",
      };
      return true;
    });

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, onRecoveryNeeded);

    expect(result.ok).toBe(true);
    expect(waitForResult).toHaveBeenCalledTimes(4);
    expect(workflow.steps[0].target?.resourceId).toBe("current_selector");
    expect(result.counters.retriedSteps).toBe(1);
  });

  it("persists recovery learning only after the replay succeeds", async () => {
    const workflow = makeWorkflow({
      steps: [{
        id: "stale-selector",
        action: "tap",
        target: { resourceId: "stale_selector" },
        expectedPage: "page",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Recover and learn",
      }],
    });
    vi.mocked(waitForResult)
      .mockResolvedValueOnce({ status: "completed", output: { found: false } })
      .mockResolvedValueOnce({ status: "completed", output: { screenOn: true } })
      .mockResolvedValueOnce({ status: "completed", output: { unlocked: true } })
      .mockResolvedValueOnce({ status: "completed", output: { found: true } });
    const onRecoveryNeeded = vi.fn().mockImplementation(async (ctx) => {
      ctx.workflow.steps[0] = { ...ctx.workflow.steps[0], target: { text: "Stable label" } };
      ctx.pendingRecoveryLearning = {
        appId: workflow.appId,
        type: "recovery_rule",
        payload: { target: { text: "Stable label" } },
        context: { appId: workflow.appId, deviceId: "device-1", workflowId: workflow.id },
        discoveryMethod: "llm_recovery",
        confidence: 0.75,
        safetyClass: "navigation",
      };
      return true;
    });

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, onRecoveryNeeded);

    expect(result.ok).toBe(true);
    expect(uiGraphLearningLoop.observe).toHaveBeenCalledWith(expect.objectContaining({
      payload: { target: { text: "Stable label" } },
      evidence: expect.objectContaining({ actionExecuted: true, postActionVerified: true }),
    }));
    expect(uiGraphLearningLoop.validate).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: "candidate-1",
      success: true,
      stateVerified: true,
      evidence: expect.objectContaining({ actionExecuted: true, postActionVerified: true }),
    }));
  });

  it("tries Accessibility selectors separately in priority order", async () => {
    const workflow = makeWorkflow({
      maxRecoveryAttempts: 0,
      maxTotalRecoveryAttempts: 0,
      steps: [{
        id: "selector-cascade",
        action: "tap",
        target: { resourceId: "transient_resource_id", text: "Stable label" },
        expectedPage: "page",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Use text only when the preferred resource ID disappeared",
      }],
    });
    vi.mocked(waitForResult)
      .mockResolvedValueOnce({ status: "completed", output: { found: false, error: "Element not found" } })
      .mockResolvedValueOnce({ status: "completed", output: { found: true } });

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, vi.fn());

    expect(result.ok).toBe(true);
    expect(waitForResult).toHaveBeenCalledTimes(2);
  });

  it("tries the short Android resource ID before its fully-qualified fallback", async () => {
    const workflow = makeWorkflow({
      maxRecoveryAttempts: 0,
      maxTotalRecoveryAttempts: 0,
      steps: [{
        id: "qualified-selector",
        action: "tap",
        target: { resourceId: "com.example.app:id/search_field" },
        expectedPage: "page",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Resolve a Compose-style short resource ID",
      }],
    });
    vi.mocked(waitForResult).mockResolvedValueOnce({ status: "completed", output: { found: true } });

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, vi.fn());

    expect(result.ok).toBe(true);
    expect(sendDeviceExecutionJobToDevice).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        type: "a11y_find_tap",
        params: { resourceId: "search_field" },
        verificationStrategy: "local_only",
      }),
      expect.any(Object),
    );
    expect(waitForResult).toHaveBeenCalledTimes(1);
  });

  it("refreshes wake and unlock between slow recovery selector fallbacks", async () => {
    const workflow = makeWorkflow({
      steps: [{
        id: "stale-selector",
        action: "tap",
        target: { resourceId: "stale_selector" },
        expectedPage: "page",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Recover through a bounded semantic fallback cascade",
      }],
    });
    vi.mocked(waitForResult)
      .mockResolvedValueOnce({ status: "completed", output: { found: false } })
      .mockResolvedValueOnce({ status: "completed", output: { screenOn: true } })
      .mockResolvedValueOnce({ status: "completed", output: { unlocked: true } })
      .mockResolvedValueOnce({ status: "completed", output: { found: false } })
      .mockResolvedValueOnce({ status: "completed", output: { screenOn: true } })
      .mockResolvedValueOnce({ status: "completed", output: { unlocked: true } })
      .mockResolvedValueOnce({ status: "completed", output: { found: true } });
    const onRecoveryNeeded = vi.fn().mockImplementation(async (ctx) => {
      ctx.workflow.steps[0] = {
        ...ctx.workflow.steps[0],
        target: { resourceId: "current_selector", contentDescription: "Stable search label" },
      };
      return true;
    });

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, onRecoveryNeeded);

    expect(result.ok).toBe(true);
    expect(waitForResult).toHaveBeenCalledTimes(7);
    const dispatchedTypes = vi.mocked(sendDeviceExecutionJobToDevice).mock.calls.map(([, payload]) => payload.type);
    expect(dispatchedTypes).toEqual([
      "a11y_find_tap",
      "screen_wake",
      "unlock",
      "a11y_find_tap",
      "screen_wake",
      "unlock",
      "a11y_find_tap",
    ]);
  });

  it("fails closed when the recovery replay still misses and the budget is exhausted", async () => {
    const workflow = makeWorkflow({
      maxRecoveryAttempts: 1,
      maxTotalRecoveryAttempts: 1,
      steps: [{
        id: "stale-selector",
        action: "tap",
        target: { resourceId: "stale_selector" },
        expectedPage: "reddit_search_entry",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Fail after a bounded recovery replay",
      }],
    });
    vi.mocked(waitForResult).mockResolvedValue({
      status: "completed",
      output: { found: false, error: "Element not found" },
    });
    const onRecoveryNeeded = vi.fn().mockResolvedValue(true);

    const result = await runCompiledWorkflow({ deviceId: "device-1", workflow }, onRecoveryNeeded);

    expect(result.ok).toBe(false);
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(waitForResult).toHaveBeenCalledTimes(4);
    expect(result.counters.recoveryBudgetExhausted).toBe(1);
    expect(result.results[0]?.error).toBe(RECOVERY_BUDGET_EXCEEDED);
  });

  it("rejects a colliding raw fingerprint when enforced state anchors resolve another page", () => {
    expect(reconcileFingerprintWithResolvedState({
      rawFingerprintMatch: true,
      enforced: true,
      expectedPage: "reddit_search_surface",
      resolution: {
        stateId: "home-state",
        stateKey: "reddit_home_feed",
        variantId: "home-default",
        variantKey: "default",
        method: "exact_hash",
        confidence: 1,
        fingerprint: "shared-short-hash",
        matchedAnchors: ["resourceid:home_screen_surface"],
        missingAnchors: [],
        unexpectedAnchors: [],
        ambiguousWith: [],
      },
    })).toBe(false);
  });

  it("fails closed in enforced mode when the shared hash has no anchored state resolution", () => {
    expect(reconcileFingerprintWithResolvedState({
      rawFingerprintMatch: true,
      enforced: true,
      expectedPage: "reddit_search_surface",
      resolution: null,
    })).toBe(false);
  });

  it("terminalizes the canonical root when an unexpected error occurs after admission", async () => {
    vi.mocked(updateWorkflowStatus).mockRejectedValueOnce(new Error("workflow status database unavailable"));

    await expect(runCompiledWorkflow(
      { deviceId: "device-1", workflow: makeWorkflow() },
      vi.fn().mockResolvedValue(false),
    )).rejects.toThrow("workflow status database unavailable");

    expect(deviceExecutionArbiter.observeAdmission).toHaveBeenCalledTimes(1);
    expect(deviceExecutionArbiter.finishServerWorkflowRoot).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "wf-runner-budget",
      status: "failed",
      reason: "compiled_workflow_unexpected_exception",
    }));
    expect(deviceExecutionArbiter.markAmbiguous).not.toHaveBeenCalled();
  });
});
