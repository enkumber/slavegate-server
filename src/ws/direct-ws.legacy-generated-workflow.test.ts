import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DirectWsServer, setWorkflowJobResultResolverForTest } from "./direct-ws.server";
import { deviceExecutionArbiter, setDeviceExecutionAuthorityForTest } from "../modules/device-execution";
import { pnqV2RuntimeService } from "../modules/device-execution/pnq-v2-runtime.service";
import { setPnqV2RuntimeConfigForTest } from "../modules/device-execution/pnq-v2-runtime-config";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";

const deviceId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";

afterEach(() => {
  setDeviceExecutionAuthorityForTest(null);
  setPnqV2RuntimeConfigForTest(null);
  setWorkflowJobResultResolverForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DirectWS legacy generated workflow lane", () => {
  it("keeps JOB_RESULT off every PNQ result path", async () => {
    setPnqV2RuntimeConfigForTest({ enabled: true, sweepIntervalMs: 30_000 });
    setDeviceExecutionAuthorityForTest("enforced");
    const server = new DirectWsServer();
    const send = vi.fn();
    const conn = {
      ws: { readyState: 1, send },
      deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "3.9.167",
      pnqV2ConnectionEpoch: 11,
    };
    const internals = server as unknown as {
      connections: Map<string, typeof conn>;
      sendLegacyGeneratedWorkflowJob: (targetDeviceId: string, payload: {
        jobId: string;
        type: "ui_tree_dump";
        params: Record<string, never>;
        timeoutMs: number;
      }) => { sent: boolean; resultPromise: Promise<unknown> };
      _handleJobResult: (connection: typeof conn, msg: Record<string, unknown>) => Promise<void>;
    };
    internals.connections.set(deviceId, conn);
    const recordShadowResult = vi.spyOn(pnqV2RuntimeService, "recordShadowResult");
    const acceptJobResult = vi.spyOn(deviceExecutionArbiter, "acceptJobResult");
    const observeTerminal = vi.spyOn(deviceExecutionArbiter, "observeTerminal");
    const handleJobResult = vi.spyOn(dispatcherService, "handleJobResult").mockResolvedValue(undefined as never);
    const resolveWorkflowResult = vi.fn(() => true);
    setWorkflowJobResultResolverForTest(resolveWorkflowResult);

    const { sent, resultPromise } = internals.sendLegacyGeneratedWorkflowJob(deviceId, {
      jobId,
      type: "ui_tree_dump",
      params: {},
      timeoutMs: 60_000,
    });

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.stringContaining(`"jobId":"${jobId}"`));
    await internals._handleJobResult(conn, {
      type: "JOB_RESULT",
      jobId,
      success: true,
      output: { tree: [] },
      durationMs: 5,
    });

    await expect(resultPromise).resolves.toMatchObject({
      jobId,
      success: true,
      output: { tree: [] },
    });
    expect(resolveWorkflowResult).toHaveBeenCalledWith(jobId, expect.objectContaining({
      output: { tree: [] },
    }));
    expect(recordShadowResult).not.toHaveBeenCalled();
    expect(acceptJobResult).not.toHaveBeenCalled();
    expect(observeTerminal).not.toHaveBeenCalled();
    expect(handleJobResult).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      authority: "legacy_generated_workflow",
    }));

    const source = fs.readFileSync(path.join(process.cwd(), "src/ws/direct-ws.server.ts"), "utf8");
    expect(source).toContain("if (!isLegacyGeneratedWorkflowResult) {");
    expect(source).toContain("dispatchQueuedJobsForDevice(conn.deviceId, \"direct_ws.job_result_queue_pump\")");
  });

  it("accepts a legacy JOB_RESULT during the executor grace window", async () => {
    vi.useFakeTimers();
    setPnqV2RuntimeConfigForTest({ enabled: true, sweepIntervalMs: 30_000 });
    setDeviceExecutionAuthorityForTest("enforced");
    const server = new DirectWsServer();
    const send = vi.fn();
    const conn = {
      ws: { readyState: 1, send },
      deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "3.9.167",
      pnqV2ConnectionEpoch: 11,
    };
    const internals = server as unknown as {
      connections: Map<string, typeof conn>;
      pendingJobs: Map<string, unknown>;
      sendLegacyGeneratedWorkflowJob: (targetDeviceId: string, payload: {
        jobId: string;
        type: "ui_tree_dump";
        params: Record<string, never>;
        timeoutMs: number;
      }, resultTimeoutMs?: number) => { sent: boolean; resultPromise: Promise<unknown> };
      _handleJobResult: (connection: typeof conn, msg: Record<string, unknown>) => Promise<void>;
    };
    internals.connections.set(deviceId, conn);
    const recordShadowResult = vi.spyOn(pnqV2RuntimeService, "recordShadowResult");
    const acceptJobResult = vi.spyOn(deviceExecutionArbiter, "acceptJobResult");
    const handleJobResult = vi.spyOn(dispatcherService, "handleJobResult").mockResolvedValue(undefined as never);
    const resolveWorkflowResult = vi.fn(() => true);
    setWorkflowJobResultResolverForTest(resolveWorkflowResult);

    const executionTimeoutMs = 1_000;
    const resultTimeoutMs = executionTimeoutMs + 5_000;
    const { resultPromise } = internals.sendLegacyGeneratedWorkflowJob(deviceId, {
      jobId,
      type: "ui_tree_dump",
      params: {},
      timeoutMs: executionTimeoutMs,
    }, resultTimeoutMs);

    await vi.advanceTimersByTimeAsync(executionTimeoutMs + 1);
    expect(internals.pendingJobs.has(jobId)).toBe(true);

    await internals._handleJobResult(conn, {
      type: "JOB_RESULT",
      jobId,
      success: true,
      output: { tree: ["late-but-within-grace"] },
      durationMs: executionTimeoutMs + 1,
    });

    await expect(resultPromise).resolves.toMatchObject({
      jobId,
      success: true,
      output: { tree: ["late-but-within-grace"] },
    });
    expect(resolveWorkflowResult).toHaveBeenCalledWith(jobId, expect.objectContaining({
      output: { tree: ["late-but-within-grace"] },
    }));
    expect(recordShadowResult).not.toHaveBeenCalled();
    expect(acceptJobResult).not.toHaveBeenCalled();
    expect(handleJobResult).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      authority: "legacy_generated_workflow",
    }));
    const source = fs.readFileSync(path.join(process.cwd(), "src/ws/direct-ws.server.ts"), "utf8");
    expect(source).toContain("if (!isLegacyGeneratedWorkflowResult) {");
    expect(source).toContain("dispatchQueuedJobsForDevice(conn.deviceId, \"direct_ws.job_result_queue_pump\")");
  });

  it("rejects and removes a legacy waiter after the full result grace window", async () => {
    vi.useFakeTimers();
    const server = new DirectWsServer();
    const send = vi.fn();
    const conn = {
      ws: { readyState: 1, send },
      deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "3.9.167",
      pnqV2ConnectionEpoch: 11,
    };
    const internals = server as unknown as {
      connections: Map<string, typeof conn>;
      pendingJobs: Map<string, unknown>;
      sendLegacyGeneratedWorkflowJob: (targetDeviceId: string, payload: {
        jobId: string;
        type: "ui_tree_dump";
        params: Record<string, never>;
        timeoutMs: number;
      }, resultTimeoutMs?: number) => { sent: boolean; resultPromise: Promise<unknown> };
    };
    internals.connections.set(deviceId, conn);

    const resultTimeoutMs = 1_250;
    const { resultPromise } = internals.sendLegacyGeneratedWorkflowJob(deviceId, {
      jobId,
      type: "ui_tree_dump",
      params: {},
      timeoutMs: 1_000,
    }, resultTimeoutMs);

    expect(internals.pendingJobs.has(jobId)).toBe(true);
    await vi.advanceTimersByTimeAsync(resultTimeoutMs + 1);

    await expect(resultPromise).rejects.toThrow(`Job ${jobId} timed out after ${resultTimeoutMs}ms`);
    expect(internals.pendingJobs.has(jobId)).toBe(false);
  });
});
