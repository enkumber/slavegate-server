import { describe, expect, it } from "vitest";
import { mergeWorkflowStatusVariables, shouldAcceptWorkflowStatus } from "./direct-ws.server";

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

describe("shouldAcceptWorkflowStatus", () => {
  it("deduplicates exact replay receipts", () => {
    expect(shouldAcceptWorkflowStatus(
      { status: "running", currentStep: 2, lastStatusId: "receipt-2" },
      { status: "running", step: 2, statusId: "receipt-2" },
    )).toBe(false);
  });

  it("rejects stale progress and progress after terminal state", () => {
    expect(shouldAcceptWorkflowStatus(
      { status: "running", currentStep: 4 }, { status: "running", step: 3, statusId: "old" },
    )).toBe(false);
    expect(shouldAcceptWorkflowStatus(
      { status: "completed", currentStep: 6 }, { status: "running", step: 5, statusId: "late" },
    )).toBe(false);
  });

  it("accepts forward progress and terminal results", () => {
    expect(shouldAcceptWorkflowStatus(
      { status: "running", currentStep: 3 }, { status: "running", step: 4, statusId: "next" },
    )).toBe(true);
    expect(shouldAcceptWorkflowStatus(
      { status: "running", currentStep: 5 }, { status: "completed", step: 6, statusId: "done" },
    )).toBe(true);
  });
});
