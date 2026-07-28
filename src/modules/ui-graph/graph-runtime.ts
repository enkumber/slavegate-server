import type { UiTreeNode } from "../app-mapping/schema";
import { planGraphRoute, type GraphPlanningPolicy } from "./graph-planner";
import { resolveUiState, type StateResolutionPolicy } from "./state-resolver";
import type { GraphRoute, StateResolution, UiGraphContext, UiStateDefinition, UiTransitionDefinition } from "./types";

export interface GraphRuntimeBudget {
  maxTransitions: number;
  maxReplans: number;
  maxDurationMs: number;
}

export interface GraphRuntimeDependencies {
  captureUiTree(): Promise<UiTreeNode[]>;
  executeTransition(transition: UiTransitionDefinition): Promise<{ ok: boolean; error?: string }>;
  saveCheckpoint(checkpoint: GraphRuntimeCheckpoint): Promise<void>;
  onUnknownState?(resolution: StateResolution): Promise<boolean>;
}

export interface GraphRuntimeCheckpoint {
  targetStateId: string;
  currentStateId: string | null;
  completedTransitionIds: string[];
  transitionsExecuted: number;
  replans: number;
  updatedAt: string;
}

export interface GraphRuntimeResult {
  ok: boolean;
  aborted: boolean;
  checkpoint: GraphRuntimeCheckpoint;
  lastResolution: StateResolution;
  error?: string;
}

export class GraphRuntimeEngine {
  constructor(
    private readonly states: UiStateDefinition[],
    private readonly transitions: UiTransitionDefinition[],
    private readonly context: UiGraphContext,
    private readonly policy: GraphPlanningPolicy,
    private readonly stateResolutionPolicy: StateResolutionPolicy,
    private readonly dependencies: GraphRuntimeDependencies,
    private readonly budget: GraphRuntimeBudget,
  ) {}

  async planCurrentRoute(targetStateId: string): Promise<{ resolution: StateResolution; route: GraphRoute }> {
    const tree = await this.dependencies.captureUiTree();
    const resolution = resolveUiState(tree, this.states, this.context, this.stateResolutionPolicy);
    if (!resolution.stateId) {
      return { resolution, route: { found: false, transitions: [], totalCost: Infinity, reason: "Current state is unknown" } };
    }
    return {
      resolution,
      route: planGraphRoute(resolution.stateId, targetStateId, this.transitions, {
        ...this.policy,
        maxTransitions: Math.min(this.policy.maxTransitions, this.budget.maxTransitions),
      }),
    };
  }

  async run(targetStateId: string, resume?: Partial<GraphRuntimeCheckpoint>): Promise<GraphRuntimeResult> {
    const startedAt = Date.now();
    const checkpoint: GraphRuntimeCheckpoint = {
      targetStateId,
      currentStateId: resume?.currentStateId ?? null,
      completedTransitionIds: [...(resume?.completedTransitionIds ?? [])],
      transitionsExecuted: resume?.transitionsExecuted ?? 0,
      replans: resume?.replans ?? 0,
      updatedAt: new Date().toISOString(),
    };
    let lastResolution: StateResolution = {
      stateId: null, stateKey: null, variantId: null, variantKey: null, method: "unknown", confidence: 0,
      fingerprint: "", matchedAnchors: [], missingAnchors: [], unexpectedAnchors: [], ambiguousWith: [],
    };

    while (true) {
      if (Date.now() - startedAt > this.budget.maxDurationMs) return this.failure("Graph runtime duration budget exceeded", checkpoint, lastResolution, true);
      if (checkpoint.transitionsExecuted >= this.budget.maxTransitions) return this.failure("Graph runtime transition budget exceeded", checkpoint, lastResolution, true);
      if (checkpoint.replans > this.budget.maxReplans) return this.failure("Graph runtime replan budget exceeded", checkpoint, lastResolution, true);

      const tree = await this.dependencies.captureUiTree();
      lastResolution = resolveUiState(tree, this.states, this.context, this.stateResolutionPolicy);
      checkpoint.currentStateId = lastResolution.stateId;
      checkpoint.updatedAt = new Date().toISOString();
      await this.dependencies.saveCheckpoint(checkpoint);

      if (!lastResolution.stateId) {
        const recovered = await this.dependencies.onUnknownState?.(lastResolution) ?? false;
        if (!recovered) return this.failure("Current UI state is unknown", checkpoint, lastResolution);
        checkpoint.replans++;
        continue;
      }
      if (lastResolution.stateId === targetStateId) {
        return { ok: true, aborted: false, checkpoint, lastResolution };
      }

      const route = planGraphRoute(lastResolution.stateId, targetStateId, this.transitions, this.policy);
      if (!route.found || route.transitions.length === 0) return this.failure(route.reason ?? "No graph route", checkpoint, lastResolution);
      const transition = route.transitions[0];
      const executed = await this.dependencies.executeTransition(transition);
      checkpoint.transitionsExecuted++;
      if (!executed.ok) return this.failure(executed.error ?? `Transition ${transition.key} failed`, checkpoint, lastResolution);
      checkpoint.completedTransitionIds.push(transition.id);
      checkpoint.replans++;
      checkpoint.updatedAt = new Date().toISOString();
      await this.dependencies.saveCheckpoint(checkpoint);
      // The next loop captures and verifies the actual destination. If an overlay
      // or another known state appears, planning naturally branches from there.
    }
  }

  private failure(error: string, checkpoint: GraphRuntimeCheckpoint, lastResolution: StateResolution, aborted = false): GraphRuntimeResult {
    return { ok: false, aborted, checkpoint, lastResolution, error };
  }
}
