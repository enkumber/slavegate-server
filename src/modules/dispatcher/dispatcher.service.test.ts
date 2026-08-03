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

vi.mock("../lifecycle/lifecycle.service", () => ({
  getResourceLifecycleExecutionStatusContract: vi.fn().mockResolvedValue({
    initial: "db_initial",
    active: "db_active",
    succeeded: "db_succeeded",
    failed: "db_failed",
    cancelled: "db_cancelled",
  }),
}));

import {
  applyParameterTransforms,
  dispatcherService,
  hydrateWorkflowNativePolicies,
  listJobActionPolicyDefinitions,
  shouldBlockRootForTimedOutJob,
  workflowChildTimeoutDisposition,
} from "./dispatcher.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes("jobActionPolicy")) {
      return {
        rows: [{
          policy: {
            actionKey: "fixture",
            allowed: true,
            requiresRoot: false,
            nativeOpcode: 0,
            verificationOpcode: 0,
            executionPolicy: {
              verificationStrategy: "local_only",
              l1TimeoutMs: 1,
              l2SettleMs: 1,
            },
          },
        }],
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

describe("PostgreSQL job action catalog", () => {
  it("returns dashboard definitions exclusively from active database policies", async () => {
    mocks.dbQuery.mockResolvedValueOnce({
      rows: [{
        policy: {
          actionKey: "database_action",
          allowed: true,
          requiresRoot: false,
          nativeOpcode: 7,
          verificationOpcode: 2,
          observationOnly: true,
          label: "Database action",
          defaultParams: { sample: true },
        },
      }],
    });

    await expect(listJobActionPolicyDefinitions()).resolves.toEqual([{
      actionKey: "database_action",
      allowed: true,
      requiresRoot: false,
      nativeOpcode: 7,
      verificationOpcode: 2,
      observationOnly: true,
      timeoutPerUnitMs: null,
      timeoutBaseMs: 0,
      timeoutInputPath: null,
      executionPolicy: {},
      parameterTransforms: [],
      label: "Database action",
      defaultParams: { sample: true },
    }]);
  });

  it("drops malformed policies instead of inventing release defaults", async () => {
    mocks.dbQuery.mockResolvedValueOnce({
      rows: [{ policy: { actionKey: "incomplete" } }],
    });

    await expect(listJobActionPolicyDefinitions()).resolves.toEqual([]);
  });

  it("translates symbolic parameters exclusively through PostgreSQL mappings", () => {
    expect(applyParameterTransforms(
      { key: "database_key", flags: ["database_flag_a", "database_flag_b"] },
      [
        {
          transformOpcode: 0,
          sourcePath: "key",
          values: {
            database_key: { targetPath: "keyCode", value: 42 },
          },
        },
        {
          transformOpcode: 1,
          sourcePath: "flags",
          targetPath: "flags",
          values: {
            database_flag_a: 8,
            database_flag_b: 16,
          },
        },
      ],
    )).toEqual({
      key: "database_key",
      keyCode: 42,
      flags: [8, 16],
    });
  });

  it("hydrates the complete edge interpreter ABI only from PostgreSQL policies", async () => {
    mocks.dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            policy: {
              actionKey: "database_action",
              allowed: true,
              requiresRoot: false,
              nativeOpcode: 100,
              verificationOpcode: 0,
              executionPolicy: {
                verificationStrategy: "database_local",
                l1TimeoutMs: 11,
                l2SettleMs: 12,
              },
            },
          },
          {
            policy: {
              actionKey: "database_observer",
              allowed: true,
              requiresRoot: false,
              nativeOpcode: 12,
              verificationOpcode: 0,
              observationOnly: true,
              executionPolicy: {
                verificationStrategy: "database_observe",
                l1TimeoutMs: 21,
                l2SettleMs: 22,
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{
          policy: {
            distributionOpcodes: { database_distribution: 2 },
            conditionOpcodes: { database_condition: 4 },
            predicateOpcodes: { database_predicate: 6 },
            failureOpcodes: { database_failure: 3, database_default: 0 },
            defaultFailureMode: "database_default",
            verificationOpcodes: { database_verification: 2 },
            defaultVerificationMode: "database_verification",
            runtimeDefaults: {
              actionRetries: 0,
              actionRetryDelayMs: 0,
              actionDelayAfterMs: 0,
              actionTimeoutMs: 1000,
              pollIntervalMs: 100,
              pollTimeoutMs: 1000,
              conditionProbability: 0.5,
              regexGroup: 0,
              recoveryAutonomy: "disabled",
              recoveryAiEnabled: false,
              recoveryMaxAttemptsPerStep: 0,
              recoveryMaxAttemptsPerWorkflow: 0,
              recoveryMaxActionsPerAttempt: 0,
              recoveryAllowedRequests: [],
              recoveryRequireStateVerification: false,
              recoveryLearnFromFailure: false,
              recoveryPlannerInstruction: "",
              recoveryExecuteDecisionKey: "",
              recoveryRetryDecisionKey: "",
              recoveryAbortDecisionKey: "",
              recoveryProbeActionKey: "",
              recoveryProbeTimeoutMs: 0,
              recoveryPlannerSystem: "",
              recoveryPlannerMaxTokens: 0,
              recoveryPlannerTimeoutMs: 0,
            },
            enginePolicy: {
              maxNestedDepth: 8,
              minActionTimeoutMs: 100,
              captureTimeoutMs: 1000,
              defaultSubstepTimeoutMs: 1000,
              substepTimeoutPaddingMs: 100,
            },
          },
        }],
      });

    await expect(hydrateWorkflowNativePolicies({
      steps: [{
        type: "action",
        action: "database_action",
        failureMode: "database_failure",
        duration: { distribution: "database_distribution" },
        branch: { check: "database_condition" },
        selectorPrimitive: {
          primitive: true,
          action: "database_observer",
          operator: "database_predicate",
          regex: "database-(.+)",
        },
      }],
    })).resolves.toEqual(expect.objectContaining({
      executionStates: {
        initial: "db_initial",
        active: "db_active",
        succeeded: "db_succeeded",
        failed: "db_failed",
        cancelled: "db_cancelled",
      },
      enginePolicy: {
        maxNestedDepth: 8,
        minActionTimeoutMs: 100,
        captureTimeoutMs: 1000,
        defaultSubstepTimeoutMs: 1000,
        substepTimeoutPaddingMs: 100,
      },
      steps: [expect.objectContaining({
        nativeOpcode: 100,
        verificationOpcode: 2,
        observationOnly: false,
        verificationStrategy: "database_local",
        l1TimeoutMs: 11,
        l2SettleMs: 12,
        failureOpcode: 3,
        retries: 0,
        retryDelayMs: 0,
        delayAfterMs: 0,
        timeoutMs: 1000,
        duration: expect.objectContaining({ distributionOpcode: 2 }),
        branch: expect.objectContaining({ checkOpcode: 4 }),
        selectorPrimitive: expect.objectContaining({
          nativeOpcode: 12,
          verificationOpcode: 2,
          observationOnly: true,
          verificationStrategy: "database_observe",
          l1TimeoutMs: 21,
          l2SettleMs: 22,
          operatorOpcode: 6,
          group: 0,
        }),
      })],
    }));
  });

  it("materializes primitive countMatches workflows with edge structural discriminators", async () => {
    mocks.dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            policy: {
              actionKey: "classify_ui_tree",
              allowed: true,
              requiresRoot: false,
              nativeOpcode: 101,
              verificationOpcode: 0,
              executionPolicy: {
                verificationStrategy: "database_local",
                l1TimeoutMs: 11,
                l2SettleMs: 12,
              },
            },
          },
          {
            policy: {
              actionKey: "ui_tree_dump",
              allowed: true,
              requiresRoot: false,
              nativeOpcode: 12,
              verificationOpcode: 0,
              observationOnly: true,
              executionPolicy: {
                verificationStrategy: "database_observe",
                l1TimeoutMs: 21,
                l2SettleMs: 22,
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{
          policy: {
            distributionOpcodes: { database_distribution: 2 },
            conditionOpcodes: { database_condition: 4 },
            predicateOpcodes: { database_predicate: 6 },
            failureOpcodes: { database_default: 0 },
            defaultFailureMode: "database_default",
            verificationOpcodes: { database_verification: 2 },
            defaultVerificationMode: "database_verification",
            runtimeDefaults: {
              actionRetries: 0,
              actionRetryDelayMs: 0,
              actionDelayAfterMs: 0,
              actionTimeoutMs: 1000,
              pollIntervalMs: 100,
              pollTimeoutMs: 1000,
              conditionProbability: 0.5,
              regexGroup: 0,
              recoveryAutonomy: "disabled",
              recoveryAiEnabled: false,
              recoveryMaxAttemptsPerStep: 0,
              recoveryMaxAttemptsPerWorkflow: 0,
              recoveryMaxActionsPerAttempt: 0,
              recoveryAllowedRequests: [],
              recoveryRequireStateVerification: false,
              recoveryLearnFromFailure: false,
              recoveryPlannerInstruction: "",
              recoveryExecuteDecisionKey: "",
              recoveryRetryDecisionKey: "",
              recoveryAbortDecisionKey: "",
              recoveryProbeActionKey: "",
              recoveryProbeTimeoutMs: 0,
              recoveryPlannerSystem: "",
              recoveryMaxTokens: 0,
              recoveryPlannerMaxTokens: 0,
              recoveryPlannerTimeoutMs: 0,
            },
            enginePolicy: {
              maxNestedDepth: 8,
              minActionTimeoutMs: 100,
              captureTimeoutMs: 1000,
              defaultSubstepTimeoutMs: 1000,
              substepTimeoutPaddingMs: 100,
            },
          },
        }],
      });

    await expect(hydrateWorkflowNativePolicies({
      steps: [
        {
          type: "action",
          id: "count_visible_descriptions",
          action: "classify_ui_tree",
          params: {
            outputs: {
              visibleCheckableFocusableContentDescriptionCount: {
                countMatches: {
                  regex: "contentDescription=.+",
                  flags: "i",
                },
              },
            },
            observationPrimitive: {
              action: "ui_tree_dump",
              params: {},
              timeoutMs: 1000,
            },
          },
        },
        {
          type: "checkpoint",
          id: "count_matches_observed",
          reason: "countMatches materialized",
        },
      ],
    })).resolves.toEqual(expect.objectContaining({
      steps: [
        expect.objectContaining({
          action: "classify_ui_tree",
          nativeOpcode: 101,
          params: expect.objectContaining({
            outputs: {
              visibleCheckableFocusableContentDescriptionCount: expect.objectContaining({
                countMatches: expect.objectContaining({
                  regex: "contentDescription=.+",
                  flags: "i",
                }),
              }),
            },
            observationPrimitive: expect.objectContaining({
              action: "ui_tree_dump",
              primitive: true,
              nativeOpcode: 12,
              observationOnly: true,
              verificationOpcode: 2,
              verificationStrategy: "database_observe",
              l1TimeoutMs: 21,
              l2SettleMs: 22,
            }),
          }),
        }),
        expect.objectContaining({
          type: "checkpoint",
          id: "count_matches_observed",
          phase: "countMatches materialized",
        }),
      ],
    }));
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
