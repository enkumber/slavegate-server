import { describe, expect, it } from "vitest";
import { mergeWorkflowStatusVariables, resolveDirectWsResultHandle } from "./direct-ws.server";
import type { DeviceExecutionHandle } from "../modules/device-execution";

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
