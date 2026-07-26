import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../db/client", () => ({
  getDb: () => ({ query }),
}));

import {
  describeConnectionRecoveryPolicies,
  getConnectionRecoveryPolicy,
  initializeConnectionRecoveryPolicies,
  setConnectionRecoveryPoliciesForTest,
} from "./connection-recovery-config";

const retryPolicy = {
  retry: true,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  jitterMs: 1000,
  maxAttempts: 10,
  healthPollMs: 60000,
};

const stopPolicy = {
  retry: false,
  initialDelayMs: 1000,
  maxDelayMs: 1000,
  jitterMs: 0,
  maxAttempts: 1,
  healthPollMs: 60000,
};

describe("connection recovery runtime policy", () => {
  beforeEach(() => {
    query.mockReset();
    setConnectionRecoveryPoliciesForTest(null);
  });

  it("loads one retry and one stop policy discovered by payload shape", async () => {
    query.mockResolvedValueOnce({ rows: [{ payload: retryPolicy }, { payload: stopPolicy }] });

    await expect(initializeConnectionRecoveryPolicies()).resolves.toBe(true);
    expect(getConnectionRecoveryPolicy(true)).toEqual(retryPolicy);
    expect(getConnectionRecoveryPolicy(false)).toEqual(stopPolicy);
    expect(describeConnectionRecoveryPolicies()).toEqual({
      ready: true,
      candidateCount: 2,
      error: null,
    });
    expect(String(query.mock.calls[0][0])).toContain("definition.dispatchable");
  });

  it("fails closed when either verdict is missing", async () => {
    query.mockResolvedValueOnce({ rows: [{ payload: retryPolicy }] });

    await expect(initializeConnectionRecoveryPolicies()).resolves.toBe(false);
    expect(getConnectionRecoveryPolicy(true)).toBeNull();
    expect(describeConnectionRecoveryPolicies()).toMatchObject({
      ready: false,
      candidateCount: 1,
    });
  });

  it("rejects duplicate or malformed policy rows", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { payload: retryPolicy },
        { payload: { ...retryPolicy, initialDelayMs: -1 } },
      ],
    });

    await expect(initializeConnectionRecoveryPolicies()).resolves.toBe(false);
    expect(getConnectionRecoveryPolicy(true)).toBeNull();
  });
});
