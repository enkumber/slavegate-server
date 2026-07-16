import { afterEach, describe, expect, it, vi } from "vitest";
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
});
