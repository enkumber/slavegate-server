import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchQueuedJobsForDevice,
  isEdgeWorkflowReplayEnvelope,
  isJobReplayEnvelope,
  sendBatchToDeviceEnforced,
  sendEdgeWorkflowToDeviceEnforced,
  sendServerWorkflowBatchChildToDevice,
  sendDeviceExecutionJobToDevice,
  sweepQueuedJobsForOnlineDevices,
  type DeviceExecutionEdgeWorkflowReplayEnvelopeV1,
  type DeviceExecutionJobReplayEnvelopeV1,
} from "./transport";
import { deviceExecutionArbiter, setDeviceExecutionAuthorityForTest, type DeviceExecutionHandle } from "../modules/device-execution";
import { directWsServer } from "../ws/direct-ws.server";
import * as dbClient from "../db/client";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const lifecycleMocks = vi.hoisted(() => ({
  promoteReplayedEdgeWorkflowToRunning: vi.fn(),
}));

vi.mock("../modules/workflows/edge-workflow-lifecycle.service", () => lifecycleMocks);

afterEach(() => {
  setDeviceExecutionAuthorityForTest(null);
  vi.restoreAllMocks();
  lifecycleMocks.promoteReplayedEdgeWorkflowToRunning.mockReset();
});

describe("PNQ-003 observe-only production transport", () => {
  it("uses the real DirectWS transport without requiring a PNQ permit or queue claim", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    const send = vi.fn();
    const internals = directWsServer as unknown as {
      connections: Map<string, { ws: { readyState: number; send: typeof send }; lastSeenAt: number }>;
    };
    internals.connections.set(DEVICE_ID, { ws: { readyState: 1, send }, lastSeenAt: Date.now() });
    const observe = vi.spyOn(deviceExecutionArbiter, "observeDispatch").mockResolvedValue({ decision: "dispatched", root: null });
    const enforce = vi.spyOn(deviceExecutionArbiter, "runStandaloneJobEgress");

    const result = await sendDeviceExecutionJobToDevice(DEVICE_ID, envelope().payload, {
      boundary: "generated_child",
      rootKind: "server_workflow",
      rootExternalId: "cron-workflow-1",
      actor: "task_runner.cron.integration",
    });

    expect(result).toMatchObject({ sent: true, queued: false, decision: "dispatched" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]![0]))).toMatchObject({ type: "JOB", jobId: "job-1" });
    expect(enforce).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledTimes(1);
    internals.connections.delete(DEVICE_ID);
  });
});

function envelope(): DeviceExecutionJobReplayEnvelopeV1 {
  return {
    schemaVersion: "pnq.job-dispatch/v1",
    deviceId: DEVICE_ID,
    rootKind: "job",
    rootExternalId: "job-1",
    operationKind: "job",
    operationId: "job-1",
    boundary: "standalone_job",
    payload: { jobId: "job-1", type: "screenshot", params: {}, timeoutMs: 10_000 },
  };
}

function edgeWorkflowEnvelope(): DeviceExecutionEdgeWorkflowReplayEnvelopeV1 {
  return {
    schemaVersion: "pnq.edge-workflow-dispatch/v1",
    deviceId: DEVICE_ID,
    rootKind: "edge_workflow",
    rootExternalId: "workflow-1",
    operationKind: "workflow",
    operationId: "workflow-1",
    boundary: "edge_workflow",
    template: { id: "template-1", steps: [] },
    variables: { generatedWorkflow: true },
  };
}

