import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../db/client", () => ({
  getDb: () => ({ query }),
}));

import {
  describeWorkflowQueueRuntimePolicy,
  getWorkflowQueueRuntimePolicy,
  initializeWorkflowQueueRuntimePolicy,
  setWorkflowQueueRuntimePolicyForTest,
} from "./workflow-runtime-config";

describe("workflow queue runtime policy", () => {
  beforeEach(() => {
    query.mockReset();
    setWorkflowQueueRuntimePolicyForTest(null);
  });

  it("keeps startup available and workflow dispatch disabled when PostgreSQL has no policy", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(initializeWorkflowQueueRuntimePolicy()).resolves.toBeNull();
    expect(describeWorkflowQueueRuntimePolicy()).toMatchObject({
      ready: false,
      candidateCount: 0,
      policy: null,
    });
    expect(() => getWorkflowQueueRuntimePolicy()).toThrow("no active workflow queue runtime policy");
  });

  it("loads exactly one structurally active PostgreSQL policy", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        payload: {
          maxAttempts: 7,
          backoffType: "operator-configured",
          backoffDelayMs: 1250,
        },
      }],
    });

    await expect(initializeWorkflowQueueRuntimePolicy()).resolves.toEqual({
      maxAttempts: 7,
      backoffType: "operator-configured",
      backoffDelayMs: 1250,
    });
    expect(describeWorkflowQueueRuntimePolicy()).toEqual({
      ready: true,
      candidateCount: 1,
      policy: {
        maxAttempts: 7,
        backoffType: "operator-configured",
        backoffDelayMs: 1250,
      },
      error: null,
    });
    expect(String(query.mock.calls[0][0])).toContain("definition.dispatchable");
  });

  it("fails closed without crashing the control plane when multiple policies are active", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { payload: { maxAttempts: 1, backoffType: "a", backoffDelayMs: 0 } },
        { payload: { maxAttempts: 2, backoffType: "b", backoffDelayMs: 1 } },
      ],
    });

    await expect(initializeWorkflowQueueRuntimePolicy()).resolves.toBeNull();
    expect(describeWorkflowQueueRuntimePolicy()).toMatchObject({
      ready: false,
      candidateCount: 2,
      policy: null,
    });
    expect(() => getWorkflowQueueRuntimePolicy()).toThrow("multiple active");
  });

  it("keeps malformed policy data disabled for live repair", async () => {
    query.mockResolvedValueOnce({
      rows: [{ payload: { maxAttempts: 0, backoffType: "", backoffDelayMs: -1 } }],
    });

    await expect(initializeWorkflowQueueRuntimePolicy()).resolves.toBeNull();
    expect(describeWorkflowQueueRuntimePolicy()).toMatchObject({
      ready: false,
      candidateCount: 1,
      error: "invalid PostgreSQL workflow queue runtime policy",
    });
  });
});
