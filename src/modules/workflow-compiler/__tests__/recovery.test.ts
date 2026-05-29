/**
 * recovery.test.ts
 * Unit tests for AI Recovery service — limit enforcement and action typing.
 * Story: US-WORKFLOW-COMPILER, Task T8
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all external dependencies before importing
vi.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

vi.mock("../../../db/client", () => ({
  getDb: () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }),
}));

vi.mock("../../../transport/transport", () => ({
  sendJobToDevice: vi.fn().mockReturnValue(true),
  isDeviceOnline: vi.fn().mockReturnValue(true),
  waitForResult: vi.fn().mockResolvedValue({
    output: { image_base64: "fake_base64", tree: [] },
  }),
}));

vi.mock("../../app-mapping/page-fingerprint", () => ({
  computePageSignature: vi.fn().mockReturnValue("mock_fingerprint_hash"),
}));

vi.mock("../../../utils/llm", () => ({
  llmJson: vi.fn(),
}));

import { attemptRecovery, resetRecoveryCounts } from "../recovery.service";
import { llmJson } from "../../../utils/llm";
import { isDeviceOnline, sendJobToDevice, waitForResult } from "../../../transport/transport";
import type { CompiledWorkflow, CompiledStep } from "../types";

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

function makeStep(overrides: Partial<CompiledStep> = {}): CompiledStep {
  return {
    id: "s1",
    action: "tap",
    target: { elementId: "btn_test", coords: { x: 0.5, y: 0.5 } },
    expectedPage: "page_home",
    expectedPageHash: "hash123",
    retries: 1,
    retryDelay: 500,
    description: "Tap test button",
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<CompiledWorkflow> = {}): CompiledWorkflow {
  return {
    id: "wf-recovery-test",
    name: "Recovery Test",
    source: "Test instruction",
    appId: "com.test.app",
    compiledAt: "2026-01-01T00:00:00Z",
    steps: [makeStep()],
    appMapVersion: "1.0.0",
    startPage: "page_home",
    maxRecoveryAttempts: 1,
    maxTotalRecoveryAttempts: 10,
    recoveryModel: "test-model",
    ...overrides,
  };
}

function makeRunnerContext(overrides: Record<string, any> = {}) {
  return {
    deviceId: "device-1",
    workflow: makeWorkflow(),
    stepsCompleted: 0,
    recoveryCount: 0,
    results: [],
    onRecoveryNeeded: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("attemptRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: LLM returns retry_step
    vi.mocked(llmJson).mockResolvedValue({ type: "retry_step" });
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    vi.mocked(sendJobToDevice).mockReturnValue(true);
    vi.mocked(waitForResult).mockResolvedValue({
      output: { image_base64: "fake_base64", tree: [] },
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    // Clean up recovery counts between tests
    resetRecoveryCounts("wf-recovery-test");
  });

  // ── Max attempts per step ────────────────────────────────────────────────

  describe("max attempts per step", () => {
    it("should return false after MAX_RECOVERY_PER_STEP (1) attempt on the same step", async () => {
      const ctx = makeRunnerContext({ recoveryCount: 0 });

      // First attempt should succeed (returns true for retry_step)
      const r1 = await attemptRecovery(ctx, 0, "mismatch");
      expect(r1).toBe(true);

      // 2nd attempt should be blocked
      const r2 = await attemptRecovery(ctx, 0, "mismatch");
      expect(r2).toBe(false);
    });

    it("should not call the LLM again after the per-step budget is exhausted", async () => {
      const ctx = makeRunnerContext({ recoveryCount: 0 });

      await attemptRecovery(ctx, 0, "mismatch");
      vi.mocked(llmJson).mockClear();

      const result = await attemptRecovery(ctx, 0, "mismatch");

      expect(result).toBe(false);
      expect(llmJson).not.toHaveBeenCalled();
    });

    it("should track step recovery counts independently per step index", async () => {
      const workflow = makeWorkflow({
        steps: [makeStep({ id: "s1" }), makeStep({ id: "s2", expectedPage: "page_home", expectedPageHash: "hash123" })],
      });
      const ctx = makeRunnerContext({ recoveryCount: 0, workflow });

      // Exhaust step 0
      await attemptRecovery(ctx, 0, "mismatch");

      // Step 0 should be blocked
      const r0 = await attemptRecovery(ctx, 0, "mismatch");
      expect(r0).toBe(false);

      // Step 1 should still work (different step index)
      const r1 = await attemptRecovery(ctx, 1, "mismatch");
      expect(r1).toBe(true);
    });
  });

  // ── Max attempts per workflow ────────────────────────────────────────────

  describe("max attempts per workflow", () => {
    it("should return false when total recovery count reaches MAX_RECOVERY_PER_WORKFLOW (10)", async () => {
      const ctx = makeRunnerContext({ recoveryCount: 10 });

      const result = await attemptRecovery(ctx, 0, "mismatch");
      expect(result).toBe(false);
    });

    it("should still allow recovery when under the workflow limit", async () => {
      const ctx = makeRunnerContext({ recoveryCount: 5 });

      const result = await attemptRecovery(ctx, 0, "mismatch");
      expect(result).toBe(true);
    });
  });

  // ── Recovery action types ────────────────────────────────────────────────

  describe("recovery action types", () => {
    it("should handle retry_step action correctly", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockResolvedValue({ type: "retry_step" });

      const result = await attemptRecovery(ctx, 0, "element not found");
      expect(result).toBe(true);
    });

    it("should handle retry_with_adaptation action and update the step", async () => {
      const adaptedStep = makeStep({
        id: "s1",
        action: "swipe",
        params: { direction: "up" },
        description: "Swipe up then retry",
      });
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockResolvedValue({
        type: "retry_with_adaptation",
        adaptedStep,
      });

      const result = await attemptRecovery(ctx, 0, "element scrolled out");
      expect(result).toBe(true);
      // The step should have been replaced in the workflow
      expect(ctx.workflow.steps[0].action).toBe("swipe");
      expect(ctx.workflow.steps[0].description).toBe("Swipe up then retry");
    });

    it("should handle dismiss_and_retry action", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockResolvedValue({
        type: "dismiss_and_retry",
        dismissActions: [
          {
            id: "dismiss-1",
            action: "tap",
            target: { coords: { x: 0.5, y: 0.8 } },
            expectedPage: "page_home",
            expectedPageHash: "hash123",
            retries: 0,
            retryDelay: 0,
            description: "Dismiss popup OK button",
          },
        ],
      });

      const result = await attemptRecovery(ctx, 0, "popup appeared");
      expect(result).toBe(true);
      // Should have sent tap command to dismiss popup
      expect(sendJobToDevice).toHaveBeenCalledWith(
        "device-1",
        expect.objectContaining({ type: "tap" }),
      );
    });

    it("should handle navigate_back_and_retry action", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockResolvedValue({
        type: "navigate_back_and_retry",
        backSteps: 2,
      });

      const result = await attemptRecovery(ctx, 0, "wrong page");
      expect(result).toBe(true);
      // Should have sent 2 press_key "back" commands
      const backCalls = vi.mocked(sendJobToDevice).mock.calls.filter(
        (c: any[]) => c[1]?.type === "press_key",
      );
      expect(backCalls).toHaveLength(2);
    });

    it("should handle abort action and return false", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockResolvedValue({
        type: "abort",
        reason: "App crashed — cannot recover",
      });

      const result = await attemptRecovery(ctx, 0, "app crash");
      expect(result).toBe(false);
    });

    it("should default to retry_step when LLM returns invalid action type", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockResolvedValue({ type: "unknown_nonsense" });

      const result = await attemptRecovery(ctx, 0, "test");
      // Falls back to retry_step → returns true
      expect(result).toBe(true);
    });

    it("should default to retry_step when LLM call fails", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(llmJson).mockRejectedValue(new Error("LLM timeout"));

      const result = await attemptRecovery(ctx, 0, "test");
      expect(result).toBe(true);
    });

    it("does not pass the retired codex recovery model override to llmJson", async () => {
      const ctx = makeRunnerContext();

      const result = await attemptRecovery(ctx, 0, "test", "openai-codex/gpt-5.5");

      expect(result).toBe(true);
      expect(llmJson).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({
          system: "You are an Android workflow recovery agent. Respond ONLY with valid JSON recovery action.",
        }),
      );
    });
  });

  // ── Device state checks ──────────────────────────────────────────────────

  describe("device state", () => {
    it("should handle device being offline gracefully", async () => {
      const ctx = makeRunnerContext();
      vi.mocked(isDeviceOnline).mockReturnValue(false);
      vi.mocked(llmJson).mockResolvedValue({ type: "retry_step" });

      // retry_step: executeRecoveryAction checks isDeviceOnline first, returns { success: false }
      // so attemptRecovery returns false (recoveryAction.type !== "abort" but execResult.success is false)
      const result = await attemptRecovery(ctx, 0, "test");
      expect(result).toBe(false);
    });
  });

  // ── resetRecoveryCounts ──────────────────────────────────────────────────

  describe("resetRecoveryCounts", () => {
    it("should reset per-step recovery counts for a workflow", async () => {
      const ctx = makeRunnerContext();

      // Exhaust step 0
      await attemptRecovery(ctx, 0, "mismatch");

      // Step 0 blocked
      expect(await attemptRecovery(ctx, 0, "mismatch")).toBe(false);

      // Reset
      resetRecoveryCounts("wf-recovery-test");

      // Should be able to recover again
      expect(await attemptRecovery(ctx, 0, "mismatch")).toBe(true);
    });
  });
});
