import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DirectWsServer, mergeWorkflowStatusVariables, otaTerminalStatusFromAuthenticatedVersion, resolveDirectWsResultHandle, sanitizeLifecycleTelemetry, setExternalWorkflowLifecycleTargetResolverForTest, setWorkflowJobResultResolverForTest } from "./direct-ws.server";
import { deviceExecutionArbiter, setDeviceExecutionAuthorityForTest, type DeviceExecutionHandle } from "../modules/device-execution";
import { pnqV2RuntimeService } from "../modules/device-execution/pnq-v2-runtime.service";
import { setPnqV2RuntimeConfigForTest } from "../modules/device-execution/pnq-v2-runtime-config";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";

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
  setDeviceExecutionAuthorityForTest(null);
  setPnqV2RuntimeConfigForTest(null);
  setWorkflowJobResultResolverForTest(null);
  setExternalWorkflowLifecycleTargetResolverForTest(null);
  vi.restoreAllMocks();
});

describe("sanitizeLifecycleTelemetry", () => {
  it("preserves bounded operational lifecycle evidence", () => {
    expect(sanitizeLifecycleTelemetry({
      processGeneration: 7,
      processStartedAt: 1234,
      lastEvent: "recovery_alarm",
      lastEventDetail: "periodic_watchdog",
      lastEventAt: 2345,
      previousExitInference: "process_recreated_without_clean_shutdown",
      unexpectedProcessRestartCount: 2,
      crashCount: 1,
      lastCrashStack: "stack",
      recoveryAlarmCount: 3,
      lastRecoverySource: "task_removed",
      batteryOptimizationExempt: true,
      secretPayload: "must not be persisted",
    })).toEqual({
      processGeneration: 7,
      processStartedAt: 1234,
      lastEvent: "recovery_alarm",
      lastEventDetail: "periodic_watchdog",
      lastEventAt: 2345,
      previousExitInference: "process_recreated_without_clean_shutdown",
      unexpectedProcessRestartCount: 2,
      crashCount: 1,
      lastCrashStack: "stack",
      recoveryAlarmCount: 3,
      lastRecoverySource: "task_removed",
      batteryOptimizationExempt: true,
    });
  });

  it("rejects non-objects and normalizes malformed fields", () => {
    expect(sanitizeLifecycleTelemetry("bad")).toBeUndefined();
    expect(sanitizeLifecycleTelemetry({
      processGeneration: -10,
      lastEvent: 42,
      batteryOptimizationExempt: "yes",
    })).toMatchObject({
      processGeneration: 0,
      lastEvent: "unknown",
      batteryOptimizationExempt: false,
    });
  });
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

describe("OTA terminal reconciliation", () => {
  const started = {
    deviceId: "00000000-0000-4000-8000-000000000002",
    status: "started",
    version: "4.0.60",
    versionCode: 116,
    apkSha256: "abc123",
    updatedAt: "2026-07-22T16:41:43.809Z",
  };

  it("marks an in-flight OTA successful when the reauthenticated package version matches", () => {
    expect(otaTerminalStatusFromAuthenticatedVersion(started, "4.0.60")).toEqual({
      status: "success",
      version: "4.0.60",
      versionCode: 116,
      apkSha256: "abc123",
      error: undefined,
    });
  });

  it("does not reconcile mismatched, missing, or already-terminal statuses", () => {
    expect(otaTerminalStatusFromAuthenticatedVersion(started, "4.0.59")).toBeNull();
    expect(otaTerminalStatusFromAuthenticatedVersion(undefined, "4.0.60")).toBeNull();
    expect(otaTerminalStatusFromAuthenticatedVersion({ ...started, status: "failed" }, "4.0.60")).toBeNull();
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

describe("PNQ v2 shadow DirectWS side effects", () => {
  it("does not await shadow result bookkeeping before legacy result admission", async () => {
    setPnqV2RuntimeConfigForTest({ mode: "shadow", sweepIntervalMs: 30_000 });
    setDeviceExecutionAuthorityForTest("enforced");
    const server = new DirectWsServer();
    const send = vi.fn();
    const conn = {
      ws: { readyState: 1, send },
      deviceId: expectedHandle.deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "4.0.0",
      pnqV2ConnectionEpoch: 7,
    };
    vi.spyOn(pnqV2RuntimeService, "recordShadowResult").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(deviceExecutionArbiter, "acceptJobResult").mockResolvedValue({
      accepted: false,
      decision: "rejected_stale",
      reason: "test_return_before_legacy_updates",
    } as never);
    vi.spyOn(dispatcherService, "handleJobResult").mockResolvedValue(undefined as never);

    await expect((server as unknown as {
      _handleJobResult: (connection: typeof conn, msg: Record<string, unknown>) => Promise<void>;
    })._handleJobResult(conn, {
      type: "JOB_RESULT",
      jobId: expectedHandle.operationId,
      success: true,
      output: {},
      durationMs: 5,
    })).resolves.toBeUndefined();

    expect(pnqV2RuntimeService.recordShadowResult).toHaveBeenCalledWith(expect.objectContaining({
      legacyJobId: expectedHandle.operationId,
      socketEpoch: 7,
    }));
    expect(deviceExecutionArbiter.acceptJobResult).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.stringContaining("\"ACK\""));
  });

  it("bypasses Queue v2 result bookkeeping completely while runtime is disabled", async () => {
    setPnqV2RuntimeConfigForTest({ mode: "disabled", sweepIntervalMs: 30_000 });
    setDeviceExecutionAuthorityForTest("observe_only");
    const server = new DirectWsServer();
    const send = vi.fn();
    const conn = {
      ws: { readyState: 1, send },
      deviceId: expectedHandle.deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "3.9.165",
    };
    const recordShadowResult = vi.spyOn(pnqV2RuntimeService, "recordShadowResult");
    const observeTerminal = vi.spyOn(deviceExecutionArbiter, "observeTerminal").mockResolvedValue({
      decision: "terminal",
      root: null,
    } as never);
    vi.spyOn(dispatcherService, "handleJobResult").mockResolvedValue(undefined as never);
    const resolveWorkflowResult = vi.fn(() => true);
    setWorkflowJobResultResolverForTest(resolveWorkflowResult);
    const internals = server as unknown as {
      waitForJobResult: (jobId: string, timeoutMs: number, deviceId?: string) => Promise<unknown>;
      _handleJobResult: (connection: typeof conn, msg: Record<string, unknown>) => Promise<void>;
    };
    const pending = internals.waitForJobResult(expectedHandle.operationId, 60_000, expectedHandle.deviceId);

    const handling = internals._handleJobResult(conn, {
      type: "JOB_RESULT",
      jobId: expectedHandle.operationId,
      success: true,
      output: { ok: true },
      durationMs: 5,
    });

    await expect(pending).resolves.toMatchObject({
      jobId: expectedHandle.operationId,
      success: true,
      status: "completed",
      output: { ok: true },
    });
    await expect(handling).resolves.toBeUndefined();
    expect(resolveWorkflowResult).toHaveBeenCalledWith(expectedHandle.operationId, expect.objectContaining({
      status: "completed",
      output: { ok: true },
    }));
    expect(recordShadowResult).not.toHaveBeenCalled();
    expect(observeTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps auth and result shadow hooks behind the shadow runtime guard in source", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/ws/direct-ws.server.ts"), "utf8");
    expect(source).toContain("if (isPnqV2ShadowRuntimeEnabled())");
    expect(source).toContain("const epochObservation = Promise.resolve()");
    expect(source).toContain("pnqV2RuntimeService.onConnectionAuthenticated(finalDeviceId)");
    expect(source).toContain("conn.pnqV2ConnectionEpochPromise = epochObservation");
    expect(source).toContain("this.connections.get(finalDeviceId) === conn");
    expect(source).toContain('runPnqV2ShadowSideEffect("direct-ws result"');
    expect(source).not.toContain("conn.pnqV2ConnectionEpoch = await pnqV2RuntimeService.onConnectionAuthenticated");
    expect(source).not.toContain("await pnqV2RuntimeService.recordShadowResult");
    expect(source).toContain('require("../modules/workflows/workflow.executor")');
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

describe("PNQ-003 observe-only DirectWS ingress compatibility", () => {
  function connection(send = vi.fn(), deviceId = expectedHandle.deviceId) {
    return {
      ws: { readyState: 1, send },
      deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "4.0.0",
    };
  }

  it("resolves observe-only BATCH_RESULT without a typed PNQ waiter handle", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    const server = new DirectWsServer();
    const internals = server as unknown as {
      waitForBatchResult: (batchId: string, timeoutMs: number, deviceId?: string) => Promise<unknown>;
      _handleBatchResult: (conn: ReturnType<typeof connection>, msg: Record<string, unknown>) => Promise<void>;
    };
    const observeTerminal = vi.spyOn(deviceExecutionArbiter, "observeTerminal").mockResolvedValue({
      decision: "terminal",
      root: null,
    });
    const pending = internals.waitForBatchResult("observe-batch", 60_000, expectedHandle.deviceId);

    await internals._handleBatchResult(connection(), {
      type: "BATCH_RESULT",
      batchId: "observe-batch",
      workflowId: "observe-workflow",
      status: "completed",
      results: [{ id: 1, status: "completed" }],
      totalDurationMs: 42,
    });

    await expect(pending).resolves.toMatchObject({
      batchId: "observe-batch",
      workflowId: "observe-workflow",
      status: "completed",
      totalDurationMs: 42,
    });
    expect(observeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      rootKind: "batch",
      externalId: "observe-batch",
      status: "completed",
      actor: "direct_ws.observe_only",
    }));
  });

  it("rejects a mismatched device result without consuming the observe-only BATCH waiter", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    const server = new DirectWsServer();
    const internals = server as unknown as {
      waitForBatchResult: (batchId: string, timeoutMs: number, deviceId?: string) => Promise<unknown>;
      rejectObserveOnlyBatchWaiter: (batchId: string, deviceId: string, reason: string) => void;
      observeOnlyPendingBatches: Map<string, unknown>;
      _handleBatchResult: (conn: ReturnType<typeof connection>, msg: Record<string, unknown>) => Promise<void>;
    };
    const rejected = vi.spyOn(deviceExecutionArbiter, "recordRejectedEgress").mockResolvedValue(undefined as never);
    const observeTerminal = vi.spyOn(deviceExecutionArbiter, "observeTerminal");
    const pending = internals.waitForBatchResult("device-bound-batch", 60_000, expectedHandle.deviceId);

    await internals._handleBatchResult(
      connection(vi.fn(), "99999999-9999-4999-8999-999999999999"),
      { type: "BATCH_RESULT", batchId: "device-bound-batch", status: "completed", results: [] },
    );

    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ reason: "batch_result_device_mismatch" }));
    expect(observeTerminal).not.toHaveBeenCalled();
    expect(internals.observeOnlyPendingBatches.has("device-bound-batch")).toBe(true);
    internals.rejectObserveOnlyBatchWaiter("device-bound-batch", expectedHandle.deviceId, "test_cleanup");
    await expect(pending).rejects.toThrow("test_cleanup");
  });

  it("drains observe-only BATCH waiters during shutdown", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    const server = new DirectWsServer();
    const pending = server.waitForBatchResult("shutdown-batch", 60_000, expectedHandle.deviceId);

    await server.close();

    await expect(pending).rejects.toThrow("Server shutting down");
  });

  it("keeps enforced BATCH_RESULT fail-closed without a typed PNQ waiter", async () => {
    setDeviceExecutionAuthorityForTest("enforced");
    const server = new DirectWsServer();
    const internals = server as unknown as {
      _handleBatchResult: (conn: ReturnType<typeof connection>, msg: Record<string, unknown>) => Promise<void>;
    };
    const rejected = vi.spyOn(deviceExecutionArbiter, "recordRejectedEgress").mockResolvedValue(undefined as never);
    const observeTerminal = vi.spyOn(deviceExecutionArbiter, "observeTerminal");

    await internals._handleBatchResult(connection(), {
      type: "BATCH_RESULT",
      batchId: "untyped-batch",
      status: "completed",
      results: [],
    });

    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "untyped-batch",
      wireType: "BATCH_RESULT",
      reason: "batch_result_without_waiter",
    }));
    expect(observeTerminal).not.toHaveBeenCalled();
  });

  it("persists and publishes observe-only terminal WORKFLOW_STATUS without a pending PNQ handle", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    setExternalWorkflowLifecycleTargetResolverForTest(async () => ({
      terminal: true,
      retryable: false,
      administrative: false,
      markCompleted: true,
    }));
    const server = new DirectWsServer();
    const internals = server as unknown as {
      _handleWorkflowStatus: (conn: ReturnType<typeof connection>, msg: Record<string, unknown>) => Promise<void>;
      _persistWorkflowStatus: (...args: unknown[]) => Promise<void>;
    };
    const observeTerminal = vi.spyOn(deviceExecutionArbiter, "observeTerminal").mockResolvedValue({
      decision: "terminal",
      root: null,
    });
    const rejected = vi.spyOn(deviceExecutionArbiter, "recordRejectedEgress");
    const persist = vi.spyOn(internals, "_persistWorkflowStatus").mockResolvedValue(undefined);
    const { workflowEvents } = await import("../modules/workflow-events");
    const publish = vi.spyOn(workflowEvents, "publish");

    await internals._handleWorkflowStatus(connection(), {
      type: "WORKFLOW_STATUS",
      workflowId: "observe-workflow",
      status: "completed",
      currentStep: 2,
      totalSteps: 2,
      variables: { controlPlaneContext: { taskId: "task-1" }, value: true },
    });

    expect(rejected).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "observe-workflow",
      event: "completed",
      status: "completed",
      taskId: "task-1",
    }));
    expect(observeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      rootKind: "edge_workflow",
      externalId: "observe-workflow",
      status: "completed",
      actor: "direct_ws.observe_only",
    }));
    expect(persist).toHaveBeenCalledWith(
      expectedHandle.deviceId,
      "observe-workflow",
      "completed",
      2,
      2,
      undefined,
      expect.objectContaining({ value: true }),
    );
  });

  it("keeps enforced WORKFLOW_STATUS fail-closed without a pending PNQ handle", async () => {
    setDeviceExecutionAuthorityForTest("enforced");
    const server = new DirectWsServer();
    const internals = server as unknown as {
      _handleWorkflowStatus: (conn: ReturnType<typeof connection>, msg: Record<string, unknown>) => Promise<void>;
      _persistWorkflowStatus: (...args: unknown[]) => Promise<void>;
    };
    const rejected = vi.spyOn(deviceExecutionArbiter, "recordRejectedEgress").mockResolvedValue(undefined as never);
    const persist = vi.spyOn(internals, "_persistWorkflowStatus").mockResolvedValue(undefined);

    await internals._handleWorkflowStatus(connection(), {
      type: "WORKFLOW_STATUS",
      workflowId: "untyped-workflow",
      status: "completed",
      currentStep: 1,
      totalSteps: 1,
    });

    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "untyped-workflow",
      wireType: "WORKFLOW_STATUS",
      reason: "workflow_status_without_pending_handle",
    }));
    expect(persist).not.toHaveBeenCalled();
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

  it("records a server-workflow child timeout without blocking its canonical root", async () => {
    const server = new DirectWsServer();
    const permit = jobPermit("child-timeout");
    const pendingJob = server.registerJobWaiterWithPermit(permit, 60_000);
    const internals = server as unknown as {
      pendingJobs: Map<string, unknown>;
      expirePendingJob: (jobId: string, timeoutMs: number, jobDispatchPermit: ReturnType<typeof jobPermit>) => Promise<void>;
    };
    const expireChild = vi.spyOn(deviceExecutionArbiter, "expireServerWorkflowChild")
      .mockResolvedValue({ decision: "terminal", root: null });
    const markAmbiguous = vi.spyOn(deviceExecutionArbiter, "markAmbiguous");

    await internals.expirePendingJob(permit.handle.operationId, 1234, permit);

    await expect(pendingJob).rejects.toThrow("timed out after 1234ms");
    expect(expireChild).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: permit.handle.deviceId,
      jobId: permit.handle.operationId,
      handle: permit.handle,
      reason: "job_result_timeout",
    }));
    expect(markAmbiguous).not.toHaveBeenCalled();
    expect(internals.pendingJobs.has(permit.handle.operationId)).toBe(false);
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
      vi.spyOn(deviceExecutionArbiter, "expireServerWorkflowChild").mockImplementation(async (input) => {
        const operationId = input.jobId;
        const count = (attempts.get(operationId) ?? 0) + 1;
        attempts.set(operationId, count);
        if (count === 1) throw new Error("db unavailable");
        return { decision: "terminal", root: null };
      });
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
