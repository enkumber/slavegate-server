import { describe, expect, it, vi } from "vitest";
import { WorkflowSegmentComposer, composeGoalContract, computeCompositionStructureKey, computeSegmentFingerprint } from "./composer";
import { compileGeneratedWorkflowTemplate } from "../workflows/workflow-validator";
import { evaluatePostconditionContract } from "./postcondition";
import { resolveCompositionInputs } from "./input-resolver";
import type {
  WorkflowCompositionRecord,
  WorkflowSegmentVersionRecord,
} from "./types";

const inputSchema = {
  type: "object" as const,
  required: ["destination"],
  properties: {
    destination: { type: "string" as const, format: "uri" as const },
  },
  additionalProperties: false,
};

const outputSchema = {
  required: ["navigationResult", "observedDestination"],
  properties: {
    navigationResult: { type: "object" as const },
    observedDestination: { type: "string" as const },
  },
};

const postconditionContract = {
  version: "1" as const,
  all: [
    {
      left: { path: "outputs.navigationResult.launched" },
      operator: "equals" as const,
      operatorOpcode: 2,
      right: { value: true },
    },
    {
      left: { path: "outputs.observedDestination" },
      operator: "uri_equivalent" as const,
      operatorOpcode: 11,
      right: { path: "inputs.destination" },
    },
  ],
};

function fixture() {
  const segment: WorkflowSegmentVersionRecord = {
    segmentKey: "parameterized_navigation",
    version: "1.0.0",
    platform: "android",
    status: "promoted",
    inputSchema,
    outputSchema,
    postconditionContract,
    compatibility: {},
    fingerprint: "",
    template: {
      id: "parameterized_navigation",
      name: "Parameterized navigation",
      platform: "android",
      description: "Fixture",
      version: "1.0.0",
      safetyClass: "standard",
      outputSchema,
      postconditionContract,
      goalContract: {
        version: "1",
        stages: [{
          id: "navigate",
          required: true,
          allowedActions: ["classify_ui_tree", "intent_send", "screen_wake", "unlock"],
          allowedEffects: ["navigation", "observation"],
          produces: ["navigationResult", "observedDestination"],
        }],
        requiredOutputs: ["navigationResult", "observedDestination"],
        allowedEffects: ["navigation", "observation"],
      },
      allowedRecoveryRequests: [],
      requiredRecoveryCapabilities: ["state_reobserve"],
      recoveryPolicy: {
        autonomy: "bounded",
        aiRecoveryEnabled: false,
        maxAttemptsPerStep: 0,
        maxAttemptsPerWorkflow: 0,
        maxRecoveryActionsPerAttempt: 0,
        allowedRecoveryRequests: [],
        requireStateVerification: true,
        learnFromFailure: false,
      },
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 1,
      runtimeContract: "edge-workflow/v2",
      steps: [
        { type: "action", id: "wake", action: "screen_wake", effect: "navigation", goalStage: "navigate" },
        { type: "action", id: "unlock", action: "unlock", effect: "navigation", goalStage: "navigate" },
        {
          type: "action",
          id: "navigate",
          action: "intent_send",
          effect: "navigation",
          goalStage: "navigate",
          params: { uri: { $bind: "inputs.destination" } },
          saveOutputAs: "navigationResult",
        },
        {
          type: "action",
          id: "observe",
          action: "classify_ui_tree",
          effect: "observation",
          goalStage: "navigate",
          params: {
            outputs: {
              observedDestination: { regex: "https?://[^\\s\\\"]+", group: 0, default: "" },
            },
          },
        },
      ],
    },
  };
  segment.fingerprint = computeSegmentFingerprint(segment);
  const composition: WorkflowCompositionRecord = {
    compositionName: "navigate_destination",
    version: "1.0.0",
    compositionKey: "",
    capabilityKey: "navigate_destination",
    platform: "android",
    status: "promoted",
    inputSchema,
    outputSchema,
    postconditionContract,
    executionPolicy: {
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 1,
      runtimeContract: "edge-workflow/v2",
    },
    compatibility: {},
    inputResolver: {
      version: "1",
      fields: {
        destination: {
          sources: [{ kind: "regex", pattern: "(?:deschide|open)\\s+([^\\s]+)", group: 1, flags: "i" }],
          transforms: [
            { kind: "trim" },
            { kind: "prefix_unless", pattern: "^https?://", prefix: "https://" },
          ],
        },
      },
    },
    nodes: [{
      nodeKey: "navigate",
      ordinal: 0,
      segmentKey: segment.segmentKey,
      segmentVersion: segment.version,
      inputBindings: { destination: "destination" },
      outputBindings: {
        navigationResult: "navigationResult",
        observedDestination: "observedDestination",
      },
      dependsOn: [],
    }],
  };
  const segmentMap = new Map([[`${segment.segmentKey}@${segment.version}`, segment]]);
  composition.compositionKey = computeCompositionStructureKey(composition, segmentMap);
  return { segment, composition, segmentMap };
}

