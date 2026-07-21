import { describe, expect, it } from "vitest";
import { candidateKey, promotionDecision } from "./learning-loop";

describe("UI graph learning policy", () => {
  it("generates stable candidate keys independent of object key order", () => {
    const first = candidateKey({ appId: "app", type: "selector", sourceStateId: "home", payload: { strategy: "resource_id", selector: { value: "x", exact: true } } });
    const second = candidateKey({ appId: "app", type: "selector", sourceStateId: "home", payload: { selector: { exact: true, value: "x" }, strategy: "resource_id" } });
    expect(first).toBe(second);
  });

  it("requires repeated cross-context validation for VLM discoveries", () => {
    const blocked = promotionDecision({ type: "selector", discoveryMethod: "vlm", safetyClass: "navigation", successCount: 4, failureCount: 0, distinctContextCount: 2, stateVerified: true });
    expect(blocked.autoPromotable).toBe(false);
    expect(blocked.blockers).toContain("insufficient_successes");
    const ready = promotionDecision({ type: "selector", discoveryMethod: "vlm", safetyClass: "navigation", successCount: 5, failureCount: 0, distinctContextCount: 2, stateVerified: true });
    expect(ready.autoPromotable).toBe(true);
  });

  it("never auto-promotes mutating knowledge", () => {
    const decision = promotionDecision({ type: "transition", discoveryMethod: "ui_tree", safetyClass: "mutating", successCount: 10, failureCount: 0, distinctContextCount: 4, stateVerified: true });
    expect(decision.ready).toBe(true);
    expect(decision.autoPromotable).toBe(false);
    expect(decision.blockers).toContain("manual_review_required_for_safety_class");
  });
});
