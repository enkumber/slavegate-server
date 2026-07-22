import { describe, expect, it } from "vitest";
import { candidateEnvironmentKey, candidateKey, promotionDecision, type CandidateObservation } from "./learning-loop";

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

  it("requires repeated validation but not multiple devices for VLM discoveries", () => {
    const blocked = promotionDecision({ type: "selector", discoveryMethod: "vlm", safetyClass: "navigation", successCount: 4, failureCount: 0, stateVerified: true });
    expect(blocked.autoPromotable).toBe(false);
    expect(blocked.blockers).toContain("insufficient_successes");
    const ready = promotionDecision({ type: "selector", discoveryMethod: "vlm", safetyClass: "navigation", successCount: 5, failureCount: 0, stateVerified: true });
    expect(ready.autoPromotable).toBe(true);
    expect(ready.blockers).not.toContain("insufficient_distinct_contexts");
  });

  it("never auto-promotes mutating knowledge", () => {
    const decision = promotionDecision({ type: "transition", discoveryMethod: "ui_tree", safetyClass: "mutating", successCount: 10, failureCount: 0, stateVerified: true });
    expect(decision.ready).toBe(true);
    expect(decision.autoPromotable).toBe(false);
    expect(decision.blockers).toContain("manual_review_required_for_safety_class");
  });
});
