import type { WorkflowStep, WorkflowTemplate } from "../workflows/types";
import { validateGeneratedWorkflowTemplate } from "../workflows/workflow-validator";
import { computeExecutionKey, fullFingerprint, shortKey } from "./key-utils";
import { resolveCompositionInputs } from "./input-resolver";
import { workflowSegmentRepository, WorkflowSegmentRepository } from "./repository";
import type {
  ComposedWorkflow,
  WorkflowCompositionNodeRecord,
  WorkflowCompositionRecord,
  WorkflowSegmentVersionRecord,
} from "./types";

function rewriteBindings(value: unknown, bindings: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteBindings(item, bindings));
  if (typeof value === "string") {
    return value.replace(/\{\{inputs\.([a-zA-Z0-9_.-]+)\}\}/g, (match, key: string) => {
      const target = bindings[key];
      return target ? `{{${target}}}` : match;
    });
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.$bind === "string") {
      const match = /^inputs\.([a-zA-Z0-9_.-]+)$/.exec(record.$bind);
      const target = match ? bindings[match[1]] : null;
      return target ? { $bind: target } : value;
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, rewriteBindings(item, bindings)]));
  }
  return value;
}

function prefixStep(
  step: WorkflowStep,
  node: WorkflowCompositionNodeRecord,
  inputBindings: Record<string, string>,
): WorkflowStep {
  const rewritten = rewriteBindings(step, inputBindings) as WorkflowStep;
  const prefix = `${node.nodeKey}__`;
  const rewrittenParams = rewritten.type === "action"
    && rewritten.params
    && typeof rewritten.params === "object"
    && !Array.isArray(rewritten.params)
    ? {
        ...rewritten.params,
        ...(
          rewritten.params.outputs
          && typeof rewritten.params.outputs === "object"
          && !Array.isArray(rewritten.params.outputs)
            ? {
                outputs: Object.fromEntries(
                  Object.entries(rewritten.params.outputs as Record<string, unknown>)
                    .map(([key, value]) => [node.outputBindings[key] ?? key, value]),
                ),
              }
            : {}
        ),
        ...(
          typeof rewritten.params.outputVariable === "string"
          && node.outputBindings[rewritten.params.outputVariable]
            ? { outputVariable: node.outputBindings[rewritten.params.outputVariable] }
            : {}
        ),
      }
    : null;
  const withParams = rewrittenParams && rewritten.type === "action"
    ? { ...rewritten, params: rewrittenParams }
    : rewritten;
  const outputName = withParams.type === "action" && withParams.saveOutputAs
    ? node.outputBindings[withParams.saveOutputAs]
    : null;
  const withOutput = outputName && withParams.type === "action"
    ? { ...withParams, saveOutputAs: outputName }
    : withParams;
  const withId = withOutput.id ? { ...withOutput, id: `${prefix}${withOutput.id}` } : withOutput;
  if (withId.type === "condition") {
    return {
      ...withId,
      if_true: withId.if_true.map((child) => prefixStep(child, node, inputBindings)),
      ...(withId.if_false ? { if_false: withId.if_false.map((child) => prefixStep(child, node, inputBindings)) } : {}),
    };
  }
  if (withId.type === "loop") {
    return { ...withId, steps: withId.steps.map((child) => prefixStep(child, node, inputBindings)) };
  }
  if (withId.type === "action" && withId.onFailureSteps) {
    return {
      ...withId,
      onFailureSteps: withId.onFailureSteps.map((child) => prefixStep(child, node, inputBindings)),
    };
  }
  return withId;
}