describe("PNQ job replay envelope", () => {
  it("accepts only the schema-versioned envelope tied to root and operation identity", () => {
    const identity = {
      deviceId: DEVICE_ID,
      rootKind: "job" as const,
      rootExternalId: "job-1",
      operationId: "job-1",
    };
    expect(isJobReplayEnvelope(envelope(), identity)).toBe(true);
    expect(isJobReplayEnvelope({ ...envelope(), deviceId: "wrong" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), rootExternalId: "wrong" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), operationId: "wrong" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), schemaVersion: "pnq.job-dispatch/v2" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), payload: { ...envelope().payload, jobId: "wrong" } }, identity)).toBe(false);
  });

  it("accepts only the schema-versioned edge workflow replay envelope tied to PNQ identity", () => {
    const identity = {
      deviceId: DEVICE_ID,
      rootKind: "edge_workflow" as const,
      rootExternalId: "workflow-1",
      operationId: "workflow-1",
    };
    expect(isEdgeWorkflowReplayEnvelope(edgeWorkflowEnvelope(), identity)).toBe(true);
    expect(isEdgeWorkflowReplayEnvelope({ ...edgeWorkflowEnvelope(), deviceId: "wrong" }, identity)).toBe(false);
    expect(isEdgeWorkflowReplayEnvelope({ ...edgeWorkflowEnvelope(), rootExternalId: "wrong" }, identity)).toBe(false);
    expect(isEdgeWorkflowReplayEnvelope({ ...edgeWorkflowEnvelope(), operationId: "wrong" }, identity)).toBe(false);
    expect(isEdgeWorkflowReplayEnvelope({ ...edgeWorkflowEnvelope(), schemaVersion: "pnq.edge-workflow-dispatch/v2" }, identity)).toBe(false);
    expect(isEdgeWorkflowReplayEnvelope({ ...edgeWorkflowEnvelope(), template: null }, identity)).toBe(false);
    expect(isEdgeWorkflowReplayEnvelope(edgeWorkflowEnvelope(), { ...identity, rootKind: "job" })).toBe(false);
  });

  it("pins immutable duplicate metadata and corrupt-head fail-closed SQL paths", () => {
    const arbiterSource = fs.readFileSync(
      path.join(process.cwd(), "src/modules/device-execution/device-execution-arbiter.ts"),
      "utf8",
    );
    const transportSource = fs.readFileSync(
      path.join(process.cwd(), "src/transport/transport.ts"),
      "utf8",
    );
    expect(arbiterSource).toContain("EXCLUDED.metadata - 'dispatchEnvelope'");
    expect(arbiterSource).toContain("queue_replay_corrupt_head_blocked");
    expect(transportSource).toContain("invalid_or_mismatched_dispatch_envelope");
  });

  it("tracks and clears the queue sweep and awaits fail-closed shutdown ambiguity handling", () => {
    const indexSource = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    const directWsSource = fs.readFileSync(path.join(process.cwd(), "src/ws/direct-ws.server.ts"), "utf8");
    expect(indexSource).toContain("const queueSweepTimer = isDeviceExecutionEnforced()");
    expect(indexSource).toContain("if (isDeviceExecutionEnforced())");
    expect(indexSource).toContain("queueSweepTimer.unref()");
    expect(indexSource).toContain("if (queueSweepTimer) clearInterval(queueSweepTimer)");
    expect(directWsSource).toContain("await Promise.all(confirmations)");
    expect(directWsSource).toContain("pending work retained");
    expect(directWsSource).toContain("this.confirmAmbiguityBeforeCleanup");
  });

  it("disables observe-only queue replay before reading stale queued envelopes or sending wire frames", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    const staleEnvelope = edgeWorkflowEnvelope();
    const staleSnapshot = structuredClone(staleEnvelope);
    const send = vi.fn();
    const internals = directWsServer as unknown as {
      connections: Map<string, { ws: { readyState: number; send: typeof send }; lastSeenAt: number }>;
    };
    internals.connections.set(DEVICE_ID, { ws: { readyState: 1, send }, lastSeenAt: Date.now() });
    const query = vi.fn().mockResolvedValue({
      rows: [{
        root_id: "stale-root",
        root_kind: "edge_workflow",
        root_external_id: staleEnvelope.rootExternalId,
        owner_generation: "1",
        operation_id: staleEnvelope.operationId,
        metadata: { dispatchEnvelope: staleEnvelope },
      }],
    });
    vi.spyOn(dbClient, "getDb").mockReturnValue({ query } as never);

    await expect(dispatchQueuedJobsForDevice(DEVICE_ID, "test.observe_only_queue_pump")).resolves.toEqual({
      attempted: 0,
      sent: 0,
    });
    await expect(sweepQueuedJobsForOnlineDevices("test.observe_only_queue_sweep")).resolves.toEqual({
      devices: 0,
      attempted: 0,
      sent: 0,
    });

    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(staleEnvelope).toEqual(staleSnapshot);
    internals.connections.delete(DEVICE_ID);
  });
});

