import { describe, expect, it, vi } from "vitest";
import {
  deleteResourceLifecyclePolicy,
  disableResourceLifecyclePolicy,
  getResourceLifecycleExecutionStatusContract,
  getResourceLifecyclePolicy,
  listResourceLifecyclePolicies,
  listResourceLifecyclePolicyReadiness,
  getResourceLifecycleTransition,
  updateLifecycleStalePolicy,
  upsertResourceLifecyclePolicy,
} from "./lifecycle.service";

function poolWithClient(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() };
  return {
    client,
    pool: { connect: vi.fn(async () => client) },
  };
}

describe("lifecycle stale policy control plane", () => {
  it("persists a stale policy only through an automatic DB transition", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        lifecycle_key: "custom_lifecycle",
        status: "working",
        initial: false,
        terminal: false,
        retryable: false,
        administrative: false,
        dispatchable: false,
        manual: false,
        stale_after_ms: "90000",
        stale_action_key: "expire",
        description: null,
        metadata: {},
      }],
    });

    const result = await updateLifecycleStalePolicy(
      "custom_lifecycle",
      "working",
      { staleAfterMs: 90_000, staleActionKey: "expire" },
      { query } as never,
    );

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("transition.automatic");
    expect(query.mock.calls[0][0]).not.toMatch(/dispatcher_job|pending|running|timeout/);
    expect(query.mock.calls[0][1]).toEqual([
      "custom_lifecycle",
      "working",
      90_000,
      "expire",
    ]);
    expect(result).toMatchObject({
      lifecycleKey: "custom_lifecycle",
      status: "working",
      staleAfterMs: 90_000,
      staleActionKey: "expire",
    });
  });

  it("can disable a stale policy without naming a status or action in code", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        lifecycle_key: "custom_lifecycle",
        status: "working",
        initial: false,
        terminal: false,
        retryable: false,
        administrative: false,
        dispatchable: false,
        manual: false,
        stale_after_ms: null,
        stale_action_key: null,
        description: null,
        metadata: {},
      }],
    });

    const result = await updateLifecycleStalePolicy(
      "custom_lifecycle",
      "working",
      { staleAfterMs: null, staleActionKey: null },
      { query } as never,
    );

    expect(query.mock.calls[0][1]).toEqual([
      "custom_lifecycle",
      "working",
      null,
      null,
    ]);
    expect(result?.staleAfterMs).toBeNull();
    expect(result?.staleActionKey).toBeNull();
  });

  it("rejects partial, non-positive, and unsafe policies before querying DB", async () => {
    const query = vi.fn();

    await expect(updateLifecycleStalePolicy(
      "custom_lifecycle",
      "working",
      { staleAfterMs: 60_000, staleActionKey: null },
      { query } as never,
    )).rejects.toThrow("must both be null");

    await expect(updateLifecycleStalePolicy(
      "custom_lifecycle",
      "working",
      { staleAfterMs: 0, staleActionKey: "expire" },
      { query } as never,
    )).rejects.toThrow("positive integer");

    expect(query).not.toHaveBeenCalled();
  });
});

describe("resource lifecycle execution status contract", () => {
  it("derives protocol roles from PostgreSQL state and transition capabilities", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { role: "active", status: "processing" },
        { role: "cancelled", status: "stopped_by_operator" },
        { role: "failed", status: "needs_retry" },
        { role: "initial", status: "waiting" },
        { role: "succeeded", status: "done" },
      ],
    });

    await expect(getResourceLifecycleExecutionStatusContract(
      "custom_runs",
      "state",
      { query } as never,
    )).resolves.toEqual({
      initial: "waiting",
      active: "processing",
      succeeded: "done",
      failed: "needs_retry",
      cancelled: "stopped_by_operator",
    });
    expect(query.mock.calls[0][1]).toEqual(["custom_runs", "state"]);
    expect(query.mock.calls[0][0]).toContain("transition.mark_started");
  });

  it("fails closed when a protocol role is absent or ambiguous", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { role: "initial", status: "waiting_a" },
        { role: "initial", status: "waiting_b" },
      ],
    });
    await expect(getResourceLifecycleExecutionStatusContract(
      "custom_runs",
      "state",
      { query } as never,
    )).rejects.toThrow("exactly one configured state");
  });
});

describe("resource lifecycle transition lookup", () => {
  it("resolves caller-supplied actions through the configured resource binding", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        lifecycle_key: "custom_lifecycle",
        action_key: "operator_action",
        from_status: "source",
        to_status: "target",
        manual_allowed: true,
        external_allowed: false,
        automatic: false,
        mark_started: false,
        mark_completed: false,
        clear_completed: false,
        clear_failure: true,
        reset_retry: false,
        metadata: {},
      }],
    });
    await expect(getResourceLifecycleTransition(
      "custom_resources",
      "source",
      "operator_action",
      "state",
      { query } as never,
    )).resolves.toMatchObject({
      fromStatus: "source",
      toStatus: "target",
      manualAllowed: true,
    });
    expect(query.mock.calls[0][1]).toEqual([
      "custom_resources",
      "source",
      "operator_action",
      "state",
    ]);
  });
});

