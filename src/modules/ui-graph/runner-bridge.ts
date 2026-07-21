import type { UiTreeNode } from "../app-mapping/schema";
import type { CompiledStep, CompiledWorkflow } from "../workflow-compiler/types";
import { resolveUiState } from "./state-resolver";
import { resolveUiTarget } from "./target-resolver";
import { observeStateResolution, observeTargetResolution } from "./telemetry";
import { uiGraphRepository } from "./repository";
import type { RuntimeFlags, StateResolution, TargetResolution, UiGraphContext, UiStateDefinition } from "./types";

export interface RunnerResolvedTarget {
  resolution: TargetResolution;
  a11yParams?: Record<string, unknown>;
  coords?: { x: number; y: number };
}

function treeDimensions(nodes: UiTreeNode[]): { width: number | null; height: number | null } {
  let width = 0;
  let height = 0;
  const walk = (items: UiTreeNode[]) => {
    for (const node of items) {
      if (node.bounds) {
        width = Math.max(width, node.bounds.right);
        height = Math.max(height, node.bounds.bottom);
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return { width: width || null, height: height || null };
}

export class RunnerUiGraphSession {
  constructor(
    readonly flags: RuntimeFlags,
    readonly states: UiStateDefinition[],
    private readonly baseContext: UiGraphContext,
  ) {}

  get enabled(): boolean { return this.flags.mode !== "disabled"; }
  get enforced(): boolean { return this.flags.mode === "enforced"; }
  stateByKey(key: string): UiStateDefinition | null { return this.states.find((state) => state.key === key) ?? null; }

  async observeState(uiTree: UiTreeNode[], step: CompiledStep): Promise<StateResolution> {
    const context = { ...this.baseContext, stepId: step.id };
    const resolution = resolveUiState(uiTree, this.states, context);
    observeStateResolution(context.appId, resolution);
    await uiGraphRepository.recordObservation(context, resolution, {
      expectedPage: step.expectedPage,
      expectedPageHash: step.expectedPageHash,
      shadow: this.flags.mode === "shadow",
    }).catch((error) => console.warn(`[ui-graph] observation persistence failed: ${(error as Error).message}`));
    return resolution;
  }

  acceptsExpectedState(step: CompiledStep, resolution: StateResolution): boolean {
    if (!this.enforced || !resolution.stateId || resolution.confidence < 0.85) return false;
    return resolution.stateKey === step.expectedPage;
  }

  async resolveTarget(uiTree: UiTreeNode[], step: CompiledStep, state: StateResolution): Promise<RunnerResolvedTarget | null> {
    const elementKey = step.target?.elementId;
    if (!this.flags.selectorFirst || !elementKey || !state.stateId) return null;
    const dimensions = treeDimensions(uiTree);
    const context: UiGraphContext = {
      ...this.baseContext,
      stepId: step.id,
      screenWidth: dimensions.width,
      screenHeight: dimensions.height,
      currentStateId: state.stateId,
      currentVariantId: state.variantId,
    };
    const selectors = await uiGraphRepository.loadSelectors(context.appId, state.stateId, elementKey);
    const resolution = resolveUiTarget(uiTree, selectors, context);
    observeTargetResolution(context.appId, resolution);
    if (!resolution.found) return { resolution };
    if (resolution.method === "coord_cache") return { resolution, coords: resolution.coords };
    const node = resolution.node;
    if (!node) return { resolution, coords: resolution.coords };
    const a11yParams: Record<string, unknown> = {};
    if (node.resourceId) a11yParams.resourceId = node.resourceId;
    else if (node.contentDescription) a11yParams.contentDescription = node.contentDescription;
    else if (node.text) a11yParams.text = node.text;
    if (resolution.method === "text") a11yParams.partialMatch = false;
    return { resolution, a11yParams, coords: resolution.coords };
  }
}

export async function createRunnerUiGraphSession(input: {
  deviceId: string;
  workflow: CompiledWorkflow;
}): Promise<RunnerUiGraphSession> {
  const context: UiGraphContext = {
    appId: input.workflow.appId,
    deviceId: input.deviceId,
    workflowId: input.workflow.id,
    deviceClass: "phone",
  };
  const flags = await uiGraphRepository.resolveFlags(context);
  const states = flags.mode === "disabled" ? [] : await uiGraphRepository.loadStates(context.appId);
  return new RunnerUiGraphSession(flags, states, context);
}
