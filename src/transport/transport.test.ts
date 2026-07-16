import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isJobReplayEnvelope,
  sendBatchToDeviceEnforced,
  sendEdgeWorkflowToDeviceEnforced,
  sendServerWorkflowBatchChildToDevice,
  type DeviceExecutionJobReplayEnvelopeV1,
} from "./transport";
import { deviceExecutionArbiter, type DeviceExecutionHandle } from "../modules/device-execution";
import { directWsServer } from "../ws/direct-ws.server";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(indexSource).toContain("const queueSweepTimer = setInterval");
    expect(indexSource).toContain("queueSweepTimer.unref()");
    expect(indexSource).toContain("clearInterval(queueSweepTimer)");
    expect(directWsSource).toContain("await Promise.all(confirmations)");
    expect(directWsSource).toContain("pending work retained");
    expect(directWsSource).toContain("this.confirmAmbiguityBeforeCleanup");
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

  it("cancels and audits a queued edge workflow before server fallback", async () => {
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
    )).resolves.toBe(false);
    expect(observeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      handle: workflowHandle,
      status: "cancelled",
      reason: "queued_edge_workflow_not_replayable",
    }));
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
