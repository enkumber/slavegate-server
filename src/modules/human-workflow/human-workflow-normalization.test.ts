import { describe, expect, it } from "vitest";
import {
  normalizeCachedHumanWorkflowTemplate,
  resolveCachedWorkflowSafetyClass,
} from "./human-workflow-normalization";
import type { WorkflowTemplate } from "../workflows/types";

describe("cached workflow safety-class resolution", () => {
  it("preserves an opaque PostgreSQL-owned safety class without code mapping", () => {
    expect(resolveCachedWorkflowSafetyClass({
      workflow: { safetyClass: "client_policy/reversible_mutation" },
      compiled_plan: {
        metadata: { safetyClass: "client_policy/reversible_mutation" },
      },
      source_metadata: {
        safetyClass: "client_policy/reversible_mutation",
      },
    })).toBe("client_policy/reversible_mutation");
  });

  it("accepts one explicit projection when optional mirrors are absent", () => {
    expect(resolveCachedWorkflowSafetyClass({
      workflow: { safetyClass: "operator.review-required" },
    })).toBe("operator.review-required");
  });

  it("fails closed when no safety class is explicit", () => {
    expect(() => resolveCachedWorkflowSafetyClass({
      workflow: {},
      compiled_plan: { metadata: {} },
    })).toThrow("no explicit safety class");
  });

  it("fails closed for an invalid policy identifier", () => {
    expect(() => resolveCachedWorkflowSafetyClass({
      workflow: { safetyClass: "Mutation Allowed!" },
    })).toThrow("invalid safety class");
  });

  it("fails closed when cached projections disagree", () => {
    expect(() => resolveCachedWorkflowSafetyClass({
      workflow: { safetyClass: "read_only" },
      compiled_plan: { metadata: { safetyClass: "mutating" } },
    })).toThrow("projections disagree");
  });
});

function cachedWorkflow(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: "generic_cached_boundary_probe",
    name: "Generic cached boundary probe",
    platform: "generic",
    description: "Schema-only cached workflow boundary fixture.",
    version: "1.0.0",
    defaultVerificationStrategy: "local",
    dataRetentionDays: 0,
    steps: [
      {
        type: "action",
        id: "collect_structural_data",
        action: "collect_structural_data",
        params: {},
      },
    ],
    ...overrides,
  };
}

describe("cached workflow executable-structure normalization", () => {
  it("rejects cached action steps with a null action before dispatch", () => {
    const workflow = cachedWorkflow({
      steps: [
        {
          type: "action",
          id: "missing_executable_discriminator",
          action: null,
          params: { outputVariable: "numericOutput" },
        } as unknown as WorkflowTemplate["steps"][number],
      ],
    });

    expect(() => normalizeCachedHumanWorkflowTemplate(workflow, {})).toThrow(
      "cached workflow has invalid executable structure",
    );
  });

  it("rejects observation output nodes that are not executable workflow steps", () => {
    const workflow = cachedWorkflow({
      steps: [
        {
          type: "countMatches",
          id: "count_output_node",
          outputVariable: "matchCount",
          selector: { text: "any" },
        } as unknown as WorkflowTemplate["steps"][number],
      ],
    });

    expect(() => normalizeCachedHumanWorkflowTemplate(workflow, {})).toThrow(
      "workflow.steps[0].type must be a valid executable step discriminator",
    );
  });
});
