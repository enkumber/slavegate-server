import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DirectWsServer, mergeWorkflowStatusVariables, resolveDirectWsResultHandle } from "./direct-ws.server";
import { deviceExecutionArbiter, type DeviceExecutionHandle } from "../modules/device-execution";

const expectedHandle: DeviceExecutionHandle = {
  rootId: "00000000-0000-4000-8000-000000000001",
  deviceId: "00000000-0000-4000-8000-000000000002",
  rootKind: "server_workflow",
  ownerGeneration: 7,
  operationKind: "job",
  operationId: "00000000-0000-4000-8000-000000000003",
};

const wireHandle = {
  pnqRootId: expectedHandle.rootId,
  pnqDeviceId: expectedHandle.deviceId,
  pnqRootKind: expectedHandle.rootKind,
  pnqOwnerGeneration: expectedHandle.ownerGeneration,
  pnqOperationKind: expectedHandle.operationKind,
  pnqOperationId: expectedHandle.operationId,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mergeWorkflowStatusVariables", () => {
  it("preserves materialized output fields when device reports no variables", () => {
    const existingCheckpoint = {
      variables: {
        loggedIn: "unknown",
        homeFeedVisible: "unknown",
        searchSurfaceAvailable: "unknown",
        challengeDetected: "unknown",
        loginWallDetected: "unknown",
        accountSwitcherVisible: "unknown",
        observedUsername: "",
        error: "",
      },
    };

    expect(mergeWorkflowStatusVariables(existingCheckpoint, undefined)).toEqual(existingCheckpoint.variables);
    expect(mergeWorkflowStatusVariables(existingCheckpoint, {})).toEqual(existingCheckpoint.variables);
  });

  it("overlays reported variables without clearing existing output defaults", () => {
    const existingCheckpoint = {
      variables: {
        loggedIn: "unknown",
        homeFeedVisible: "unknown",
        searchSurfaceAvailable: "unknown",
        observedUsername: "",
        error: "",
      },
    };

    expect(mergeWorkflowStatusVariables(existingCheckpoint, {
      loggedIn: "true",
      observedUsername: "u_healthcheck",
      error: undefined,
    })).toEqual({
      loggedIn: "true",
      homeFeedVisible: "unknown",
      searchSurfaceAvailable: "unknown",
      observedUsername: "u_healthcheck",
      error: "",
    });
  });
});

describe("DirectWS Android result handle compatibility", () => {
  it.each([
    { type: "JOB_RESULT", jobId: expectedHandle.operationId, success: true, output: {}, durationMs: 12 },
    { type: "BATCH_RESULT", batchId: expectedHandle.operationId, status: "completed", results: [], totalDurationMs: 12 },
    { type: "WORKFLOW_STATUS", workflowId: expectedHandle.operationId, status: "running", currentStep: 0, totalSteps: 1 },
  ])("accepts authenticated Android-shaped $type without pnqHandle against the exact pending handle", (message) => {
    expect(resolveDirectWsResultHandle(expectedHandle, message)).toEqual({
      accepted: true,
      reportedHandle: null,
      compatibility: "authenticated_pending_handle",
    });
  });

  it("accepts an exactly echoed handle", () => {
    expect(resolveDirectWsResultHandle(expectedHandle, { type: "JOB_RESULT", pnqHandle: wireHandle })).toMatchObject({
      accepted: true,
      reportedHandle: expectedHandle,
      compatibility: "echoed_handle",
    });
  });

  it("rejects a reported handle instead of falling back when it mismatches", () => {
    expect(resolveDirectWsResultHandle(expectedHandle, {
      type: "JOB_RESULT",
      pnqHandle: { ...wireHandle, pnqOwnerGeneration: 8 },
    })).toMatchObject({
      accepted: false,
      compatibility: "rejected",
      reason: "reported_handle_mismatch",
    });
  });

  it("rejects a malformed reported handle instead of treating it as missing", () => {
    expect(resolveDirectWsResultHandle(expectedHandle, { type: "BATCH_RESULT", pnqHandle: { bad: true } })).toEqual({
      accepted: false,
      reportedHandle: null,
      compatibility: "rejected",
      reason: "reported_handle_invalid",
    });
  });
});

