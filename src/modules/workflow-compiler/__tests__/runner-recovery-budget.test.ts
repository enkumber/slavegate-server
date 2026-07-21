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
}));

import {
  runCompiledWorkflow,
  RECOVERY_BUDGET_EXCEEDED,
  reconcileFingerprintWithResolvedState,
} from "../runner.service";
import type { CompiledWorkflow } from "../types";
import { sendJobToDevice, waitForResult } from "../../../transport/transport";
import {
  generatedWorkflowRecoveryAttempts,
  generatedWorkflowRecoveryBudgetExhausted,
} from "../../observability/metrics";
import { deviceExecutionArbiter } from "../../device-execution";
import { updateWorkflowStatus } from "../planner.service";

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
