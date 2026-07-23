import { describe, expect, it } from "vitest";
import type { WorkflowGoalContract, WorkflowTemplate } from "../workflows/types";
import { workflowGoalContractReason } from "../workflows/goal-contract";
import { validateGeneratedWorkflowTemplate } from "../workflows/workflow-validator";

const contract: WorkflowGoalContract = {
  version: "1",
  allowedEffects: ["none", "observation", "navigation", "ui_input"],
  requiredOutputs: ["label"],
  stages: [
    {
      id: "input",
      allowedActions: ["type_text"],
      allowedEffects: ["ui_input"],
      produces: ["query"],
    },
    {
      id: "extract",
      allowedActions: ["classify_ui_tree"],
      allowedEffects: ["observation"],
      after: ["input"],
      produces: ["label"],
    },
    {
      id: "select",
      allowedActions: ["a11y_find_tap"],
      allowedEffects: ["navigation"],
      after: ["extract"],
      consumes: ["label"],
    },
  ],
};

function candidate(): WorkflowTemplate {
  return {
    id: "generic_lookup",
    name: "Generic lookup",
    platform: "android",
    description: "Resolve a catalog-defined goal.",
    version: "1.0.0",
    runtimeContract: "edge-workflow/v2",
    safetyClass: "read_only",
    goalContract: contract,
    outputSchema: {
      required: ["label"],
      properties: { label: { type: "string" } },
    },
    steps: [
      {
        id: "input",
        type: "action",
        action: "type_text",
        effect: "ui_input",
        goalStage: "input",
        params: { text: "sample", outputVariable: "query" },
      },
      {
        id: "extract",
        type: "action",
        action: "classify_ui_tree",
        effect: "observation",
        goalStage: "extract",
        params: { outputs: { label: { regex: "(.+)", group: 1 } } },
      },
      {
        id: "select",
        type: "action",
        action: "a11y_find_tap",
        effect: "navigation",
        goalStage: "select",
        params: { text: { $bind: "label" } },
      },
    ],
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
  };
}

describe("data-driven workflow goal contracts", () => {
  it("accepts stages, outputs and dynamic bindings declared by catalog data", () => {
    expect(workflowGoalContractReason(candidate(), contract)).toBeNull();
    expect(validateGeneratedWorkflowTemplate(candidate()).errors).toEqual([]);
  });

  it("rejects a missing binding without knowing domain vocabulary", () => {
    const workflow = candidate();
    (workflow.steps[2] as Extract<typeof workflow.steps[number], { type: "action" }>).params = { text: "static" };
    expect(workflowGoalContractReason(workflow, contract)).toContain("does not consume binding");
  });

  it("rejects effectful actions that are not covered by a catalog stage", () => {
    const workflow = candidate();
    (workflow.steps[2] as Extract<typeof workflow.steps[number], { type: "action" }>).goalStage = undefined;
    expect(workflowGoalContractReason(workflow, contract)).toContain("not assigned to a goal stage");
  });

  it("allows UI input in read-only workflows but rejects business mutation by effect", () => {
    const workflow = candidate();
    (workflow.steps[0] as Extract<typeof workflow.steps[number], { type: "action" }>).effect = "business_mutation";
    expect(workflowGoalContractReason(workflow, contract)).toContain("disallowed effect");
  });

  it("rejects a read-only contract that authorizes business mutation", () => {
    const workflow = candidate();
    workflow.goalContract = {
      ...contract,
      allowedEffects: [...contract.allowedEffects, "business_mutation"],
    };
    expect(workflowGoalContractReason(workflow)).toContain("read_only");
  });
});
