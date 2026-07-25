import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  getDb: () => ({ query }),
}));

import { workflowService } from "./workflow.service";

describe("workflow edge lifecycle transitions", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("fails an unacknowledged start only through a DB-defined transition and checkpoint guard", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: "workflow-1" }] });

    await expect(workflowService.markFailedIfEdgeStartUnacknowledged(
      "workflow-1",
      "ack timeout",
    )).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("JOIN lifecycle_transitions transition");
    expect(sql).toContain("transition.action_key = $2");
    expect(sql).toContain("workflow.current_step = 0");
    expect(sql).toContain("(workflow.checkpoint->>'source') IS DISTINCT FROM 'edge'");
    expect(sql).toContain("RETURNING workflow.*");
    expect(params).toEqual([
      "workflow-1",
      "fail",
      "{\"error\":\"ack timeout\"}",
      "workflow_execution",
    ]);
  });

  it("reports a lost ACK race without overwriting the newer workflow state", async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(workflowService.markFailedIfEdgeStartUnacknowledged(
      "workflow-1",
      "ack timeout",
    )).resolves.toBe(false);
  });

  it("fails stale edge progress only through an exact checkpoint CAS", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: "workflow-1" }] });

    await expect(workflowService.markFailedIfEdgeProgressStale(
      "workflow-1",
      "2026-07-22T12:00:00.000Z",
      "progress timeout",
    )).resolves.toBe(true);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("JOIN lifecycle_transitions transition");
    expect(sql).toContain("(workflow.checkpoint->>'source') = 'edge'");
    expect(sql).toContain("(workflow.checkpoint->>'checkpointAt') = $3");
    expect(sql).toContain("RETURNING workflow.*");
    expect(params).toEqual([
      "workflow-1",
      "fail",
      "2026-07-22T12:00:00.000Z",
      "{\"error\":\"progress timeout\"}",
      "workflow_execution",
    ]);
  });
});
