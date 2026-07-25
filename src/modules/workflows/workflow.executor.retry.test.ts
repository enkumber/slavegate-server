import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { deviceExecutionArbiter } from "../device-execution";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { hbeService } from "../hbe/hbe.service";
import * as transport from "../../transport/transport";
import { workflowService, type WorkflowRecord } from "./workflow.service";
import {
  awaitGeneratedChildJobResult,
  generatedChildResultTimeoutMs,
  prepareGeneratedChildJobResult,
  resolveJobResult,
  runWorkflow,
  shouldContinueAfterMissingJobResult,
  shouldTerminallyFailWorkflowJob,
} from "./workflow.executor";
import type { WorkflowTemplate } from "./types";

vi.mock("../../transport/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../transport/transport")>();
  return {
    ...actual,
    isDeviceOnline: vi.fn(actual.isDeviceOnline),
    sendDeviceExecutionJobToDevice: vi.fn(actual.sendDeviceExecutionJobToDevice),
    sendLegacyGeneratedWorkflowJobToDevice: vi.fn(actual.sendLegacyGeneratedWorkflowJobToDevice),
  };
});

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) })),
}));

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "retry-template";

function workflow(status: WorkflowRecord["status"]): WorkflowRecord {
  const lifecycleInitial = status === "queued";
  const lifecycleTerminal = ["completed", "failed", "cancelled"].includes(status);
  const lifecycleRetryable = status === "failed";
  const lifecycleAdministrative = status === "cancelled";
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
    lifecycleInitial,
    lifecycleTerminal,
    lifecycleRetryable,
    lifecycleAdministrative,
    lifecycleDispatchable: false,
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
  it("aligns a dispatched child result deadline with its execution timeout", () => {
    expect(generatedChildResultTimeoutMs(30_000)).toBe(35_000);
    expect(generatedChildResultTimeoutMs(30_000, true)).toBe(300_000);
  });

  it("terminates immediately when the bounded recovery budget is exhausted", () => {
    expect(shouldTerminallyFailWorkflowJob(1, Object.assign(new Error("RECOVERY_BUDGET_EXCEEDED"), {
      code: "RECOVERY_BUDGET_EXCEEDED",
    }))).toBe(true);
    expect(shouldTerminallyFailWorkflowJob(2, new Error("transient"))).toBe(false);
    expect(shouldTerminallyFailWorkflowJob(3, new Error("transient"))).toBe(true);
  });

  it("never advances a workflow without a correlated JOB_RESULT", () => {
    const timeout = new Error("JOB_RESULT timeout after 30000ms (jobId=test)");

    expect(shouldContinueAfterMissingJobResult("screen_wake", timeout, true)).toBe(false);
    expect(shouldContinueAfterMissingJobResult("unlock", timeout, true)).toBe(false);
    expect(shouldContinueAfterMissingJobResult("intent_send", timeout, true)).toBe(false);
    expect(shouldContinueAfterMissingJobResult("ui_tree_dump", timeout, true)).toBe(false);
    expect(shouldContinueAfterMissingJobResult("intent_send", new Error("dispatch rejected"), true)).toBe(false);
    expect(shouldContinueAfterMissingJobResult("intent_send", timeout, false)).toBe(false);
  });

  it("fails closed at wake when the device omits JOB_RESULT", async () => {
    vi.useFakeTimers();
    try {
      const exactTemplate: WorkflowTemplate = {
        id: TEMPLATE_ID,
        name: "BustaBuster server-mode regression",
        platform: "android",
        description: "Exact live path with fire-and-forget effects and final UI evidence",
        version: "1.0.0",
        safetyClass: "read_only",
        recoveryPolicy: { autonomy: "bounded", maxAttemptsPerStep: 1, maxAttemptsPerWorkflow: 1 },
        steps: [
          { type: "action", id: "wake", action: "screen_wake", timeoutMs: 1, params: {} },
          { type: "action", id: "unlock", action: "unlock", timeoutMs: 1, params: {} },
          { type: "action", id: "open", action: "intent_send", timeoutMs: 1, params: { uri: "https://bustabit.com/bankroll" } },
          { type: "action", id: "tree", action: "ui_tree_dump", timeoutMs: 1, params: { outputVariable: "_finalUiTree" } },
        ],
        defaultVerificationStrategy: "local_only",
        dataRetentionDays: 1,
      };
      const running = { ...workflow("running"), totalSteps: 4 };
      const dispatched: string[] = [];
      let jobCounter = 0;

      vi.spyOn(workflowService, "get").mockResolvedValue(running);
      vi.spyOn(workflowService, "getTemplate").mockResolvedValue(exactTemplate);
      vi.spyOn(workflowService, "saveCheckpoint").mockResolvedValue(true);
      const completed = vi.spyOn(workflowService, "markCompleted").mockResolvedValue(undefined);
      vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot")
        .mockResolvedValue({ decision: "terminal", root: null });
      vi.mocked(transport.isDeviceOnline).mockReturnValue(true);
      vi.spyOn(hbeService, "getActionParams").mockReturnValue({
        action: { preActionDelayMs: 0, postActionDelayMs: 0, simulateError: false },
        verificationStrategy: "local_only",
        l1TimeoutMs: 1,
        l2SettleMs: 0,
      } as ReturnType<typeof hbeService.getActionParams>);
      vi.spyOn(dispatcherService, "dispatchLegacyGeneratedWorkflow").mockImplementation(async (input) => ({
        jobId: `job-${++jobCounter}-${input.type}`,
        timeoutMs: input.timeoutMs ?? 1,
      }));
      vi.mocked(transport.sendLegacyGeneratedWorkflowJobToDevice).mockImplementation(async (_deviceId, command) => {
        dispatched.push(command.type);
        if (command.type === "unlock") {
          setTimeout(() => resolveJobResult(command.jobId, {
            successful: true,
            output: { unlocked: true },
            durationMs: 1,
          }), 0);
        }
        if (command.type === "ui_tree_dump") {
          expect(resolveJobResult(command.jobId, {
            successful: true,
            output: { tree: [{ text: "Bankroll 638.824 BTC" }] },
            durationMs: 1,
          })).toBe(true);
        }
        return {
          decision: "dispatched",
          root: null,
          operation: undefined,
          handle: undefined,
          sent: true,
          queued: false,
          resultPromise: Promise.resolve({}),
        };
      });

      const pending = runWorkflow(WORKFLOW_ID, job());
      const failedAssertion = expect(pending).rejects.toThrow();
      await vi.runAllTimersAsync();
      await failedAssertion;

      expect(dispatched).toEqual(["screen_wake", "screen_wake"]);
      expect(completed).not.toHaveBeenCalled();
      expect(running.checkpoint.variables._finalUiTree).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits a PNQ-queued server child until queue replay returns JOB_RESULT", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const resultPromise = awaitGeneratedChildJobResult(
      WORKFLOW_ID,
      jobId,
      {
        decision: "would_wait",
        root: null,
        reason: "device_slot_already_active",
        sent: false,
        queued: true,
      },
      1_000,
    );

    expect(resolveJobResult(jobId, {
      successful: true,
      output: { unlocked: true },
      durationMs: 25,
    })).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      successful: true,
      output: { unlocked: true },
    });
  });

  it("keeps a prepared sent-path waiter armed to the explicit result timeout", async () => {
    vi.useFakeTimers();
    try {
      const jobId = "55555555-5555-4555-8555-555555555555";
      const resultTimeoutMs = 30_000;
      const prepared = prepareGeneratedChildJobResult(jobId, resultTimeoutMs);
      let settled = false;
      const resultPromise = awaitGeneratedChildJobResult(
        WORKFLOW_ID,
        jobId,
        {
          decision: "dispatched",
          root: null,
          operation: undefined,
          handle: undefined,
          sent: true,
          queued: false,
          resultPromise: Promise.resolve({}),
        },
        resultTimeoutMs,
        prepared,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(6_001);
      expect(settled).toBe(false);
      expect(resolveJobResult(jobId, {
        successful: true,
        output: { ok: true },
        durationMs: 7,
      })).toBe(true);
      await expect(resultPromise).resolves.toMatchObject({
        successful: true,
        output: { ok: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects a server child that PNQ did not send or queue", () => {
    expect(() => awaitGeneratedChildJobResult(
      WORKFLOW_ID,
      "44444444-4444-4444-8444-444444444444",
      {
        decision: "rejected",
        root: null,
        reason: "existing_root_not_found",
        sent: false,
        queued: false,
      },
      1_000,
    )).toThrow("existing_root_not_found");
  });

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
      successful: true,
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
        successful: status === "completed",
        actor: "workflow_executor.retry_reconcile",
      }));
    },
  );

  it("reconciles cancellation that wins between the initial read and the running transition", async () => {
    vi.spyOn(workflowService, "get")
      .mockResolvedValueOnce(workflow("queued"))
      .mockResolvedValueOnce(workflow("cancelled"));
    vi.spyOn(workflowService, "getTemplate").mockResolvedValue(template);
    vi.spyOn(deviceExecutionArbiter, "observeAdmission")
      .mockResolvedValue({ decision: "admitted", root: null });
    vi.spyOn(workflowService, "markRunning").mockResolvedValue(false);
    const finishRoot = vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot")
      .mockResolvedValue({ decision: "terminal", root: null });

    await expect(runWorkflow(WORKFLOW_ID, job())).resolves.toBeUndefined();

    expect(finishRoot).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: DEVICE_ID,
      workflowId: WORKFLOW_ID,
      successful: false,
      actor: "workflow_executor.transition_reconcile",
    }));
  });

  it("throws on a rejected nonterminal claim so BullMQ cannot record a successful no-op", async () => {
    vi.spyOn(workflowService, "get")
      .mockResolvedValueOnce(workflow("queued"))
      .mockResolvedValueOnce(workflow("queued"));
    vi.spyOn(workflowService, "getTemplate").mockResolvedValue(template);
    vi.spyOn(deviceExecutionArbiter, "observeAdmission")
      .mockResolvedValue({ decision: "admitted", root: null });
    vi.spyOn(workflowService, "markRunning").mockResolvedValue(false);
    const finishRoot = vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot");

    await expect(runWorkflow(WORKFLOW_ID, job())).rejects.toThrow(
      `Workflow ${WORKFLOW_ID} could not transition to running; persisted status=queued`,
    );
    expect(finishRoot).not.toHaveBeenCalled();
  });

  it("keeps a PNQ-waiting server workflow queued until its child wins the device slot", async () => {
    vi.spyOn(workflowService, "get").mockResolvedValue(workflow("queued"));
    vi.spyOn(workflowService, "getTemplate").mockResolvedValue(template);
    vi.spyOn(deviceExecutionArbiter, "observeAdmission")
      .mockResolvedValue({ decision: "would_wait", root: null, activeRootId: "active-root" });
    const markRunning = vi.spyOn(workflowService, "markRunning");
    vi.spyOn(workflowService, "saveCheckpoint").mockResolvedValue(true);
    vi.spyOn(workflowService, "markCompleted").mockResolvedValue(undefined);
    vi.spyOn(deviceExecutionArbiter, "finishServerWorkflowRoot")
      .mockResolvedValue({ decision: "terminal", root: null });

    await expect(runWorkflow(WORKFLOW_ID, job())).resolves.toBeUndefined();

    expect(markRunning).not.toHaveBeenCalled();
  });
});
