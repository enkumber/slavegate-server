import { describe, expect, it, vi } from "vitest";
import { updateLifecycleStalePolicy } from "./lifecycle.service";

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
