import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  queries: [] as string[],
  txQueries: [] as string[],
  offlineCanary: null as null | {
    runId: string;
    taskId: string;
    executionKey: string;
    deviceStatus: string;
    runStatus: string;
    taskStatus: string;
    buildStatus: string;
  },
}));

vi.mock("../../db/client", () => {
  const query = async (text: string, params: unknown[] = []) => {
      state.queries.push(text);
      if (text.includes("SELECT callback_url")) {
        return { rows: [{ callback_url: "http://10.21.0.16:18788/hooks/phone-network-segment" }] };
      }
      if (text.includes("INSERT INTO segment_build_job_events")) return { rows: [] };
      if (
        text.includes("FROM segment_build_jobs")
        && text.includes("ORDER BY claim_expires_at ASC")
      ) {
        const expired = Date.parse(String(state.row.claim_expires_at)) < Date.now();
        return {
          rows: expired
            && ["claimed", "building", "candidate_ready", "canary_running"].includes(String(state.row.status))
            ? [{ ...state.row }]
            : [],
        };
      }
      if (
        text.includes("SELECT j.id")
        && text.includes("JOIN agency_workflow_runs")
        && text.includes("d.status <> 'online'")
      ) {
        return {
          rows: state.offlineCanary
            && state.offlineCanary.buildStatus === "canary_running"
            && state.offlineCanary.runStatus === "queued"
            && state.offlineCanary.taskStatus === "queued"
            && state.offlineCanary.deviceStatus !== "online"
            ? [{ id: buildJob().id }]
            : [],
        };
      }
      if (
        text.includes("dispatch_attempts = dispatch_attempts + 1")
        && text.includes("claim_expires_at < NOW()")
      ) {
        const expired = Date.parse(String(state.row.claim_expires_at)) < Date.now();
        const recentlyDispatched = state.row.dispatched_at
          && Date.parse(String(state.row.dispatched_at)) >= Date.now() - 30_000;
        if (
          !["claimed", "building", "candidate_ready", "canary_running"].includes(String(state.row.status))
          || !expired
          || recentlyDispatched
        ) {
          return { rows: [] };
        }
        state.row = {
          ...state.row,
          agent_session_key: params[1],
          dispatch_attempts: Number(state.row.dispatch_attempts ?? 0) + 1,
          last_dispatch_error: null,
          dispatched_at: new Date().toISOString(),
        };
        return { rows: [{ ...state.row }] };
      }
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
      if (text.includes("WHEN status IN ('candidate_ready','canary_running') THEN status")) {
        const currentStatus = String(state.row.status);
        const expired = Date.parse(String(state.row.claim_expires_at)) < Date.now();
        const claimable = ["pending_agent", "dispatched"].includes(currentStatus)
          || (["claimed", "building", "candidate_ready", "canary_running"].includes(currentStatus) && expired);
        if (!claimable) return { rows: [] };
        state.row = {
          ...state.row,
          status: ["candidate_ready", "canary_running"].includes(currentStatus) ? currentStatus : "claimed",
          assigned_agent: params[1],
          claim_expires_at: new Date(Date.now() + 600_000).toISOString(),
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
      if (text.includes("friendly_name AS name")) {
        return {
          rows: [{
            id: buildJob().deviceId,
            name: "test-device",
            model: "test-model",
            android_version: "10",
            agent_version: "4.0.76",
            status: "online",
          }],
        };
      }
      if (text.includes("FROM workflow_capabilities")) return { rows: [] };
      if (text.includes("FROM workflow_segment_versions")) return { rows: [] };
      if (text.includes("FROM workflow_compositions c")) return { rows: [] };
      if (text.includes("FROM runtime_semantic_entries")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
  };
  const transactionQuery = async (text: string, params: unknown[] = []) => {
    state.txQueries.push(text);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
    const canary = state.offlineCanary;
    if (
      text.includes("FROM segment_build_jobs j")
      && text.includes("FOR UPDATE OF j, r")
    ) {
      if (!canary || canary.buildStatus !== "canary_running") return { rows: [] };
      return {
        rows: [{
          id: buildJob().id,
          device_id: buildJob().deviceId,
          execution_key: canary.executionKey,
          run_id: canary.runId,
          task_id: canary.taskId,
          workflow_id: null,
          run_status: canary.runStatus,
          device_status: canary.deviceStatus,
        }],
      };
    }
    if (text.includes("SELECT status FROM tasks")) {
      return { rows: canary ? [{ status: canary.taskStatus }] : [] };
    }
    if (text.includes("UPDATE tasks")) {
      if (canary?.taskStatus === "queued") canary.taskStatus = "failed";
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("UPDATE agency_workflow_runs")) {
      if (canary?.runStatus === "queued") canary.runStatus = "failed";
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("UPDATE workflow_execution_bindings")) {
      return { rows: [], rowCount: 1 };
    }
    if (
      text.includes("UPDATE segment_build_jobs")
      && text.includes("offlineCanaryTimeout")
    ) {
      if (canary?.buildStatus !== "canary_running") return { rows: [] };
      canary.buildStatus = "failed";
      return { rows: [{ id: buildJob().id }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO segment_build_job_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected transaction query: ${text} ${JSON.stringify(params)}`);
  };
  return {
    getDb: () => ({
      query,
      connect: async () => ({
        query: transactionQuery,
        release: vi.fn(),
      }),
    }),
  };
});

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
    state.txQueries = [];
    state.offlineCanary = null;
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

  it("redispatches an expired building lease once without resetting job progress", async () => {
    state.row.status = "building";
    state.row.claim_expires_at = new Date(Date.now() - 60_000).toISOString();
    state.row.candidate = { preserved: true };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 202 })));

    const result = await new SegmentBuildJobService().dispatch({
      ...buildJob(),
      status: "building",
      claimExpiresAt: String(state.row.claim_expires_at),
      candidate: { preserved: true },
    });

    expect(result.status).toBe("building");
    expect(result.candidate).toEqual({ preserved: true });
    expect(result.dispatchAttempts).toBe(1);
    expect(state.row.agent_session_key).toBe(`hook:phone-network:${buildJob().id}`);
  });

  it("preserves candidate-ready state while reclaiming an expired lease", async () => {
    state.row.status = "candidate_ready";
    state.row.claim_expires_at = new Date(Date.now() - 60_000).toISOString();
    state.row.candidate = { preserved: true };

    const result = await new SegmentBuildJobService().claim(
      buildJob().id,
      SEGMENT_BUILDER_AGENT_ID,
    );

    expect(result?.status).toBe("candidate_ready");
    expect(result?.candidate).toEqual({ preserved: true });
    expect(Date.parse(String(result?.claimExpiresAt))).toBeGreaterThan(Date.now());
  });

  it("periodically redispatches an expired lease without a new compile request", async () => {
    state.row.status = "building";
    state.row.claim_expires_at = new Date(Date.now() - 60_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 202 })));

    const redispatched = await new SegmentBuildJobService().sweepExpiredAgentLeases();

    expect(redispatched).toBe(1);
    expect(state.row.status).toBe("building");
    expect(state.row.dispatch_attempts).toBe(1);
  });

  it("atomically expires an offline queued canary and its task", async () => {
    state.offlineCanary = {
      runId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444",
      executionKey: "c".repeat(24),
      deviceStatus: "offline",
      runStatus: "queued",
      taskStatus: "queued",
      buildStatus: "canary_running",
    };

    const expired = await new SegmentBuildJobService().expireOfflineQueuedCanaries();

    expect(expired).toBe(1);
    expect(state.offlineCanary).toMatchObject({
      runStatus: "failed",
      taskStatus: "failed",
      buildStatus: "failed",
    });
    expect(state.txQueries).toContain("BEGIN");
    expect(state.txQueries).toContain("COMMIT");
    expect(state.txQueries.some((query) => query.includes("SEGMENT_BUILD_CANARY_DEVICE_OFFLINE_TIMEOUT"))).toBe(true);
    expect(state.txQueries.some((query) => query.includes("canary_expired_offline"))).toBe(true);
  });

  it("does not expire a queued canary after the device comes back online", async () => {
    state.offlineCanary = {
      runId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444",
      executionKey: "c".repeat(24),
      deviceStatus: "online",
      runStatus: "queued",
      taskStatus: "queued",
      buildStatus: "canary_running",
    };

    const expired = await new SegmentBuildJobService().expireOfflineQueuedCanaries();

    expect(expired).toBe(0);
    expect(state.txQueries).toEqual([]);
  });

  it("rejects any mutable agent identity before touching PostgreSQL", async () => {
    const result = await new SegmentBuildJobService().claim(buildJob().id, "other-agent");
    expect(result).toBeNull();
    expect(state.queries).toEqual([]);
  });

  it("loads agent context from the canonical devices schema", async () => {
    const context = await new SegmentBuildJobService().context(buildJob().id);

    expect(context?.device).toMatchObject({
      id: buildJob().deviceId,
      name: "test-device",
      agent_version: "4.0.76",
    });
    expect(state.queries.some((query) => query.includes("friendly_name AS name"))).toBe(true);
    expect(state.queries.some((query) => /\bSELECT id, name, model\b/.test(query))).toBe(false);
  });
});
