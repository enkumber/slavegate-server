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

  it("fails an unacknowledged start only through an atomic queued/running guard", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: "workflow-1" }] });

    await expect(workflowService.markFailedIfEdgeStartUnacknowledged(
      "workflow-1",
      "ack timeout",
    )).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(sql).toContain("current_step = 0");
    expect(sql).toContain("(checkpoint->>'source') IS DISTINCT FROM 'edge'");
    expect(sql).toContain("RETURNING id");
    expect(params).toEqual(["ack timeout", "workflow-1"]);
  });

  it("reports a lost ACK race without overwriting the newer workflow state", async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(workflowService.markFailedIfEdgeStartUnacknowledged(
      "workflow-1",
      "ack timeout",
    )).resolves.toBe(false);
  });
});
