import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "../types";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../db/client", () => ({ getDb: () => ({ query: mocks.query }) }));

import { assertOperationalRuntimeContract } from "../runtime-contract.service";

function template(action = "tap"): WorkflowTemplate {
  return {
    id: "portable",
    name: "Portable",
    platform: "com.example.app",
    description: "Portable workflow",
    version: "2",
    runtimeContract: "edge-workflow/v2",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 0,
    steps: [{ type: "action", id: "step", action, params: { x: 0.5, y: 0.5 } }],
  };
}

describe("operational runtime contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({
      rows: [{
        contract_id: "edge-workflow/v2",
        schema_version: 2,
        allowed_actions: ["tap", "ui_tree_dump"],
        limits: { maxSteps: 10 },
        active: true,
      }],
    });
  });

  it("uses PostgreSQL as the operational action allowlist", async () => {
    await expect(assertOperationalRuntimeContract(template())).resolves.toBeUndefined();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("workflow_runtime_contracts"), ["edge-workflow/v2"]);
  });

  it("rejects a primitive disabled in PostgreSQL", async () => {
    await expect(assertOperationalRuntimeContract(template("press_key"))).rejects.toThrow("disabled");
  });

  it("does not misclassify opaque action parameters as workflow primitives", async () => {
    const workflow = template();
    workflow.steps = [{
      type: "action",
      id: "open-url",
      action: "tap",
      params: {
        action: "android.intent.action.VIEW",
        nested: { action: "opaque-application-value" },
      },
    }];

    await expect(assertOperationalRuntimeContract(workflow)).resolves.toBeUndefined();
  });

  it("validates typed primitive slots in nested workflow branches", async () => {
    const workflow = template();
    workflow.steps = [{
      type: "condition",
      check: "has_target",
      if_true: [{
        type: "loop",
        count: { min: 1, max: 1, distribution: "fixed" },
        steps: [{ type: "action", action: "press_key" }],
      }],
    }];

    await expect(assertOperationalRuntimeContract(workflow)).rejects.toThrow("press_key");
  });

  it("fails closed for legacy workflows without the v2 contract", async () => {
    const legacy = { ...template(), runtimeContract: undefined };
    await expect(assertOperationalRuntimeContract(legacy)).rejects.toMatchObject({
      code: "WORKFLOW_RECOMPILE_REQUIRED",
      status: 409,
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