describe("DirectWS typed BATCH serializer identity", () => {
  const valid: DeviceExecutionHandle = {
    ...expectedHandle,
    rootKind: "server_workflow",
    operationKind: "batch",
    operationId: "batch-child",
  };

  it.each([
    { ...valid, rootKind: "edge_workflow" as const },
    { ...valid, operationKind: "job" as const },
    { ...valid, operationId: "wrong-batch" },
  ])("rejects an invalid typed BATCH identity before connection or wire", (handle) => {
    const server = new DirectWsServer();
    expect(() => server.sendBatchWithHandle(handle, { type: "BATCH_START", batchId: "batch-child" }))
      .toThrow("DirectWS BATCH handle does not match payload identity");
  });
});

describe("DirectWS LLM_REQUEST safety", () => {
  it("uses bounded server-side LLM handling without prompt logging or raw error egress", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/ws/direct-ws.server.ts"), "utf8");
    expect(source).toContain("private activeLlmRequests = new Map<string, number>()");
    expect(source).toContain("promptLength=");
    expect(source).not.toContain("prompt?.slice");
    expect(source).toContain("timeoutMs: 30_000");
    expect(source).toContain("sendLlmError");
    expect(source).toContain("errorCode");
    expect(source).toContain("AI_LLM_BUSY");
  });
});

