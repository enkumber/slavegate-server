import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { deviceExecutionArbiter } from "../device-execution";
import { workflowService, type WorkflowRecord } from "./workflow.service";
import { runWorkflow } from "./workflow.executor";
import type { WorkflowTemplate } from "./types";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "retry-template";

function workflow(status: WorkflowRecord["status"]): WorkflowRecord {
  return {
    id: WORKFLOW_ID,
    templateId: TEMPLATE_ID,
    accountId: null,
    deviceId: DEVICE_ID,
    status,
    currentStep: 0,
    totalSteps: 1,
    checkpoint: {
      stepIndex: 0,
      loopStack: [],
      variables: {},
      hbeParams: { persisted: true },
      checkpointAt: "2026-07-16T00:00:00.000Z",
    },
    executionStats: null,
    hbeParams: { persisted: true },
    startedAt: "2026-07-16T00:00:00.000Z",
    completedAt: null,
    error: null,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

const template: WorkflowTemplate = {
  id: TEMPLATE_ID,
  name: "Retry checkpoint template",
  platform: "android",
  description: "Exercises durable retry resume without device egress",
  version: "1.0.0",
  steps: [{ type: "checkpoint", id: "retry-resumed" }],
  defaultVerificationStrategy: "local_only",
  dataRetentionDays: 1,
};

function job(): Job {
  return {
    attemptsMade: 1,
    token: "retry-token",
    extendLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow BullMQ retry semantics", () => {
  it("resumes a persisted running workflow and terminally releases its PNQ root", async () => {
    vi.spyOn(workflowService, "get").mockResolvedValue(workflow("running"));
    vi.spyOn(workflowService, "getTemplate").mockResolvedValue(template);
    const markRunning = vi.spyOn(workflowService, "markRunning");
    vi.spyOn(workflowService, "saveCheckpoint").mockResolvedValue(true);
    const markCompleted = vi.spyOn(workflowService, "markCompleted").mockResolvedValue(undefined);
    const finishRoot = vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot")
      .mockResolvedValue({ decision: "terminal", root: null });

    await expect(runWorkflow(WORKFLOW_ID, job())).resolves.toBeUndefined();

    expect(markRunning).not.toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(finishRoot).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      workflowId: WORKFLOW_ID,
      status: "completed",
      actor: "workflow_executor",
    });
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "reconciles a persisted %s row instead of silently leaving PNQ ownership active",
    async (status) => {
      vi.spyOn(workflowService, "get").mockResolvedValue(workflow(status));
      const markRunning = vi.spyOn(workflowService, "markRunning");
      const finishRoot = vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot")
        .mockResolvedValue({ decision: "terminal", root: null });

      await expect(runWorkflow(WORKFLOW_ID, job())).resolves.toBeUndefined();

      expect(markRunning).not.toHaveBeenCalled();
      expect(finishRoot).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: DEVICE_ID,
        workflowId: WORKFLOW_ID,
        status,
        actor: "workflow_executor.retry_reconcile",
      }));
    },
  );

  it("reconciles cancellation that wins between the initial read and the running transition", async () => {
    vi.spyOn(workflowService, "get")
      .mockResolvedValueOnce(workflow("queued"))
      .mockResolvedValueOnce(workflow("cancelled"));
    vi.spyOn(workflowService, "getTemplate").mockResolvedValue(template);
    vi.spyOn(workflowService, "markRunning").mockResolvedValue(false);
    const finishRoot = vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot")
      .mockResolvedValue({ decision: "terminal", root: null });

    await expect(runWorkflow(WORKFLOW_ID, job())).resolves.toBeUndefined();

    expect(finishRoot).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: DEVICE_ID,
      workflowId: WORKFLOW_ID,
      status: "cancelled",
      actor: "workflow_executor.transition_reconcile",
    }));
  });

  it("throws on a rejected nonterminal claim so BullMQ cannot record a successful no-op", async () => {
    vi.spyOn(workflowService, "get")
      .mockResolvedValueOnce(workflow("queued"))
      .mockResolvedValueOnce(workflow("queued"));
    vi.spyOn(workflowService, "getTemplate").mockResolvedValue(template);
    vi.spyOn(workflowService, "markRunning").mockResolvedValue(false);
    const finishRoot = vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot");

    await expect(runWorkflow(WORKFLOW_ID, job())).rejects.toThrow(
      `Workflow ${WORKFLOW_ID} could not transition to running; persisted status=queued`,
    );
    expect(finishRoot).not.toHaveBeenCalled();
  });
});
