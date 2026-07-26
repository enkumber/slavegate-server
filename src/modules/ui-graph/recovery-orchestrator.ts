import type { UiTreeNode } from "../app-mapping/schema";
import type { RecoveryProposal, StateResolution, UiGraphContext, UiSafetyClass } from "./types";
import { observeRecovery } from "./telemetry";

export interface RecoveryBudget {
  maxActions: number;
  maxAttempts: number;
  maxDurationMs: number;
  allowedSafetyClasses: UiSafetyClass[];
  allowedProposalTypes: string[];
  actionlessProposalTypes: string[];
}

export interface RecoveryInput {
  context: UiGraphContext;
  failureReason: string;
  failedAction: Record<string, unknown>;
  sourceResolution: StateResolution;
  safetyClass: UiSafetyClass;
  deterministicProposals?: RecoveryProposal[];
}

export interface RecoveryDependencies {
  captureUiTree(): Promise<UiTreeNode[]>;
  captureScreenshot(): Promise<string | null>;
  reasonFromUiTree(input: { tree: UiTreeNode[]; failureReason: string; failedAction: Record<string, unknown>; sourceResolution: StateResolution }): Promise<RecoveryProposal | null>;
  reasonFromVision(input: { tree: UiTreeNode[]; screenshot: string; failureReason: string; failedAction: Record<string, unknown>; sourceResolution: StateResolution }): Promise<RecoveryProposal | null>;
  executeAction(action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  verifyProposal(proposal: RecoveryProposal): Promise<{ ok: boolean; targetStateId?: string | null; evidence?: Record<string, unknown> }>;
  recordLearning?(proposal: RecoveryProposal, evidence: Record<string, unknown>): Promise<void>;
}

export interface RecoveryResult {
  ok: boolean;
  proposal?: RecoveryProposal;
  attempts: number;
  actionsExecuted: number;
  usedVision: boolean;
  error?: string;
}

function actionSafety(action: Record<string, unknown>): UiSafetyClass | null {
  const explicit = action.safetyClass;
  return typeof explicit === "string" && explicit.trim() ? explicit : null;
}

export function validateRecoveryProposal(proposal: RecoveryProposal, _safetyClass: UiSafetyClass, budget: RecoveryBudget): string[] {
  const errors: string[] = [];
  if (!proposal.type || !budget.allowedProposalTypes.includes(proposal.type)) errors.push("invalid_recovery_type");
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) errors.push("invalid_confidence");
  if (proposal.actions.length > budget.maxActions) errors.push("recovery_action_budget_exceeded");
  if (proposal.actions.length === 0 && !budget.actionlessProposalTypes.includes(proposal.type)) {
    errors.push("recovery_actions_required");
  }
  for (const action of proposal.actions) {
    const actionClass = actionSafety(action);
    if (!actionClass || !budget.allowedSafetyClasses.includes(actionClass)) {
      errors.push("recovery_safety_escalation_forbidden");
    }
  }
  return [...new Set(errors)];
}

export class RecoveryOrchestrator {
  constructor(private readonly dependencies: RecoveryDependencies, private readonly budget: RecoveryBudget) {}

  async recover(input: RecoveryInput): Promise<RecoveryResult> {
    const startedAt = Date.now();
    let attempts = 0;
    let actionsExecuted = 0;
    const tree = await this.dependencies.captureUiTree();
    let screenshot: string | null = null;
    for (const proposal of input.deterministicProposals ?? []) {
      if (attempts >= this.budget.maxAttempts || Date.now() - startedAt > this.budget.maxDurationMs) break;
      attempts++;
      const result = await this.tryProposal(proposal, input, "deterministic");
      actionsExecuted += result.actionsExecuted;
      if (result.ok) return { ...result, attempts, actionsExecuted };
    }

    if (attempts < this.budget.maxAttempts && Date.now() - startedAt <= this.budget.maxDurationMs) {
      const treeProposal = await this.dependencies.reasonFromUiTree({ tree, failureReason: input.failureReason, failedAction: input.failedAction, sourceResolution: input.sourceResolution });
      if (treeProposal) {
        attempts++;
        const result = await this.tryProposal(treeProposal, input, "ui_tree_llm");
        actionsExecuted += result.actionsExecuted;
        if (result.ok) return { ...result, attempts, actionsExecuted };
      }
    }

    if (attempts < this.budget.maxAttempts && Date.now() - startedAt <= this.budget.maxDurationMs) {
      screenshot = await this.dependencies.captureScreenshot();
      if (screenshot) {
        const proposal = await this.dependencies.reasonFromVision({ tree, screenshot, failureReason: input.failureReason, failedAction: input.failedAction, sourceResolution: input.sourceResolution });
        if (proposal) {
          attempts++;
          proposal.usedVision = true;
          const result = await this.tryProposal(proposal, input, "vlm");
          actionsExecuted += result.actionsExecuted;
          if (result.ok) return { ...result, attempts, actionsExecuted, usedVision: true };
        }
      }
    }

    return { ok: false, attempts, actionsExecuted, usedVision: Boolean(screenshot), error: "Recovery budget exhausted or no verified proposal succeeded" };
  }

  private async tryProposal(
    proposal: RecoveryProposal,
    input: RecoveryInput,
    level: "deterministic" | "ui_tree_llm" | "vlm",
  ): Promise<RecoveryResult> {
    const errors = validateRecoveryProposal(proposal, input.safetyClass, this.budget);
    if (errors.length > 0 || proposal.type === "abort") {
      observeRecovery(input.context.appId, level, "aborted");
      return { ok: false, proposal, attempts: 1, actionsExecuted: 0, usedVision: level === "vlm", error: errors.join(",") || proposal.reason };
    }
    let actionsExecuted = 0;
    for (const action of proposal.actions) {
      const result = await this.dependencies.executeAction(action);
      actionsExecuted++;
      if (!result.ok) {
        observeRecovery(input.context.appId, level, "failed");
        return { ok: false, proposal, attempts: 1, actionsExecuted, usedVision: level === "vlm", error: result.error ?? "Recovery action failed" };
      }
    }
    const verification = await this.dependencies.verifyProposal(proposal);
    if (!verification.ok) {
      observeRecovery(input.context.appId, level, "failed");
      return { ok: false, proposal, attempts: 1, actionsExecuted, usedVision: level === "vlm", error: "Recovery postcondition failed" };
    }
    if (proposal.learningEligible && this.dependencies.recordLearning) {
      await this.dependencies.recordLearning(proposal, verification.evidence ?? {});
    }
    observeRecovery(input.context.appId, level, "completed");
    return { ok: true, proposal, attempts: 1, actionsExecuted, usedVision: level === "vlm" };
  }
}
