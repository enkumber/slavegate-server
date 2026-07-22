import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: { query: vi.fn() } }));

vi.mock("../../db/client", () => ({ getDb: () => mocks.db }));

import {
  getDailyAuditSnapshot,
  recordExhaustedTaskIncident,
  updateIncidentStatus,
} from "./incident.service";

describe("incident service", () => {
  beforeEach(() => mocks.db.query.mockReset());

  it("upserts one idempotent incident for an exhausted task without persisting task params", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ id: "incident-1", inserted: true }] })
      .mockResolvedValueOnce({ rows: [] });

    await recordExhaustedTaskIncident({
      id: "11111111-1111-4111-8111-111111111111",
      device_id: "22222222-2222-4222-8222-222222222222",
      routine: "generated_workflow",
      params: { password: "must-not-persist", workflowId: "workflow-1" },
    }, {
      failReason: "CHECKPOINT_MISMATCH: post state contradicted expected state",
      failedStep: "step-3",
      stepsCompleted: 2,
      totalSteps: 7,
    }, 3);

    const params = mocks.db.query.mock.calls[0][1];
    expect(params[0]).toBe("task:11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(params)).not.toContain("must-not-persist");
    expect(params).toContain("integrity");
    expect(params).toContain("high");
    expect(mocks.db.query.mock.calls[1][1].slice(0, 3)).toEqual(["incident-1", "created", "phone-network"]);
  });

  it("records status transitions with an audit event", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ id: "incident-1", status: "investigating" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await updateIncidentStatus({
      id: "incident-1",
      status: "investigating",
      actor: "kraken",
      note: "checking evidence",
    });

    expect(result).toMatchObject({ status: "investigating" });
    expect(mocks.db.query.mock.calls[1][1].slice(0, 3)).toEqual(["incident-1", "investigating", "kraken"]);
  });

  it("rejects unsupported audit timezones before querying", async () => {
    await expect(getDailyAuditSnapshot("2026-07-22", "Etc/Unsafe")).rejects.toThrow("unsupported timezone");
    expect(mocks.db.query).not.toHaveBeenCalled();
  });
});
