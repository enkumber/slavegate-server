/**
 * workflow-compiler/types.ts
 * Type definitions for the Workflow Compiler + Runner with AI Fallback.
 *
 * Story: US-WORKFLOW-COMPILER
 *
 * Three execution levels:
 *   Level 3 (AI Planning)    — NL instruction → compiled workflow JSON
 *   Level 1 (Deterministic)  — Step-by-step execution with fingerprint verification
 *   Level 2 (AI Recovery)    — Screenshot/UI tree analysis on errors
 */

import type { AppMap } from "../app-mapping/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// COMPILED WORKFLOW — Core output of AI Planning (Level 3)
// ═══════════════════════════════════════════════════════════════════════════════

export interface CompiledWorkflow {
  id: string;
  name: string;
  /** Original natural language instruction */
  source: string;
  /** Target app package name */
  appId: string;
  compiledAt: string;

  steps: CompiledStep[];

  /** App map version used for compilation */
  appMapVersion: string;
  /** Expected starting page ID (from app map) */
  startPage: string;

  /** Max recovery attempts per step (default: 1) */
  maxRecoveryAttempts: number;
  /** Max total recovery attempts per workflow (default: 10) */
  maxTotalRecoveryAttempts: number;
  /** Optional explicit LLM model override for recovery. Omit to use Dashboard decision_llm config. */
  recoveryModel?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPILED STEP — Single step in a compiled workflow
// ═══════════════════════════════════════════════════════════════════════════════

export interface CompiledStep {
  id: string;

  /** Action to execute on the device */
  action: CompiledAction;
  /** Target element (optional — not all actions need a target, e.g. open_app) */
  target?: StepTarget;
  /** Additional parameters for the action (text to type, key to press, etc.) */
  params?: Record<string, unknown>;

  /** Expected page ID after this step (from app map) */
  expectedPage: string;
  /** Signature hash for fingerprint verification */
  expectedPageHash: string;

  /** Retry count on failure */
  retries: number;
  /** Delay between retries in ms */
  retryDelay: number;

  /** Human-readable description — used as context for AI recovery */
  description: string;
}

export type CompiledAction =
  | "tap"
  | "type"
  | "swipe"
  | "press_key"
  | "wait"
  | "open_app"
  | "intent_send"
  | "screenshot";

export interface StepTarget {
  /** Element ID from app map */
  elementId?: string;
  /** Direct Android resource ID */
  resourceId?: string;
  /** Visible text on the element */
  text?: string;
  /** Normalized coordinates (0.0 – 1.0) */
  coords?: { x: number; y: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY ACTIONS — Output of AI Recovery (Level 2)
// ═══════════════════════════════════════════════════════════════════════════════

export type RecoveryAction =
  | { type: "retry_step" }
  | { type: "retry_with_adaptation"; adaptedStep: CompiledStep }
  | { type: "dismiss_and_retry"; dismissActions: CompiledStep[] }
  | { type: "navigate_back_and_retry"; backSteps: number }
  | { type: "abort"; reason: string };

export interface RecoveryContext {
  /** The step that failed */
  failedStep: CompiledStep;
  /** Index of the failed step in the workflow */
  stepIndex: number;
  /** Current screenshot (base64 or file path) */
  screenshot?: string;
  /** Current UI tree dump */
  uiTree?: unknown;
  /** App map for reference */
  appMap: AppMap;
  /** Error that triggered recovery */
  error: string;
  /** Number of recovery attempts so far for this step */
  attemptNumber: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPILE REQUEST / RESULT — API layer types
// ═══════════════════════════════════════════════════════════════════════════════

export interface CompileRequest {
  /** Target app package name */
  appId: string;
  /** Natural language instruction */
  instruction: string;
  /** Compilation options */
  options?: CompileOptions;
}

export interface CompileOptions {
  /** Max recovery attempts per step (default: 1) */
  maxRecoveryAttempts?: number;
  /** Max total recovery attempts per workflow (default: 10) */
  maxTotalRecoveryAttempts?: number;
  /** LLM model for recovery (default: from config) */
  recoveryModel?: string;
  /** Optional LLM model override for compilation. Omit to use Dashboard decision_llm config. */
  model?: string;
  /** If true, compile only — don't execute */
  dryRun?: boolean;
  /** Force recompilation even if cached result exists */
  forceRecompile?: boolean;
}

export interface CompileResult {
  ok: boolean;
  /** ID of the compiled workflow in DB */
  workflowId?: string;
  /** Compiled workflow (present on success) */
  compiledWorkflow?: CompiledWorkflow;
  /** Validation errors (present if compilation produced invalid workflow) */
  validationErrors?: string[];
  /** Error message (present on failure) */
  error?: string;
  /** Whether the result was served from cache */
  fromCache?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type WorkflowExecutionStatus =
  | "compiled"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export interface ExecutionProgress {
  workflowId: string;
  status: WorkflowExecutionStatus;
  totalSteps: number;
  stepsCompleted: number;
  currentStepIndex: number;
  currentStepDescription: string;
  recoveryCount: number;
  startedAt?: string;
  completedAt?: string;
}

export interface CompileAndRunRequest {
  /** Device to execute on */
  deviceId: string;
  /** Target app package name */
  appId: string;
  /** Natural language instruction */
  instruction: string;
  /** Compilation & execution options */
  options?: CompileOptions;
}

export interface CompileAndRunResult {
  ok: boolean;
  workflowId?: string;
  compiledWorkflow?: CompiledWorkflow;
  jobId?: string;
  status?: string;
  error?: string;
}

export interface RunCompiledRequest {
  /** Device to execute on */
  deviceId: string;
  /** Full compiled workflow, or a workflow ID from previous compilation */
  compiledWorkflow?: CompiledWorkflow;
  workflowId?: string;
}

export interface RunCompiledResult {
  ok: boolean;
  jobId?: string;
  status?: string;
  counters?: {
    compileLlmCalls: number;
    recoveryLlmCalls: number;
    creativeLlmCalls: number;
    runtimeLlmCalls: number;
    vlmCalls: number;
    deterministicSteps: number;
    batchedSteps: number;
    failedSteps: number;
    retriedSteps: number;
    recoveryAttempts: number;
    recoveryBudgetExhausted: number;
  };
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
