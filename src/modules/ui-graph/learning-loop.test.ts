import { describe, expect, it } from "vitest";
import {
  candidateEnvironmentKey,
  candidateKey,
  promotionDecision,
  type CandidateObservation,
  type UiGraphPromotionPolicy,
} from "./learning-loop";

const POLICY: UiGraphPromotionPolicy = {
  minimumSuccessCount: 5,
  minimumDistinctDevices: 2,
  minimumDistinctBranches: 2,
  minimumDistinctEnvironments: 2,
  maximumFailureCount: 0,
  maximumRecoveryCount: 0,
  allowedAutomaticSafetyClasses: ["navigation", "read_only"],
  allowedAutomaticCandidateTypes: ["selector", "transition"],
};

describe("UI graph learning policy", () => {
  it("generates stable candidate keys independent of object key order", () => {
    const first = candidateKey({ appId: "app", type: "selector", sourceStateId: "home", payload: { strategy: "resource_id", selector: { value: "x", exact: true } } });
    const second = candidateKey({ appId: "app", type: "selector", sourceStateId: "home", payload: { selector: { exact: true, value: "x" }, strategy: "resource_id" } });
    expect(first).toBe(second);
  });

  it("ignores volatile evidence and context in candidate identity", () => {
    const base = {
      appId: "app",
      type: "selector" as const,
      sourceStateId: "home",
      payload: { elementKey: "search", strategy: "resource_id", selector: { value: "search_field" } },
    };
    const first: CandidateObservation = { ...base, evidence: { workflowId: "a" }, context: { appId: "app", deviceId: "a" }, confidence: 0.7, discoveryMethod: "llm_recovery", safetyClass: "navigation" };
    const second: CandidateObservation = { ...base, evidence: { workflowId: "b" }, context: { appId: "app", deviceId: "b" }, confidence: 0.99, discoveryMethod: "llm_recovery", safetyClass: "navigation" };
    expect(candidateKey(first)).toBe(candidateKey(second));
  });

  it("groups portable learning environments independently of device id", () => {
    const first = candidateEnvironmentKey({ appId: "app", deviceId: "phone-a", appVersion: "1", locale: "ro", deviceClass: "phone" });
    const second = candidateEnvironmentKey({ appId: "app", deviceId: "phone-b", appVersion: "1", locale: "ro", deviceClass: "phone" });
    expect(first).toBe(second);
  });

  it("requires repeated validation and cross-device/branch coverage", () => {
    const blocked = promotionDecision({ type: "selector", discoveryMethod: "vlm", safetyClass: "navigation", successCount: 4, failureCount: 0, stateVerified: true, lifecycleState: "configured" }, POLICY);
    expect(blocked.autoPromotable).toBe(false);
    expect(blocked.blockers).toContain("insufficient_successes");
    const ready = promotionDecision({
      type: "selector", discoveryMethod: "vlm", safetyClass: "navigation",
      successCount: 5, failureCount: 0, stateVerified: true,
      distinctDevices: 2, distinctBranches: 2, distinctEnvironments: 2,
      lifecycleState: "configured",
    }, POLICY);
    expect(ready.autoPromotable).toBe(true);
    expect(ready.validationStage).toBe("configured");
  });

  it("requires five clean validations for every automatically promoted selector", () => {
    const blocked = promotionDecision({ type: "selector", discoveryMethod: "ui_tree", safetyClass: "read_only", successCount: 4, failureCount: 0, stateVerified: true, lifecycleState: "configured" }, POLICY);
    expect(blocked.autoPromotable).toBe(false);
    expect(blocked.requiredSuccesses).toBe(5);

    const ready = promotionDecision({
      type: "selector", discoveryMethod: "ui_tree", safetyClass: "read_only",
      successCount: 5, failureCount: 0, stateVerified: true,
      distinctDevices: 2, distinctBranches: 2, distinctEnvironments: 2,
      lifecycleState: "configured",
    }, POLICY);
    expect(ready.autoPromotable).toBe(true);
  });

  it("never auto-promotes a candidate with a failed validation", () => {
    const decision = promotionDecision({
      type: "selector", discoveryMethod: "ui_tree", safetyClass: "navigation",
      successCount: 5, failureCount: 1, stateVerified: true,
      distinctDevices: 2, distinctBranches: 2, distinctEnvironments: 2,
      lifecycleState: "configured",
    }, POLICY);
    expect(decision.autoPromotable).toBe(false);
    expect(decision.ready).toBe(true);
    expect(decision.blockers).toContain("failure_policy_exceeded");
  });

  it("never auto-promotes mutating knowledge", () => {
    const decision = promotionDecision({
      type: "transition", discoveryMethod: "ui_tree", safetyClass: "mutating",
      successCount: 10, failureCount: 0, stateVerified: true,
      distinctDevices: 2, distinctBranches: 2, distinctEnvironments: 2,
      lifecycleState: "configured",
    }, POLICY);
    expect(decision.ready).toBe(true);
    expect(decision.autoPromotable).toBe(false);
    expect(decision.blockers).toContain("manual_review_required_for_safety_class");
  });

  it("keeps clean single-device knowledge at device_validated", () => {
    const decision = promotionDecision({
      type: "selector", discoveryMethod: "ui_tree", safetyClass: "navigation",
      successCount: 5, failureCount: 0, stateVerified: true,
      distinctDevices: 1, distinctBranches: 1, distinctEnvironments: 1,
      lifecycleState: "configured",
    }, POLICY);
    expect(decision.ready).toBe(true);
    expect(decision.autoPromotable).toBe(false);
    expect(decision.validationStage).toBe("configured");
    expect(decision.blockers).toContain("insufficient_device_coverage");
  });

  it("requires a clean run before global promotion after recovery", () => {
    const decision = promotionDecision({
      type: "transition", discoveryMethod: "ui_tree", safetyClass: "navigation",
      successCount: 8, failureCount: 0, stateVerified: true,
      distinctDevices: 2, distinctBranches: 2, distinctEnvironments: 2, recoveryCount: 1,
      lifecycleState: "configured",
    }, POLICY);
    expect(decision.autoPromotable).toBe(false);
    expect(decision.blockers).toContain("recovery_policy_exceeded");
  });
});
