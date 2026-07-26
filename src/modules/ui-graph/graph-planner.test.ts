import { describe, expect, it } from "vitest";
import { planGraphRoute } from "./graph-planner";
import type { UiTransitionDefinition } from "./types";

function transition(id: string, source: string, target: string, overrides: Partial<UiTransitionDefinition> = {}): UiTransitionDefinition {
  return {
    id,
    key: id,
    appId: "reddit",
    sourceStateId: source,
    targetStateId: target,
    action: { type: "tap" },
    cost: 1,
    safetyClass: "navigation",
    confidence: 0.9,
    ...overrides,
  };
}

describe("planGraphRoute", () => {
  it("selects the lowest-cost promoted route", () => {
    const route = planGraphRoute("home", "comments", [
      transition("direct", "home", "comments", { cost: 4 }),
      transition("open-post", "home", "post"),
      transition("open-comments", "post", "comments"),
    ], { allowedSafetyClasses: ["navigation"], minimumConfidence: 0.7, maxTransitions: 20 });
    expect(route.found).toBe(true);
    expect(route.transitions.map((item) => item.id)).toEqual(["open-post", "open-comments"]);
  });

  it("rejects transitions above the workflow safety class", () => {
    const route = planGraphRoute("home", "posted", [
      transition("submit", "home", "posted", { safetyClass: "mutating" }),
    ], { allowedSafetyClasses: ["navigation"], minimumConfidence: 0.7, maxTransitions: 20 });
    expect(route.found).toBe(false);
  });

});
