/**
 * workflow-compiler/index.ts
 * Module exports for the Workflow Compiler + Runner with AI Fallback.
 *
 * Story: US-WORKFLOW-COMPILER
 */

// ─── Types (SPARK — T1) ────────────────────────────────────────────────────

export type {
  CompiledWorkflow,
  CompiledStep,
  CompiledAction,
  StepTarget,
  RecoveryAction,
  RecoveryContext,
  CompileRequest,
  CompileOptions,
  CompileResult,
  WorkflowExecutionStatus,
  ExecutionProgress,
  CompileAndRunRequest,
  CompileAndRunResult,
  RunCompiledRequest,
  RunCompiledResult,
  ValidationResult,
} from "./types";

// ─── Prompt Builder (SPARK — T2) ───────────────────────────────────────────

export { buildCompilePrompt } from "./prompt-builder";
export type { BuildPromptOptions } from "./prompt-builder";

// ─── Workflow Validator (SPARK — T3) ───────────────────────────────────────

export { validateCompiledWorkflow } from "./workflow-validator";

// ─── Planner Service (VOLT — T4) ───────────────────────────────────────────

export {
  compileInstruction,
  getCompiledWorkflow,
  updateWorkflowStatus,
} from "./planner.service";

// ─── Runner Service (VOLT — T5) ────────────────────────────────────────────

export type {
  RunCompiledRequest as RunnerRequest,
  StepExecutionResult,
  RunCompiledResult as RunnerResult,
  RunnerContext,
} from "./runner.service";

// ─── Recovery Service (VOLT — T6) ──────────────────────────────────────────

export {
  attemptRecovery,
  resetRecoveryCounts,
  getRecoveryHistory,
  getRecoveryStats,
} from "./recovery.service";
export type {
  RecoveryAction as RecoveryActionType,
  RecoveryResult,
  RecoveryHistoryEntry,
} from "./recovery.service";

// ─── Compiler Routes (SPARK — T7) ──────────────────────────────────────────

export { default as compilerRoutes } from "./compiler-routes";