export function validateCompositionGraph(
  composition: WorkflowCompositionRecord,
  segments: Map<string, WorkflowSegmentVersionRecord>,
): void {
  const nodesByKey = new Map<string, WorkflowCompositionNodeRecord>();
  const ordinals = new Set<number>();
  const outputProducers = new Map<string, string>();
  for (const node of composition.nodes) {
    if (nodesByKey.has(node.nodeKey)) {
      throw Object.assign(new Error(`duplicate composition node: ${node.nodeKey}`), {
        code: "WORKFLOW_COMPOSITION_GRAPH_INVALID",
      });
    }
    if (ordinals.has(node.ordinal)) {
      throw Object.assign(new Error(`duplicate composition ordinal: ${node.ordinal}`), {
        code: "WORKFLOW_COMPOSITION_GRAPH_INVALID",
      });
    }
    nodesByKey.set(node.nodeKey, node);
    ordinals.add(node.ordinal);
  }
  for (const node of composition.nodes) {
    const segment = segments.get(`${node.segmentKey}@${node.segmentVersion}`);
    if (!segment) continue;
    for (const dependency of node.dependsOn) {
      const dependencyNode = nodesByKey.get(dependency);
      if (!dependencyNode || dependencyNode.ordinal >= node.ordinal) {
        throw Object.assign(new Error(`invalid dependency ${dependency} for node ${node.nodeKey}`), {
          code: "WORKFLOW_COMPOSITION_GRAPH_INVALID",
        });
      }
    }
    const segmentInputs = segment.inputSchema.properties;
    const compositionInputs = composition.inputSchema.properties;
    const segmentOutputs = segment.outputSchema?.properties ?? {};
    for (const [segmentOutput, compositionOutput] of Object.entries(node.outputBindings)) {
      if (!segmentOutputs[segmentOutput]) {
        throw Object.assign(new Error(`node ${node.nodeKey} output is not declared by segment: ${segmentOutput}`), {
          code: "WORKFLOW_COMPOSITION_BINDING_INVALID",
        });
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(compositionOutput)) {
        throw Object.assign(new Error(`node ${node.nodeKey} output target is invalid: ${compositionOutput}`), {
          code: "WORKFLOW_COMPOSITION_BINDING_INVALID",
        });
      }
      if (outputProducers.has(compositionOutput)) {
        throw Object.assign(new Error(`composition output target is produced more than once: ${compositionOutput}`), {
          code: "WORKFLOW_COMPOSITION_BINDING_INVALID",
        });
      }
      outputProducers.set(compositionOutput, node.nodeKey);
    }
    for (const requiredInput of segment.inputSchema.required) {
      if (!node.inputBindings[requiredInput]) {
        throw Object.assign(new Error(`node ${node.nodeKey} does not bind required input ${requiredInput}`), {
          code: "WORKFLOW_COMPOSITION_BINDING_INVALID",
        });
      }
    }
    for (const [segmentInput, source] of Object.entries(node.inputBindings)) {
      const compositionInput = source.startsWith("inputs.") ? source.slice("inputs.".length) : source;
      const producer = outputProducers.get(source);
      const fromComposition = !!compositionInputs[compositionInput];
      const fromDependency = !!producer && node.dependsOn.includes(producer);
      if (!segmentInputs[segmentInput] || (!fromComposition && !fromDependency)) {
        throw Object.assign(
          new Error(`invalid input binding ${node.nodeKey}.${segmentInput} -> ${source}`),
          { code: "WORKFLOW_COMPOSITION_BINDING_INVALID" },
        );
      }
    }
  }
  for (const requiredOutput of composition.outputSchema.required) {
    if (!outputProducers.has(requiredOutput)) {
      throw Object.assign(new Error(`composition required output is not produced: ${requiredOutput}`), {
        code: "WORKFLOW_COMPOSITION_BINDING_INVALID",
      });
    }
  }
}

export function computeSegmentFingerprint(segment: WorkflowSegmentVersionRecord): string {
  return fullFingerprint("workflow-segment-v1", {
    segmentKey: segment.segmentKey,
    version: segment.version,
    platform: segment.platform,
    template: segment.template,
    inputSchema: segment.inputSchema,
    outputSchema: segment.outputSchema,
    postconditionContract: segment.postconditionContract,
    compatibility: segment.compatibility,
  });
}

export function computeCompositionStructureKey(
  composition: WorkflowCompositionRecord,
  segments: Map<string, WorkflowSegmentVersionRecord>,
): string {
  return shortKey("workflow-composition-v1", {
    compositionName: composition.compositionName,
    version: composition.version,
    capabilityKey: composition.capabilityKey,
    platform: composition.platform,
    inputSchema: composition.inputSchema,
    outputSchema: composition.outputSchema,
    inputResolver: composition.inputResolver,
    postconditionContract: composition.postconditionContract,
    executionPolicy: composition.executionPolicy,
    compatibility: composition.compatibility,
    nodes: composition.nodes.map((node) => ({
      ...node,
      segmentFingerprint: segments.get(`${node.segmentKey}@${node.segmentVersion}`)?.fingerprint,
    })),
  });
}

export class WorkflowSegmentComposer {
  constructor(private readonly repository: WorkflowSegmentRepository = workflowSegmentRepository) {}

  async compose(input: {
    capabilityKey: string;
    platform: string;
    intent: string;
    requestKey: string;
    deviceId: string;
    accountId: string | null;
  }): Promise<ComposedWorkflow | null> {
    const composition = await this.repository.promotedComposition(input.capabilityKey, input.platform);
    if (!composition) return null;
    const segments = await this.repository.segmentVersions(composition.nodes, ["promoted"]);
    return this.composeResolved(composition, segments, input);
  }

  async composeCandidate(input: {
    compositionName: string;
    compositionVersion: string;
    platform: string;
    intent: string;
    requestKey: string;
    deviceId: string;
    accountId: string | null;
  }): Promise<ComposedWorkflow | null> {
    const composition = await this.repository.compositionVersion(
      input.compositionName,
      input.compositionVersion,
      ["candidate"],
    );
    if (!composition) return null;
    const segments = await this.repository.segmentVersions(composition.nodes, ["candidate", "promoted"]);
    return this.composeResolved(composition, segments, input);
  }