describe("PNQ unreplayable observed-root disposition", () => {
  const handle: DeviceExecutionHandle = {
    rootId: "22222222-2222-4222-8222-222222222222",
    deviceId: DEVICE_ID,
    rootKind: "batch",
    ownerGeneration: 0,
    operationKind: "batch",
    operationId: "batch-waiting",
  };

  function mockWouldWait(waitingHandle: DeviceExecutionHandle) {
    vi.spyOn(deviceExecutionArbiter, "runObservedEgress").mockResolvedValue({
      decision: "would_wait",
      root: null,
      handle: waitingHandle,
      sent: false,
      reason: "device_slot_already_active",
    });
    return vi.spyOn(deviceExecutionArbiter, "observeTerminal").mockResolvedValue({
      decision: "terminal",
      root: null,
      handle: waitingHandle,
    });
  }

  it("cancels and audits a queued standalone batch before caller fallback", async () => {
    const observeTerminal = mockWouldWait(handle);
    await expect(sendBatchToDeviceEnforced(DEVICE_ID, {
      type: "BATCH_START",
      batchId: handle.operationId,
      workflowId: "wf",
      steps: [],
    }, 1_000)).rejects.toThrow("device_slot_already_active");
    expect(observeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      handle,
      status: "cancelled",
      reason: "queued_edge_batch_not_replayable",
    }));
  });

  it("keeps a queued edge workflow replayable instead of cancelling before fallback", async () => {
    const workflowHandle: DeviceExecutionHandle = {
      ...handle,
      rootKind: "edge_workflow",
      operationKind: "workflow",
      operationId: "workflow-waiting",
    };
    const observeTerminal = mockWouldWait(workflowHandle);
    await expect(sendEdgeWorkflowToDeviceEnforced(
      DEVICE_ID,
      workflowHandle.operationId,
      { id: "template" },
    )).resolves.toMatchObject({
      decision: "would_wait",
      handle: workflowHandle,
      sent: false,
      queued: true,
    });
    expect(observeTerminal).not.toHaveBeenCalled();
  });

  it("replays a queued edge workflow head exactly once through the PNQ handle path", async () => {
    const workflowHandle: DeviceExecutionHandle = {
      rootId: "22222222-2222-4222-8222-222222222224",
      deviceId: DEVICE_ID,
      rootKind: "edge_workflow",
      ownerGeneration: 2,
      operationKind: "workflow",
      operationId: "workflow-1",
    };
    const send = vi.fn();
    const internals = directWsServer as unknown as {
      connections: Map<string, { ws: { readyState: number; send: typeof send }; lastSeenAt: number }>;
      pendingWorkflows: Map<string, { handle: DeviceExecutionHandle; timer: ReturnType<typeof setTimeout> }>;
    };
    internals.connections.set(DEVICE_ID, { ws: { readyState: 1, send }, lastSeenAt: Date.now() });
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          root_id: workflowHandle.rootId,
          root_kind: "edge_workflow",
          root_external_id: workflowHandle.operationId,
          owner_generation: "1",
          operation_id: workflowHandle.operationId,
          metadata: { dispatchEnvelope: edgeWorkflowEnvelope() },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    vi.spyOn(dbClient, "getDb").mockReturnValue({
      query,
    } as never);
    vi.spyOn(deviceExecutionArbiter, "runObservedEgress").mockImplementation(async (input) => {
      const sent = await input.wireDispatch(workflowHandle);
      return { decision: "dispatched", root: null, handle: workflowHandle, sent };
    });

    await expect(dispatchQueuedJobsForDevice(DEVICE_ID, "test.edge_replay")).resolves.toEqual({
      attempted: 1,
      sent: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.promoteReplayedEdgeWorkflowToRunning).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.promoteReplayedEdgeWorkflowToRunning).toHaveBeenCalledWith({
      workflowId: workflowHandle.operationId,
      deviceId: DEVICE_ID,
      templateId: "template-1",
      variables: { generatedWorkflow: true },
      actor: "test.edge_replay",
    });
    const frame = JSON.parse(String(send.mock.calls[0]![0]));
    expect(frame).toMatchObject({
      type: "WORKFLOW_START",
      workflowId: workflowHandle.operationId,
      pnqHandle: {
        pnqRootId: workflowHandle.rootId,
        pnqRootKind: "edge_workflow",
        pnqOwnerGeneration: 2,
        pnqOperationKind: "workflow",
        pnqOperationId: workflowHandle.operationId,
      },
    });
    const pending = internals.pendingWorkflows.get(workflowHandle.operationId);
    if (pending) clearTimeout(pending.timer);
    internals.pendingWorkflows.delete(workflowHandle.operationId);
    internals.connections.delete(DEVICE_ID);
  });
});

