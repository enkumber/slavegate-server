import { describe, expect, it, vi } from "vitest";
import { RecoveryOrchestrator, validateRecoveryProposal } from "./recovery-orchestrator";
import type { RecoveryProposal, StateResolution } from "./types";

const source: StateResolution = {
  stateId: "home", stateKey: "home", variantId: "v", variantKey: "v", method: "anchors", confidence: 0.9,
  fingerprint: "hash", matchedAnchors: [], missingAnchors: [], unexpectedAnchors: [], ambiguousWith: [],
};

const proposal: RecoveryProposal = {
  type: "dismiss_overlay", actions: [{ type: "press_key", key: "back", safetyClass: "navigation" }], confidence: 0.9,
  reason: "Dismiss popup", learningEligible: true, sourceStateId: "popup", expectedTargetStateId: "home",
};

describe("RecoveryOrchestrator", () => {
  it("uses deterministic recovery before any reasoning or vision", async () => {
    const reasonFromUiTree = vi.fn().mockResolvedValue(null);
    const captureScreenshot = vi.fn().mockResolvedValue("image");
    const learn = vi.fn().mockResolvedValue(undefined);
    const orchestrator = new RecoveryOrchestrator({
      captureUiTree: async () => [], captureScreenshot, reasonFromUiTree,
      reasonFromVision: async () => null,
      executeAction: async () => ({ ok: true }),
      verifyProposal: async () => ({ ok: true, targetStateId: "home", evidence: { verified: true } }),
      recordLearning: learn,
    }, {
      maxActions: 3,
      maxAttempts: 2,
      maxDurationMs: 1_000,
      allowedSafetyClasses: ["navigation"],
      allowedProposalTypes: ["dismiss_overlay"],
      actionlessProposalTypes: [],
    });
    const result = await orchestrator.recover({
      context: { appId: "app" }, failureReason: "popup", failedAction: { type: "tap" },
      sourceResolution: source, safetyClass: "navigation", deterministicProposals: [proposal],
    });
    expect(result.ok).toBe(true);
    expect(reasonFromUiTree).not.toHaveBeenCalled();
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it("rejects recovery actions that escalate safety", () => {
    const errors = validateRecoveryProposal(
      { ...proposal, actions: [{ type: "type_text", text: "secret", safetyClass: "mutating" }] },
      "navigation",
      {
        maxActions: 3,
        maxAttempts: 1,
        maxDurationMs: 1000,
        allowedSafetyClasses: ["navigation"],
        allowedProposalTypes: ["dismiss_overlay"],
        actionlessProposalTypes: [],
      },
    );
    expect(errors).toContain("recovery_safety_escalation_forbidden");
  });
});