describe("workflow segment architecture", () => {
  it("reuses one parameterized segment/composition while execution identity changes with input", async () => {
    const { composition, segmentMap } = fixture();
    const saveExecutionBinding = vi.fn();
    const composer = new WorkflowSegmentComposer({
      promotedComposition: vi.fn().mockResolvedValue(composition),
      segmentVersions: vi.fn().mockResolvedValue(segmentMap),
      saveExecutionBinding,
    } as never);

    const first = await composer.compose({
      capabilityKey: composition.capabilityKey,
      platform: "android",
      intent: "deschide google.com",
      requestKey: "1".repeat(24),
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: null,
    });
    const second = await composer.compose({
      capabilityKey: composition.capabilityKey,
      platform: "android",
      intent: "deschide ciprianneculai.com",
      requestKey: "2".repeat(24),
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: null,
    });

    expect(first?.segmentKeys).toEqual(["parameterized_navigation"]);
    expect(second?.segmentKeys).toEqual(first?.segmentKeys);
    expect(second?.compositionKey).toBe(first?.compositionKey);
    expect(second?.executionKey).not.toBe(first?.executionKey);
    expect(second?.runtimeInputs).toEqual({ destination: "https://ciprianneculai.com" });
    expect(compileGeneratedWorkflowTemplate(second!.template).cacheKey)
      .toBe(compileGeneratedWorkflowTemplate(first!.template).cacheKey);
    expect(saveExecutionBinding).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a required runtime input cannot be resolved", () => {
    const { composition } = fixture();
    expect(() => resolveCompositionInputs("no matching value", composition.inputResolver, composition.inputSchema))
      .toThrow(/required composition input/);
  });

  it("composes an explicit candidate for canary without exposing secret runtime inputs", async () => {
    const { composition, segment, segmentMap } = fixture();
    composition.status = "candidate";
    composition.inputSchema.properties.destination.secret = true;
    segment.status = "candidate";
    segment.fingerprint = computeSegmentFingerprint(segment);
    composition.compositionKey = computeCompositionStructureKey(composition, segmentMap);
    const compositionVersion = vi.fn().mockResolvedValue(composition);
    const composer = new WorkflowSegmentComposer({
      promotedComposition: vi.fn(),
      compositionVersion,
      segmentVersions: vi.fn().mockResolvedValue(segmentMap),
      saveExecutionBinding: vi.fn(),
    } as never);

    const candidate = await composer.composeCandidate({
      compositionName: composition.compositionName,
      compositionVersion: composition.version,
      platform: "android",
      intent: "open https://example.test",
      requestKey: "3".repeat(24),
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: null,
    });

    expect(candidate?.runtimeInputs).toEqual({ destination: "https://example.test" });
    expect(compositionVersion).toHaveBeenCalledWith(
      composition.compositionName,
      composition.version,
      { dispatchable: true },
    );
    expect(candidate?.publicRuntimeInputs).toEqual({ destination: "[secret]" });
    expect(candidate?.template.defaultVerificationStrategy).toBe(
      composition.executionPolicy.defaultVerificationStrategy,
    );
    expect(candidate?.template.safetyClass).toBe(segment.template.safetyClass);
    expect(candidate?.template.goalContract).toEqual(segment.template.goalContract);
    expect(candidate?.template.allowedRecoveryRequests).toEqual(
      segment.template.allowedRecoveryRequests,
    );
    expect(candidate?.template.requiredRecoveryCapabilities).toEqual(
      segment.template.requiredRecoveryCapabilities,
    );
    expect(candidate?.template.recoveryPolicy).toEqual(segment.template.recoveryPolicy);
    expect(candidate?.template.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "navigate__navigate", saveOutputAs: "navigationResult" }),
    ]));
  });

  it("fails closed instead of inventing a safety class for a composition", async () => {
    const { composition, segment, segmentMap } = fixture();
    delete segment.template.safetyClass;
    segment.fingerprint = computeSegmentFingerprint(segment);
    composition.compositionKey = computeCompositionStructureKey(composition, segmentMap);
    const composer = new WorkflowSegmentComposer({
      promotedComposition: vi.fn().mockResolvedValue(composition),
      segmentVersions: vi.fn().mockResolvedValue(segmentMap),
      saveExecutionBinding: vi.fn(),
    } as never);

    await expect(composer.compose({
      capabilityKey: composition.capabilityKey,
      platform: "android",
      intent: "open https://example.test",
      requestKey: "4".repeat(24),
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: null,
    })).rejects.toMatchObject({ code: "WORKFLOW_COMPOSITION_POLICY_CONFLICT" });
  });

  it("derives a legacy goal contract from structural step policy when promoted segments omit one", () => {
    const { composition, segment } = fixture();
    delete segment.template.goalContract;
    segment.template.steps = [{
      id: "observe",
      type: "action",
      action: "ui_tree_dump",
      observationOnly: true,
      effect: "observation",
      saveOutputAs: "tree",
    }];

    const contract = composeGoalContract(composition, new Map([
      [`${segment.segmentKey}@${segment.version}`, segment],
    ]));

    expect(contract).toEqual({
      version: "1",
      stages: [{
        id: "navigate",
        required: true,
        allowedActions: ["ui_tree_dump"],
        allowedEffects: ["observation"],
        produces: ["navigationResult", "observedDestination"],
      }],
      requiredOutputs: ["navigationResult", "observedDestination"],
      allowedEffects: ["observation"],
    });
  });

  it("fails closed when a mixed legacy goal contract cannot be derived", () => {
    const { composition, segment } = fixture();
    const declared = { ...segment };
    const legacy = {
      ...segment,
      segmentKey: "legacy_missing_contract",
      template: {
        ...segment.template,
        goalContract: undefined,
        steps: [{ id: "opaque", type: "checkpoint", reason: "legacy" }],
      },
    } as WorkflowSegmentVersionRecord;
    composition.nodes = [
      composition.nodes[0],
      {
        nodeKey: "legacy",
        ordinal: 1,
        segmentKey: legacy.segmentKey,
        segmentVersion: legacy.version,
        inputBindings: {},
        outputBindings: {},
        dependsOn: ["navigate"],
      },
    ];

    expect(() => composeGoalContract(composition, new Map([
      [`${declared.segmentKey}@${declared.version}`, declared],
      [`${legacy.segmentKey}@${legacy.version}`, legacy],
    ]))).toThrow(/composition segments do not all declare goalContract/);
  });

  it("requires outputs to be related to the concrete runtime input", () => {
    expect(evaluatePostconditionContract(postconditionContract, {
      inputs: { destination: "https://ciprianneculai.com" },
      outputs: {
        navigationResult: { launched: true },
        observedDestination: "https://google.com",
      },
    }).ok).toBe(false);
    expect(evaluatePostconditionContract(postconditionContract, {
      inputs: { destination: "https://ciprianneculai.com" },
      outputs: {
        navigationResult: { launched: true },
        observedDestination: "https://ciprianneculai.com/",
      },
    }).ok).toBe(true);
  });
});
