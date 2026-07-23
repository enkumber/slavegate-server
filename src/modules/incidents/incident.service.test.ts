import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: { query: vi.fn() } }));

vi.mock("../../db/client", () => ({ getDb: () => mocks.db }));

import {
  getDailyAuditSnapshot,
  reconcileSupersededTaskIncidents,
  recordExhaustedTaskIncident,
  updateIncidentOwnership,
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
      params: {
        password: "must-not-persist",
        workflowId: "workflow-1",
        cacheKey: "abc123",
        intent: "health_scan",
        clientId: "client-1",
      },
    }, {
      failReason: "CHECKPOINT_MISMATCH: post state contradicted expected state",
      failedStep: "step-3",
      stepsCompleted: 2,
      totalSteps: 7,
      generatedWorkflow: { selfHealing: { attempts: 0, status: "exhausted" } },
    }, { taskRetryAttempts: 0, recoveryBudget: 3 });

    const params = mocks.db.query.mock.calls[0][1];
    expect(params[0]).toBe("task:11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(params)).not.toContain("must-not-persist");
    expect(params).toContain("integrity");
    expect(params).toContain("high");
    expect(params[9]).toBe(0);
    expect(params[10]).toBe(3);
    expect(params[11]).toBe(0);
    expect(params[12]).toBe("nox");
    expect(JSON.parse(params[13])).toMatchObject({
      cacheKey: "abc123",
      recoveryBudget: 3,
      recoveryAttemptsActual: 0,
      taskRetryAttempts: 0,
    });
    expect(mocks.db.query.mock.calls[1][1].slice(0, 3)).toEqual(["incident-1", "created", "phone-network"]);
  });

  it("resolves only strictly matching older incidents after a verified successful task", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ id: "incident-1" }, { id: "incident-2" }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-2" }] });

    const count = await reconcileSupersededTaskIncidents({
      id: "11111111-1111-4111-8111-111111111111",
      device_id: "22222222-2222-4222-8222-222222222222",
      account_id: "33333333-3333-4333-8333-333333333333",
      routine: "generated_workflow",
      params: {
        intent: "reddit_account_health_scan",
        clientId: "44444444-4444-4444-8444-444444444444",
        definitionId: "55555555-5555-4555-8555-555555555555",
      },
    }, {
      generatedWorkflow: { workflowId: "workflow-success" },
    });

    expect(count).toBe(2);
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("failed_task.params->>'clientId' = $6");
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("superseded_by_task_id");
    expect(mocks.db.query.mock.calls[1][1][4]).toBe("superseded:11111111-1111-4111-8111-111111111111");
  });

  it("does not reconcile incidents when account/client identity is incomplete", async () => {
    const count = await reconcileSupersededTaskIncidents({
      id: "11111111-1111-4111-8111-111111111111",
      device_id: "22222222-2222-4222-8222-222222222222",
      account_id: null,
      routine: "generated_workflow",
      params: { intent: "reddit_account_health_scan" },
    }, {});

    expect(count).toBe(0);
    expect(mocks.db.query).not.toHaveBeenCalled();
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

  it("writes ownership changes once for the same canonical owner pair", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{
        id: "incident-1",
        incident_commander: "kraken",
        remediation_owner: "nox",
        ownership_changed: true,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }] });

    const result = await updateIncidentOwnership({
      id: "incident-1",
      incidentCommander: "kraken",
      remediationOwner: "nox",
      actor: "kraken",
    });

    expect(result?.changed).toBe(true);
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("previous.remediation_owner IS DISTINCT FROM $3");
    expect(mocks.db.query.mock.calls[1][1].slice(0, 3)).toEqual(["incident-1", "ownership_changed", "kraken"]);
  });

  it("rejects unsupported audit timezones before querying", async () => {
    await expect(getDailyAuditSnapshot("2026-07-22", "Etc/Unsafe")).rejects.toThrow("unsupported timezone");
    expect(mocks.db.query).not.toHaveBeenCalled();
  });
});
