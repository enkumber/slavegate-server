import { describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "./types";
import {
  assertWorkflowMatchesSafetyPolicy,
  reserveWorkflowSafetyAdmission,
  type WorkflowSafetyPolicy,
} from "./workflow-safety-admission.service";

const workflow: WorkflowTemplate = {
  id: "private_reversible_canary",
  name: "Private reversible canary",
  platform: "android",
  description: "test",
  version: "1.0.0",
  intent: "private_reversible_canary",
  safetyClass: "private_reversible",
  goalContract: {
    version: "1",
    allowedEffects: ["none", "local_change", "local_restore"],
    stages: [
      { id: "mutate", allowedActions: ["set_clipboard"] },
      { id: "cleanup", allowedActions: ["set_clipboard"], after: ["mutate"] },
    ],
  },
  postconditionContract: {
    version: "1",
    all: [{ left: { path: "outputs.restored" }, operator: "equals", right: { value: true } }],
  },
  steps: [
    { type: "action", action: "get_clipboard", effect: "none", params: {} },
    { type: "action", action: "set_clipboard", effect: "local_change", goalStage: "mutate", params: { text: "marker" } },
    { type: "action", action: "set_clipboard", effect: "local_restore", goalStage: "cleanup", params: { text: "" } },
  ],
  defaultVerificationStrategy: "local_only",
  dataRetentionDays: 1,
};

const policy: WorkflowSafetyPolicy = {
  version: "v1",
  requiresAdmissionLedger: true,
  requireExplicitEffects: true,
  scopeTemplate: "{{clientId}}/{{accountId}}/{{deviceId}}",
  unitCost: 1,
  allowedEffects: ["none", "local_change", "local_restore"],
  requiredGoalStages: ["mutate", "cleanup"],
  requirePostcondition: true,
  approval: {
    required: true,
    granted: true,
    grantId: "approval_v1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  limits: [{ windowMs: 60_000, maxRuns: 2, maxUnits: 2 }],
};

function policyRow(value: WorkflowSafetyPolicy = policy) {
  return { rows: [{ payload: value }] };
}

const context = {
  clientId: "client",
  accountId: "account",
  deviceId: "device",
  intent: "intent",
  source: "test",
};

describe("workflow safety admission", () => {
  it("rejects effects outside PostgreSQL policy", () => {
    expect(() => assertWorkflowMatchesSafetyPolicy(
      { ...workflow, steps: [{ type: "action", action: "set_clipboard", effect: "unapproved", params: {} }] },
      policy,
    )).toThrow(/not allowed/);
  });

  it("reserves an approved bounded admission", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ runs: "0", units: "0" }] })
      .mockResolvedValueOnce({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] });
    const result = await reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      context,
      idempotencyKey: "canary_once",
    });
    expect(result).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      policyVersion: "v1",
      scopeKey: "client/account/device",
      consumedUnits: 1,
      replayed: false,
    });
  });

  it("returns the existing admission for an idempotent replay", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "11111111-1111-4111-8111-111111111111", consumed_units: "1" }] });
    const result = await reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      context,
      idempotencyKey: "canary_once",
    });
    expect(result.replayed).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("fails closed without approval", async () => {
    const query = vi.fn().mockResolvedValueOnce(policyRow({
      ...policy,
      approval: { required: true, granted: false },
    }));
    await expect(reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      context,
      idempotencyKey: "canary_once",
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_APPROVAL_REQUIRED" });
  });

  it("enforces run and unit limits atomically", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ runs: "2", units: "2" }] });
    await expect(reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      context,
      idempotencyKey: "canary_third",
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_RATE_LIMITED", status: 429 });
  });

  it("fails closed when the class has no active PostgreSQL policy", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "unknown_class",
      workflow: { ...workflow, safetyClass: "unknown_class" },
      context,
      idempotencyKey: "unknown_once",
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_POLICY_REQUIRED", status: 503 });
  });
});
