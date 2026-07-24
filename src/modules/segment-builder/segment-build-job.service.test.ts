import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  queries: [] as string[],
}));

vi.mock("../../db/client", () => ({
  getDb: () => ({
    query: async (text: string, params: unknown[] = []) => {
      state.queries.push(text);
      if (text.includes("SELECT callback_url")) {
        return { rows: [{ callback_url: "http://10.21.0.16:18788/hooks/phone-network-segment" }] };
      }
      if (text.includes("INSERT INTO segment_build_job_events")) return { rows: [] };
      if (text.includes("SET status = 'dispatched'")) {
        if (!["pending_agent", "failed"].includes(String(state.row.status))) return { rows: [] };
        state.row = {
          ...state.row,
          status: "dispatched",
          agent_session_key: params[1],
          dispatch_attempts: Number(state.row.dispatch_attempts ?? 0) + 1,
          last_dispatch_error: null,
        };
        return { rows: [{ ...state.row }] };
      }
      if (text.includes("SET status = CASE WHEN status = 'dispatched'")) {
        if (state.row.status === "dispatched") state.row.status = "pending_agent";
        state.row.last_dispatch_error = params[1];
        return { rows: [{ ...state.row }] };
      }
      if (text.includes("SELECT * FROM segment_build_jobs WHERE id = $1")) {
        return { rows: state.row.id === params[0] ? [{ ...state.row }] : [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  }),
}));

import {
  SEGMENT_BUILDER_AGENT_ID,
  SegmentBuildJobService,
  type SegmentBuildJob,
} from "./segment-build-job.service";

function buildJob(): SegmentBuildJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requestKey: "a".repeat(24),
    idempotencyKey: `segment-build:${"a".repeat(24)}`,
    deviceId: "22222222-2222-4222-8222-222222222222",
    accountId: null,
    intent: "test intent",
    platform: "test.platform",
    capabilityKey: null,
    reason: "capability_missing",
    status: "pending_agent",
    assignedAgent: SEGMENT_BUILDER_AGENT_ID,
    agentSessionKey: null,
    dispatchAttempts: 0,
    lastDispatchError: null,
    claimExpiresAt: null,
    candidate: null,
    evidence: {},
    result: {},
    error: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("SegmentBuildJobService dispatch", () => {
  beforeEach(() => {
    state.row = {
      id: buildJob().id,
      request_key: buildJob().requestKey,
      idempotency_key: buildJob().idempotencyKey,
      device_id: buildJob().deviceId,
      account_id: null,
      intent: buildJob().intent,
      platform: buildJob().platform,
      capability_key: null,
      reason: buildJob().reason,
      status: "pending_agent",
      assigned_agent: SEGMENT_BUILDER_AGENT_ID,
      agent_session_key: null,
      dispatch_attempts: 0,
      last_dispatch_error: null,
      claim_expires_at: null,
      candidate: null,
      evidence: {},
      result: {},
      error: null,
      created_at: buildJob().createdAt,
      updated_at: buildJob().updatedAt,
    };
    state.queries = [];
    process.env.OPENCLAW_SEGMENT_BUILDER_HOOK_TOKEN = "b".repeat(64);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_SEGMENT_BUILDER_HOOK_TOKEN;
  });

  it("reserves dispatched state before the hook and never overwrites an immediate claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      state.row.status = "claimed";
      state.row.claim_expires_at = new Date(Date.now() + 60_000).toISOString();
      return new Response("", { status: 202 });
    }));

    const result = await new SegmentBuildJobService().dispatch(buildJob());

    expect(result.status).toBe("claimed");
    expect(result.dispatchAttempts).toBe(1);
    expect(state.queries.findIndex((query) => query.includes("SET status = 'dispatched'")))
      .toBeLessThan(state.queries.findIndex((query) => query.includes("SELECT * FROM segment_build_jobs")));
  });

  it("returns a failed hook dispatch to pending without incrementing attempts twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));

    await expect(new SegmentBuildJobService().dispatch(buildJob()))
      .rejects.toMatchObject({ code: "SEGMENT_BUILDER_DISPATCH_FAILED" });

    expect(state.row.status).toBe("pending_agent");
    expect(state.row.dispatch_attempts).toBe(1);
    expect(state.row.last_dispatch_error).toBe("OpenClaw hook returned HTTP 503");
  });

  it("rejects any mutable agent identity before touching PostgreSQL", async () => {
    const result = await new SegmentBuildJobService().claim(buildJob().id, "other-agent");
    expect(result).toBeNull();
    expect(state.queries).toEqual([]);
  });
});