describe("DirectWS typed pending lifecycle", () => {
  const deviceB = "00000000-0000-4000-8000-000000000099";
  const batchHandle = (deviceId: string, operationId: string): DeviceExecutionHandle => ({
    rootId: `root-${operationId}`,
    deviceId,
    rootKind: "batch",
    ownerGeneration: 1,
    operationKind: "batch",
    operationId,
  });
  const workflowHandle = (deviceId: string, operationId: string): DeviceExecutionHandle => ({
    rootId: `root-${operationId}`,
    deviceId,
    rootKind: "edge_workflow",
    ownerGeneration: 1,
    operationKind: "workflow",
    operationId,
  });
  const jobPermit = (operationId: string) => {
    const handle = { ...expectedHandle, operationId };
    return {
      kind: "device_execution_job_dispatch_permit" as const,
      handle,
      wireHandle: {
        pnqRootId: handle.rootId,
        pnqDeviceId: handle.deviceId,
        pnqRootKind: handle.rootKind,
        pnqOwnerGeneration: handle.ownerGeneration,
        pnqOperationKind: handle.operationKind,
        pnqOperationId: handle.operationId,
      },
    };
  };

  it("awaits ambiguity writes and drains only the disconnected device", async () => {
    const server = new DirectWsServer();
    const batchA = batchHandle(expectedHandle.deviceId, "batch-a");
    const batchB = batchHandle(deviceB, "batch-b");
    const pendingA = server.registerBatchWaiterWithHandle(batchA, 60_000);
    const pendingB = server.registerBatchWaiterWithHandle(batchB, 60_000);
    const workflowA = workflowHandle(expectedHandle.deviceId, "workflow-a");
    const workflowB = workflowHandle(deviceB, "workflow-b");
    const workflowTimerA = setTimeout(() => {}, 60_000);
    const workflowTimerB = setTimeout(() => {}, 60_000);
    workflowTimerA.unref();
    workflowTimerB.unref();
    const internals = server as unknown as {
      pendingBatches: Map<string, unknown>;
      pendingWorkflows: Map<string, { handle: DeviceExecutionHandle; timer: ReturnType<typeof setTimeout> }>;
      blockPendingForDisconnectedDevice: (deviceId: string, code: number, reason: string) => Promise<{ jobs: number; batches: number; workflows: number }>;
    };
    internals.pendingWorkflows.set(workflowA.operationId, { handle: workflowA, timer: workflowTimerA });
    internals.pendingWorkflows.set(workflowB.operationId, { handle: workflowB, timer: workflowTimerB });

    let releaseWrites!: () => void;
    const writesReleased = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const markAmbiguous = vi.spyOn(deviceExecutionArbiter, "markAmbiguous").mockImplementation(async () => {
      await writesReleased;
      return { decision: "ambiguous", root: null };
    });
    let batchARejected = false;
    void pendingA.catch(() => { batchARejected = true; });
    const draining = internals.blockPendingForDisconnectedDevice(expectedHandle.deviceId, 1006, "lost");
    await Promise.resolve();
    expect(batchARejected).toBe(false);
    expect(internals.pendingBatches.has(batchA.operationId)).toBe(true);

    releaseWrites();
    await expect(draining).resolves.toEqual({ jobs: 0, batches: 1, workflows: 1 });
    await expect(pendingA).rejects.toThrow("disconnected during batch batch-a");
    expect(markAmbiguous).toHaveBeenCalledTimes(2);
    expect(internals.pendingBatches.has(batchA.operationId)).toBe(false);
    expect(internals.pendingWorkflows.has(workflowA.operationId)).toBe(false);
    expect(internals.pendingBatches.has(batchB.operationId)).toBe(true);
    expect(internals.pendingWorkflows.has(workflowB.operationId)).toBe(true);

    server.rejectBatchWaiterWithHandle(batchB, "test cleanup");
    await expect(pendingB).rejects.toThrow("test cleanup");
    clearTimeout(workflowTimerB);
    internals.pendingWorkflows.delete(workflowB.operationId);
  });

  it("blocks batch and workflow roots before clearing their timeout state", async () => {
    const server = new DirectWsServer();
    const batch = batchHandle(expectedHandle.deviceId, "batch-timeout");
    const workflow = workflowHandle(expectedHandle.deviceId, "workflow-timeout");
    const pendingBatch = server.registerBatchWaiterWithHandle(batch, 60_000);
    const workflowTimer = setTimeout(() => {}, 60_000);
    workflowTimer.unref();
    const internals = server as unknown as {
      pendingBatches: Map<string, unknown>;
      pendingWorkflows: Map<string, { handle: DeviceExecutionHandle; timer: ReturnType<typeof setTimeout> }>;
      expirePendingBatch: (handle: DeviceExecutionHandle, timeoutMs: number) => Promise<void>;
      expirePendingWorkflow: (handle: DeviceExecutionHandle) => Promise<void>;
    };
    internals.pendingWorkflows.set(workflow.operationId, { handle: workflow, timer: workflowTimer });
    const markAmbiguous = vi.spyOn(deviceExecutionArbiter, "markAmbiguous").mockResolvedValue({ decision: "ambiguous", root: null });

    await internals.expirePendingBatch(batch, 1234);
    await internals.expirePendingWorkflow(workflow);

    await expect(pendingBatch).rejects.toThrow("timed out after 1234ms");
    expect(markAmbiguous).toHaveBeenCalledWith(expect.objectContaining({ handle: batch, reason: "batch_result_timeout" }));
    expect(markAmbiguous).toHaveBeenCalledWith(expect.objectContaining({ handle: workflow, reason: "workflow_status_timeout" }));
    expect(internals.pendingBatches.has(batch.operationId)).toBe(false);
    expect(internals.pendingWorkflows.has(workflow.operationId)).toBe(false);
  });

  it("retains JOB, BATCH, and WORKFLOW pending state until a bounded ambiguity retry succeeds", async () => {
    vi.useFakeTimers();
    try {
      const server = new DirectWsServer();
      const permit = jobPermit("job-retry");
      const batch = batchHandle(expectedHandle.deviceId, "batch-retry");
      const workflow = workflowHandle(expectedHandle.deviceId, "workflow-retry");
      const pendingJob = server.registerJobWaiterWithPermit(permit, 60_000);
      const pendingBatch = server.registerBatchWaiterWithHandle(batch, 60_000);
      const workflowTimer = setTimeout(() => {}, 60_000);
      const internals = server as unknown as {
        pendingJobs: Map<string, unknown>;
        pendingBatches: Map<string, unknown>;
        pendingWorkflows: Map<string, { handle: DeviceExecutionHandle; timer: ReturnType<typeof setTimeout> }>;
        expirePendingJob: (jobId: string, timeoutMs: number, jobDispatchPermit: ReturnType<typeof jobPermit>) => Promise<void>;
        expirePendingBatch: (handle: DeviceExecutionHandle, timeoutMs: number) => Promise<void>;
        expirePendingWorkflow: (handle: DeviceExecutionHandle) => Promise<void>;
      };
      internals.pendingWorkflows.set(workflow.operationId, { handle: workflow, timer: workflowTimer });
      const attempts = new Map<string, number>();
      vi.spyOn(deviceExecutionArbiter, "markAmbiguous").mockImplementation(async (input) => {
        const operationId = input.handle!.operationId;
        const count = (attempts.get(operationId) ?? 0) + 1;
        attempts.set(operationId, count);
        if (count === 1) throw new Error("db unavailable");
        return { decision: "ambiguous", root: null };
      });

      await Promise.all([
        internals.expirePendingJob(permit.handle.operationId, 1234, permit),
        internals.expirePendingBatch(batch, 1234),
        internals.expirePendingWorkflow(workflow),
      ]);
      expect(internals.pendingJobs.has(permit.handle.operationId)).toBe(true);
      expect(internals.pendingBatches.has(batch.operationId)).toBe(true);
      expect(internals.pendingWorkflows.has(workflow.operationId)).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      await expect(pendingJob).rejects.toThrow("timed out after 1234ms");
      await expect(pendingBatch).rejects.toThrow("timed out after 1234ms");
      expect(internals.pendingJobs.has(permit.handle.operationId)).toBe(false);
      expect(internals.pendingBatches.has(batch.operationId)).toBe(false);
      expect(internals.pendingWorkflows.has(workflow.operationId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains disconnected pending work when ambiguity persistence fails, then drains it after retry", async () => {
    vi.useFakeTimers();
    try {
      const server = new DirectWsServer();
      const permit = jobPermit("job-disconnect-retry");
      const batch = batchHandle(expectedHandle.deviceId, "batch-disconnect-retry");
      const workflow = workflowHandle(expectedHandle.deviceId, "workflow-disconnect-retry");
      const pendingJob = server.registerJobWaiterWithPermit(permit, 60_000);
      const pendingBatch = server.registerBatchWaiterWithHandle(batch, 60_000);
      const workflowTimer = setTimeout(() => {}, 60_000);
      const internals = server as unknown as {
        pendingJobs: Map<string, unknown>;
        pendingBatches: Map<string, unknown>;
        pendingWorkflows: Map<string, { handle: DeviceExecutionHandle; timer: ReturnType<typeof setTimeout> }>;
        blockPendingForDisconnectedDevice: (deviceId: string, code: number, reason: string) => Promise<unknown>;
      };
      internals.pendingWorkflows.set(workflow.operationId, { handle: workflow, timer: workflowTimer });
      const attempts = new Map<string, number>();
      vi.spyOn(deviceExecutionArbiter, "markAmbiguous").mockImplementation(async (input) => {
        const operationId = input.handle!.operationId;
        const count = (attempts.get(operationId) ?? 0) + 1;
        attempts.set(operationId, count);
        if (count === 1) throw new Error("db unavailable");
        return { decision: "ambiguous", root: null };
      });

      await internals.blockPendingForDisconnectedDevice(expectedHandle.deviceId, 1006, "lost");
      expect(internals.pendingJobs.has(permit.handle.operationId)).toBe(true);
      expect(internals.pendingBatches.has(batch.operationId)).toBe(true);
      expect(internals.pendingWorkflows.has(workflow.operationId)).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      await expect(pendingJob).rejects.toThrow("disconnected");
      await expect(pendingBatch).rejects.toThrow("disconnected");
      expect(internals.pendingJobs.has(permit.handle.operationId)).toBe(false);
      expect(internals.pendingBatches.has(batch.operationId)).toBe(false);
      expect(internals.pendingWorkflows.has(workflow.operationId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a superseded socket close without deleting or blocking the replacement connection", async () => {
    const server = new DirectWsServer();
    const oldWs = {} as any;
    const replacementWs = {} as any;
    const oldConnection = {
      ws: oldWs,
      deviceId: expectedHandle.deviceId,
      connectedAt: 1,
      lastSeenAt: 1,
      lastPongAt: 1,
      msgCount: 0,
      windowStart: 1,
      agentVersion: "4.0.0",
    };
    const replacement = { ...oldConnection, ws: replacementWs, connectedAt: 2 };
    const internals = server as unknown as {
      connections: Map<string, typeof replacement>;
      blockPendingForDisconnectedDevice: (deviceId: string, code: number, reason: string) => Promise<unknown>;
      handleAuthenticatedClose: (ws: any, connection: typeof oldConnection, code: number, reason: string) => Promise<string>;
    };
    internals.connections.set(expectedHandle.deviceId, replacement);
    const blockPending = vi.spyOn(internals, "blockPendingForDisconnectedDevice");

    await expect(internals.handleAuthenticatedClose(oldWs, oldConnection, 4000, "replaced")).resolves.toBe("superseded");
    expect(internals.connections.get(expectedHandle.deviceId)).toBe(replacement);
    expect(blockPending).not.toHaveBeenCalled();
  });

  it.each([
    { label: "PONG timeout", readyState: 1, lastPongAt: 0, expectedCode: 4002 },
    { label: "non-open socket", readyState: 3, lastPongAt: Date.now(), expectedCode: 1006 },
  ])("routes $label through ambiguity-aware close cleanup before map deletion", async ({ readyState, lastPongAt, expectedCode }) => {
    const server = new DirectWsServer();
    const ws = { readyState, send: vi.fn(), close: vi.fn() } as any;
    const connection = {
      ws,
      deviceId: expectedHandle.deviceId,
      connectedAt: 1,
      lastSeenAt: 1,
      lastPongAt,
      msgCount: 0,
      windowStart: 1,
      agentVersion: "4.0.0",
    };
    const internals = server as unknown as {
      connections: Map<string, typeof connection>;
      _pingAll: () => void;
      handleAuthenticatedClose: (socket: any, conn: typeof connection, code: number, reason: string) => Promise<string>;
    };
    internals.connections.set(expectedHandle.deviceId, connection);
    const closeCleanup = vi.spyOn(internals, "handleAuthenticatedClose").mockImplementation(async () => {
      expect(internals.connections.get(expectedHandle.deviceId)).toBe(connection);
      return "closed";
    });

    internals._pingAll();
    await vi.waitFor(() => expect(closeCleanup).toHaveBeenCalledTimes(1));
    expect(closeCleanup).toHaveBeenCalledWith(ws, connection, expectedCode, expect.any(String));
  });

  it("contains rejected asynchronous socket tasks instead of leaking unhandled rejections", async () => {
    const server = new DirectWsServer();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const internals = server as unknown as { runSocketTask: (label: string, task: () => Promise<void>) => void };

    internals.runSocketTask("test", async () => { throw new Error("handler exploded"); });
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith("[direct-ws] test handler failed:", "handler exploded");
  });
});
