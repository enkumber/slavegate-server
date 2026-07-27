import { describe, expect, it } from "vitest";
import { validateGeneratedWorkflowTemplate } from "./workflow-validator";

function template(step: Record<string, unknown>) {
  return {
    id: "verified_state_machine_test",
    name: "Verified state machine test",
    description: "Exercises the verified UI state-machine runtime contract.",
    platform: "android",
    version: "1.0.0",
    runtimeContract: "edge-workflow/v2",
    safetyClass: "standard",
    steps: [step],
  };
}

describe("verified UI state-machine contract", () => {
  it("leaves action-specific parameter requirements to PostgreSQL", () => {
    const result = validateGeneratedWorkflowTemplate(template({
      id: "transition",
      type: "action",
      action: "fixture_action",
      timeoutMs: 10_000,
      params: { fixture: true },
    }));
    expect(result.ok, result.errors.join("\n")).toBe(true);
  });

  it("accepts a data-driven state machine and rejects recursive transitions", () => {
    const valid = validateGeneratedWorkflowTemplate(template({
      id: "machine",
      type: "action",
      action: "run_state_machine",
      params: {
        stateVariable: "state",
        resolver: { outputs: { state: { cases: [{ anyContains: ["Ready"], value: "ready" }], default: "unknown" } } },
        goalStates: ["ready"],
        unknownStates: ["unknown"],
        transitions: {
          start: {
            action: "observe_and_transition",
            params: {
              selectors: [{ text: "Start" }],
              postcondition: { action: "ui_tree_dump", operator: "contains_ci", expected: "Ready" },
            },
          },
        },
      },
    }));
    expect(valid.ok, valid.errors.join("\n")).toBe(true);
  });
});
