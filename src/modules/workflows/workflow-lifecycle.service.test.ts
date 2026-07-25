import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({ getDb: () => ({ query }) }));

import {
  transitionWorkflow,
  transitionWorkflowFromExternalStatus,
  transitionWorkflowWhere,
} from "./workflow-lifecycle.service";

describe("workflow lifecycle", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("resolves transitions by DB properties without action or lifecycle literals", async () => {
    await transitionWorkflow("workflow-1", { targetTerminal: true }, { error: "x" });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("JOIN lifecycle_transitions transition");
    expect(params).toEqual([
      "workflow-1",
      "{\"error\":\"x\"}",
      "{\"targetTerminal\":true}",
    ]);
  });

  it("keeps checkpoint CAS predicates inside the transition statement", async () => {
    await transitionWorkflowWhere(
      "workflow-1",
      { transitionMarkStarted: true },
      { currentStep: 4 },
      undefined,
      "workflow.current_step = $2",
      [3],
    );
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("workflow.current_step = $2");
    expect(params).toEqual([
      "workflow-1",
      3,
      "{\"currentStep\":4}",
      "{\"transitionMarkStarted\":true}",
    ]);
  });

  it("accepts device target states only through external-enabled transitions", async () => {
    await transitionWorkflowFromExternalStatus("workflow-1", "operator_terminal", {
      currentStep: 5,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("transition.external_allowed");
    expect(params).toEqual([
      "workflow-1",
      "operator_terminal",
      "{\"currentStep\":5}",
    ]);
  });
});