  private async composeResolved(
    composition: WorkflowCompositionRecord,
    segments: Map<string, WorkflowSegmentVersionRecord>,
    input: {
      platform: string;
      intent: string;
      requestKey: string;
      deviceId: string;
      accountId: string | null;
    },
  ): Promise<ComposedWorkflow> {
    if (composition.nodes.length === 0) {
      throw Object.assign(new Error("workflow composition has no nodes"), {
        code: "WORKFLOW_COMPOSITION_INVALID",
      });
    }
    for (const node of composition.nodes) {
      const segment = segments.get(`${node.segmentKey}@${node.segmentVersion}`);
      if (!segment) {
        throw Object.assign(new Error(`composition segment is unavailable: ${node.segmentKey}@${node.segmentVersion}`), {
          code: "WORKFLOW_SEGMENT_UNAVAILABLE",
        });
      }
      if (segment.fingerprint !== computeSegmentFingerprint(segment)) {
        throw Object.assign(new Error(`composition segment fingerprint mismatch: ${node.segmentKey}@${node.segmentVersion}`), {
          code: "WORKFLOW_SEGMENT_FINGERPRINT_MISMATCH",
        });
      }
    }
    validateCompositionGraph(composition, segments);
    const expectedCompositionKey = computeCompositionStructureKey(composition, segments);
    if (composition.compositionKey !== expectedCompositionKey) {
      throw Object.assign(new Error("workflow composition fingerprint mismatch"), {
        code: "WORKFLOW_COMPOSITION_FINGERPRINT_MISMATCH",
      });
    }
    const runtimeInputs = resolveCompositionInputs(input.intent, composition.inputResolver, composition.inputSchema);
    const executionKey = computeExecutionKey({
      deviceId: input.deviceId,
      accountId: input.accountId,
      compositionKey: composition.compositionKey,
      runtimeInputs,
    });
    const publicRuntimeInputs = Object.fromEntries(
      Object.entries(runtimeInputs).map(([key, value]) => [
        key,
        composition.inputSchema.properties[key]?.secret === true ? "[secret]" : value,
      ]),
    );
    const steps = composition.nodes.flatMap((node) => {
      const segment = segments.get(`${node.segmentKey}@${node.segmentVersion}`)!;
      const inputBindings = Object.fromEntries(
        Object.entries(node.inputBindings).map(([segmentInput, source]) => [
          segmentInput,
          composition.inputSchema.properties[source]
            ? `inputs.${source}`
            : source,
        ]),
      );
      return segment.template.steps.map((step) => prefixStep(step, node, inputBindings));
    });
    const template: WorkflowTemplate = {
      id: composition.compositionName,
      name: composition.compositionName,
      platform: composition.platform === "*" ? input.platform : composition.platform,
      description: `PostgreSQL composition ${composition.compositionName}@${composition.version}`,
      version: composition.version,
      safetyClass: composition.nodes.reduce<WorkflowTemplate["safetyClass"]>(
        (result, node) => {
          const safety = segments.get(`${node.segmentKey}@${node.segmentVersion}`)!.template.safetyClass;
          if (result === "standard" || safety === "standard") return "standard";
          return "read_only";
        },
        "read_only",
      ),
      outputSchema: composition.outputSchema,
      postconditionContract: composition.postconditionContract,
      steps,
      defaultVerificationStrategy: composition.executionPolicy.defaultVerificationStrategy,
      dataRetentionDays: composition.executionPolicy.dataRetentionDays,
      runtimeContract: composition.executionPolicy.runtimeContract,
    };
    const validation = validateGeneratedWorkflowTemplate(template);
    if (!validation.template) {
      throw Object.assign(new Error(`composed workflow failed validation: ${validation.errors.join("; ")}`), {
        code: "WORKFLOW_COMPOSITION_VALIDATION_FAILED",
        validationErrors: validation.errors,
      });
    }
    await this.repository.saveExecutionBinding({
      requestKey: input.requestKey,
      executionKey,
      composition,
      deviceId: input.deviceId,
      accountId: input.accountId,
      intent: input.intent,
      runtimeInputs,
      auditRuntimeInputs: publicRuntimeInputs,
    });
    return {
      architecture: "segments-v1",
      template: validation.template,
      compositionName: composition.compositionName,
      compositionVersion: composition.version,
      compositionKey: composition.compositionKey,
      executionKey,
      requestKey: input.requestKey,
      segmentKeys: composition.nodes.map((node) => node.segmentKey),
      segmentRefs: composition.nodes.map((node) => ({
        segmentKey: node.segmentKey,
        segmentVersion: node.segmentVersion,
      })),
      runtimeInputs,
      publicRuntimeInputs,
    };
  }
}

export const workflowSegmentComposer = new WorkflowSegmentComposer();
