import { describe, expect, it } from "vitest";
import { resolveCachedWorkflowSafetyClass } from "./human-workflow-normalization";

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
