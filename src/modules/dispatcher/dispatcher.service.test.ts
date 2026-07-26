import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  dbQuery: vi.fn(),
  observeAdmission: vi.fn(),
  enqueueShadowJob: vi.fn(),
  runPnqSideEffect: vi.fn((_label: string, run: () => unknown) => run()),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mocks.queueAdd,
    close: vi.fn(),
  })),
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query: mocks.dbQuery })),
}));

vi.mock("../../api/routes", () => ({
  isKillSwitchActive: vi.fn().mockResolvedValue(false),
}));

vi.mock("../device-execution", () => ({
  deviceExecutionArbiter: {
    observeAdmission: mocks.observeAdmission,
    markAmbiguous: vi.fn(),
    observeTerminal: vi.fn(),
  },
}));

vi.mock("../device-execution/device-execution-authority", () => ({
  isDeviceExecutionEnforced: vi.fn(() => false),
}));

vi.mock("../device-execution/pnq-v2-runtime-config", () => ({
  isPnqV2ShadowRuntimeEnabled: vi.fn(() => true),
}));

vi.mock("../device-execution/pnq-v2-runtime.service", () => ({
  pnqV2RuntimeService: {
    enqueueShadowJob: mocks.enqueueShadowJob,
  },
  runPnqV2ShadowSideEffect: mocks.runPnqSideEffect,
}));

vi.mock("../../redis/client", () => ({
  getRedisConnectionOptions: vi.fn(() => ({})),
}));

import { dispatcherService, shouldBlockRootForTimedOutJob, workflowChildTimeoutDisposition } from "./dispatcher.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes("jobActionPolicy")) {
      return {
        rows: [{ policy: { actionKey: "fixture", allowed: true, requiresRoot: false } }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  mocks.enqueueShadowJob.mockResolvedValue(undefined);
  mocks.queueAdd.mockResolvedValue(undefined);
});

describe("server-workflow child timeout clock", () => {
  it("does not consume execution timeout while PNQ still owns the child as queued", () => {
    expect(workflowChildTimeoutDisposition({
      root_initial: true,
      operation_initial: true,
      operation_in_flight: false,
    }, false)).toEqual({ deferred: true, armExecution: false });
  });

  it("arms a fresh execution timeout once PNQ advances the child to the wire", () => {
    expect(workflowChildTimeoutDisposition({
      root_initial: false,
      operation_initial: false,
      operation_in_flight: true,
    }, false)).toEqual({ deferred: false, armExecution: true });
    expect(workflowChildTimeoutDisposition({
      root_initial: false,
      operation_initial: false,
      operation_in_flight: true,
    }, true)).toEqual({ deferred: false, armExecution: false });
  });

  it("fails closed when ownership is absent or no longer queue-waiting", () => {
    expect(workflowChildTimeoutDisposition(undefined, false)).toEqual({ deferred: false, armExecution: false });
    expect(workflowChildTimeoutDisposition({
      root_initial: false,
      operation_initial: false,
      operation_in_flight: false,
    }, false)).toEqual({ deferred: false, armExecution: false });
  });

  it("leaves a timed-out child under workflow ownership instead of blocking the canonical root", () => {
    expect(shouldBlockRootForTimedOutJob("workflow-1")).toBe(false);
    expect(shouldBlockRootForTimedOutJob()).toBe(true);
  });
});

describe("PNQ v2 shadow dispatch side effect", () => {
  it("ignores a forged public executionLane and still admits plus shadow-enqueues the job", async () => {
    await dispatcherService.dispatch({
      deviceId: "device-1",
      type: "screenshot",
      params: {},
      timeoutMs: 1_000,
      executionLane: "legacy_generated_workflow",
    } as Parameters<typeof dispatcherService.dispatch>[0] & { executionLane: "legacy_generated_workflow" });

    expect(mocks.observeAdmission).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "device-1",
      rootKind: "job",
      actor: "dispatcher",
    }));
    expect(mocks.enqueueShadowJob).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "device-1",
      payload: expect.objectContaining({ type: "screenshot" }),
    }));
  });

  it("keeps the legacy generated workflow lane behind an internal dispatcher entrypoint", async () => {
    await dispatcherService.dispatchLegacyGeneratedWorkflow({
      deviceId: "device-1",
      type: "ui_tree_dump",
      params: {},
      timeoutMs: 1_000,
      workflowId: "workflow-1",
    });

    expect(mocks.observeAdmission).not.toHaveBeenCalled();
    expect(mocks.enqueueShadowJob).not.toHaveBeenCalled();
  });

  it("keeps Queue v2 enqueue behind the shadow runtime guard", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/modules/dispatcher/dispatcher.service.ts"), "utf8");
    expect(source).toContain("if (isPnqV2ShadowRuntimeEnabled())");
    expect(source).toContain('runPnqV2ShadowSideEffect("enqueue"');
    expect(source).toContain("pnqV2RuntimeService.enqueueShadowJob");
    expect(source).not.toContain("await pnqV2RuntimeService.enqueueShadowJob");
    expect(source.indexOf("const shadowEnqueueObservation = pnqV2RuntimeService.enqueueShadowJob"))
      .toBeLessThan(source.indexOf('runPnqV2ShadowSideEffect("enqueue"'));
    expect(source).toContain('runPnqV2ShadowSideEffect("enqueue", () => shadowEnqueueObservation)');
  });

  it("keeps terminal telemetry detached in observe-only and awaited in enforced mode", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/modules/dispatcher/dispatcher.service.ts"), "utf8");
    expect(source).toContain("if (isDeviceExecutionEnforced()) {");
    expect(source).toContain("await deviceExecutionArbiter.observeTerminal(terminalObservation)");
    expect(source).toContain("void deviceExecutionArbiter.observeTerminal(terminalObservation)");
  });
});
