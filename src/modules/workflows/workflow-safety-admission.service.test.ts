import { describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "./types";
import { isFailClosedMigration } from "../../db/migrate";
import {
  assertWorkflowSafetyDispatch,
  assertWorkflowMatchesSafetyPolicy,
  computeWorkflowSafetyArtifactFingerprint,
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
const artifactFingerprint = "a".repeat(64);

describe("workflow safety admission", () => {
  it("keeps the workflow safety schema migration fail-closed", () => {
    expect(isFailClosedMigration("120_workflow_safety_admission_ledger.sql")).toBe(true);
  });

  it("binds the canonical plan to stable execution variables", () => {
    const left = computeWorkflowSafetyArtifactFingerprint(
      artifactFingerprint,
      { inputs: { text: "private marker", count: 1 } },
    );
    const reordered = computeWorkflowSafetyArtifactFingerprint(
      artifactFingerprint,
      { inputs: { count: 1, text: "private marker" } },
    );
    const changed = computeWorkflowSafetyArtifactFingerprint(
      artifactFingerprint,
      { inputs: { count: 2, text: "private marker" } },
    );
    expect(left).toBe(reordered);
    expect(left).not.toBe(changed);
  });

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
      .mockResolvedValueOnce({ rows: [{ run_exhausted: false, unit_exhausted: false }] })
      .mockResolvedValueOnce({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] });
    const result = await reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      artifactFingerprint,
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
      .mockResolvedValueOnce({
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          policy_version: "v1",
          consumed_units: "1",
          context: { artifactFingerprint, admissionContext: context },
        }],
      });
    const result = await reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      artifactFingerprint,
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
      artifactFingerprint,
      context,
      idempotencyKey: "canary_once",
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_APPROVAL_REQUIRED" });
  });

  it("evaluates approval expiry against PostgreSQL time", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow({
        ...policy,
        approval: {
          ...policy.approval,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      }))
      .mockResolvedValueOnce({ rows: [{ active: false }] });
    await expect(reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      artifactFingerprint,
      context,
      idempotencyKey: "canary_once",
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_APPROVAL_EXPIRED" });
    expect(String(query.mock.calls[1][0])).toContain("NOW()");
  });

  it("enforces run and unit limits atomically", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ run_exhausted: true, unit_exhausted: false }] });
    await expect(reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      artifactFingerprint,
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
      artifactFingerprint,
      context,
      idempotencyKey: "unknown_once",
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_POLICY_REQUIRED", status: 503 });
  });

  it("rejects idempotency-key reuse for a different canonical artifact", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          policy_version: "v1",
          consumed_units: "1",
          context: {
            artifactFingerprint: "b".repeat(64),
            admissionContext: context,
          },
        }],
      });
    await expect(reserveWorkflowSafetyAdmission({
      db: { query },
      safetyClass: "private_reversible",
      workflow,
      artifactFingerprint,
      context,
      idempotencyKey: "canary_once",
    })).rejects.toMatchObject({ code: "WORKFLOW_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("binds dispatch to the canonical artifact and exact admission context", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] });
    await expect(assertWorkflowSafetyDispatch({
      db: { query },
      workflow: {
        ...workflow,
        recoveryPolicy: { autonomy: "policy_hydrated" },
      },
      safetyAdmissionId: "11111111-1111-4111-8111-111111111111",
      artifactFingerprint,
      context,
    })).resolves.toBeUndefined();
    expect(query.mock.calls[1][1]).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "private_reversible",
      "v1",
      "client/account/device",
      artifactFingerprint,
      JSON.stringify({
        accountId: "account",
        clientId: "client",
        deviceId: "device",
        intent: "intent",
        source: "test",
      }),
    ]);
  });

  it("fails closed when no receipt matches the exact dispatch binding", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(policyRow())
      .mockResolvedValueOnce({ rows: [] });
    await expect(assertWorkflowSafetyDispatch({
      db: { query },
      workflow,
      safetyAdmissionId: "11111111-1111-4111-8111-111111111111",
      artifactFingerprint,
      context: { ...context, intent: "different_intent" },
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_ADMISSION_INVALID" });
  });
});