describe("resource lifecycle policy control plane service", () => {
  it("lists and reads policy records by generic bound resource identity", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        resource_table: "public.operator_resources",
        state_column: "state",
        policy: { arbitrary: true },
        version: "3",
        updated_by: "operator",
        updated_at: new Date("2026-07-27T00:00:00.000Z"),
      }],
    });

    await expect(listResourceLifecyclePolicies(
      { resourceTable: "operator_resources", stateColumn: "state" },
      { query } as never,
    )).resolves.toEqual([
      expect.objectContaining({
        resourceTable: "public.operator_resources",
        stateColumn: "state",
        policy: { arbitrary: true },
        version: 3,
      }),
    ]);
    expect(query.mock.calls[0][1]).toEqual(["operator_resources", "state"]);
  });

  it("upserts transactionally through the PostgreSQL binding and returns the written row", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{
          resource_table: "public.operator_resources",
          state_column: "state",
          policy: { observeMode: true, rootKinds: { any: { operationKind: "work", wireType: null } } },
          version: "1",
          updated_by: "operator",
          updated_at: new Date("2026-07-27T00:00:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({});
    const { pool, client } = poolWithClient(query);

    await expect(upsertResourceLifecyclePolicy({
      resourceTable: "operator_resources",
      stateColumn: "state",
      policy: { observeMode: true, rootKinds: { any: { operationKind: "work", wireType: null } } },
      updatedBy: "operator",
    }, pool as never)).resolves.toMatchObject({
      resourceTable: "public.operator_resources",
      stateColumn: "state",
      policy: { observeMode: true, rootKinds: { any: { operationKind: "work", wireType: null } } },
    });
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringContaining("FROM lifecycle_resource_bindings"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects unbound resources, invalid identifiers, and invalid policy flags clearly", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    const { pool } = poolWithClient(query);

    await expect(upsertResourceLifecyclePolicy({
      resourceTable: "operator_resources",
      stateColumn: "state",
      policy: { enabled: true },
    }, pool as never)).rejects.toThrow("binding does not exist");

    await expect(upsertResourceLifecyclePolicy({
      resourceTable: "operator-resources",
      stateColumn: "state",
      policy: {},
    }, pool as never)).rejects.toThrow("PostgreSQL identifier");

    await expect(upsertResourceLifecyclePolicy({
      resourceTable: "operator_resources",
      stateColumn: "state",
      policy: { enabled: "yes" } as never,
    }, pool as never)).rejects.toThrow("policy.enabled must be a boolean");
  });

  it("supports explicit disable and delete with read-time fail-closed behavior", async () => {
    const disabledQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{
          resource_table: "public.operator_resources",
          state_column: "state",
          policy: { enabled: false },
          version: "2",
          updated_by: "operator",
          updated_at: new Date("2026-07-27T00:00:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({});
    const { pool: disablePool } = poolWithClient(disabledQuery);

    await expect(disableResourceLifecyclePolicy(
      "operator_resources",
      "state",
      "operator",
      disablePool as never,
    )).resolves.toMatchObject({ policy: { enabled: false } });

    const runtimeQuery = vi.fn().mockResolvedValue({ rows: [{ policy: { enabled: false } }] });
    await expect(getResourceLifecyclePolicy(
      "operator_resources",
      "state",
      { query: runtimeQuery } as never,
    )).rejects.toThrow("disabled");

    const deleteQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ resource_table: "public.operator_resources" }] })
      .mockResolvedValueOnce({});
    const { pool: deletePool } = poolWithClient(deleteQuery);
    await expect(deleteResourceLifecyclePolicy("operator_resources", "state", deletePool as never)).resolves.toBe(true);
  });

  it("discovers readiness generically from persisted bindings and policies", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          resource_table: "public.operator_resources",
          state_column: "state",
          lifecycle_key: "operator_lifecycle",
          version: null,
          policy_present: false,
          policy_enabled: false,
        },
        {
          resource_table: "public.audit_resources",
          state_column: "phase",
          lifecycle_key: "audit_lifecycle",
          version: "3",
          policy_present: true,
          policy_enabled: true,
        },
      ],
    });

    await expect(listResourceLifecyclePolicyReadiness({ query } as never)).resolves.toEqual([
      {
        resourceTable: "public.operator_resources",
        stateColumn: "state",
        lifecycleKey: "operator_lifecycle",
        ready: false,
        issue: "policy_missing",
        policyVersion: null,
      },
      {
        resourceTable: "public.audit_resources",
        stateColumn: "phase",
        lifecycleKey: "audit_lifecycle",
        ready: true,
        issue: null,
        policyVersion: 3,
      },
    ]);
    expect(query.mock.calls[0][0]).toContain("FROM lifecycle_resource_bindings");
    expect(query.mock.calls[0][0]).toContain("LEFT JOIN lifecycle_resource_policies");
  });
});