describe("server-workflow BATCH transport to DirectWS serializer seam", () => {
  it("rejects a payload workflowId that is not the canonical server_workflow root", async () => {
    const runObservedEgress = vi.spyOn(deviceExecutionArbiter, "runObservedEgress");

    await expect(sendServerWorkflowBatchChildToDevice(DEVICE_ID, "canonical-workflow-root", {
      type: "BATCH_START",
      batchId: "server-workflow-batch-child",
      workflowId: "different-workflow",
      steps: [],
    }, 60_000)).rejects.toThrow(
      "Server workflow BATCH payload workflowId does not match canonical workflow root identity",
    );

    expect(runObservedEgress).not.toHaveBeenCalled();
  });

  it("serializes a typed server_workflow batch child with its exact PNQ handle", async () => {
    const handle: DeviceExecutionHandle = {
      rootId: "22222222-2222-4222-8222-222222222223",
      deviceId: DEVICE_ID,
      rootKind: "server_workflow",
      ownerGeneration: 4,
      operationKind: "batch",
      operationId: "server-workflow-batch-child",
    };
    const send = vi.fn();
    const internals = directWsServer as unknown as {
      connections: Map<string, { ws: { readyState: number; send: typeof send } }>;
    };
    internals.connections.set(DEVICE_ID, { ws: { readyState: 1, send } });
    vi.spyOn(deviceExecutionArbiter, "runObservedEgress").mockImplementation(async (input) => {
      await input.registerWaiter?.(handle);
      const sent = await input.wireDispatch(handle);
      return { decision: "dispatched", root: null, handle, sent };
    });

    const pending = sendServerWorkflowBatchChildToDevice(DEVICE_ID, "workflow-root", {
      type: "BATCH_START",
      batchId: handle.operationId,
      workflowId: "workflow-root",
      steps: [],
    }, 60_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const frame = JSON.parse(String(send.mock.calls[0]![0]));
    expect(frame).toMatchObject({
      type: "BATCH_START",
      batchId: handle.operationId,
      pnqHandle: {
        pnqRootId: handle.rootId,
        pnqDeviceId: DEVICE_ID,
        pnqRootKind: "server_workflow",
        pnqOwnerGeneration: 4,
        pnqOperationKind: "batch",
        pnqOperationId: handle.operationId,
      },
    });

    directWsServer.rejectBatchWaiterWithHandle(handle, "test complete");
    await expect(pending).rejects.toThrow("test complete");
    internals.connections.delete(DEVICE_ID);
  });
});
