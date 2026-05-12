/**
 * batch-types.ts
 * TypeScript types for Instruction Batch protocol.
 * Fast-Path workflow execution: server sends all steps as one message, device returns all results as one message.
 */

// ─── BATCH_START (Server → Device) ───────────────────────────────────────────

export interface BATCH_START {
  type: "BATCH_START";
  batchId: string;      // UUID, unique per batch
  workflowId: string;    // UUID of workflow this batch belongs to
  stepIndex: number;    // Starting step index in workflow
  steps: BatchStep[];
  options: BatchOptions;
}

export interface BatchOptions {
  /** Continue execution even if a step fails. Default: false */
  continueOnError?: boolean;
  /** Per-step timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;
  /** Total batch timeout. Default: timeoutMs * steps.length * 1.5 */
  batchTimeoutMs?: number;
}

// ─── BatchStep ────────────────────────────────────────────────────────────────

export type BatchStep = ActionStep | WaitStep | ConditionStep | LoopStep;

export interface BaseBatchStep {
  id: number;              // 1-based step number within this batch
  type: "action" | "wait" | "condition" | "loop";
  verify?: VerificationConfig | null;
}

export interface ActionStep extends BaseBatchStep {
  type: "action";
  action: ActionType;
  target: string | null;   // Element name, e.g., "post.like", or null for generic actions
  params: ActionParams;
}

export interface WaitStep extends BaseBatchStep {
  type: "wait";
  action: "wait";
  target: null;
  params: WaitParams;
}

export interface ConditionStep extends BaseBatchStep {
  type: "condition";
  action: "condition";
  target: string;           // Condition expression, e.g., "has_followers > 100"
  params: ConditionParams;
}

export interface LoopStep extends BaseBatchStep {
  type: "loop";
  action: "loop";
  target: null;
  params: LoopParams;
}

// ─── Action Types ────────────────────────────────────────────────────────────

export type ActionType =
  | "tap"
  | "type"
  | "swipe"
  | "press_back"
  | "press_home"
  | "press_recent"
  | "open_app"
  | "close_app"
  | "keyevent"
  | "long_press"
  | "double_tap"
  | "scroll";

export interface ActionParams {
  // For tap, long_press, double_tap:
  x?: number;               // Normalized 0.0-1.0
  y?: number;               // Normalized 0.0-1.0

  // For type:
  text?: string;

  // For swipe:
  direction?: "up" | "down" | "left" | "right";
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  durationMs?: number;

  // For open_app:
  packageName?: string;

  // For keyevent:
  keyCode?: number;

  // For scroll:
  scrollDirection?: "up" | "down" | "left" | "right";
  percent?: number;         // Percentage of screen to scroll
}

export interface WaitParams {
  durationMs: number;
}

export interface ConditionParams {
  expression: string;        // e.g., "element_exists(post.like)", "screen == home"
  trueBranch: BatchStep[];  // Steps to execute if condition is true
  falseBranch: BatchStep[];  // Steps to execute if condition is false
}

export interface LoopParams {
  count: number;            // Fixed iteration count
  variable?: string;         // Variable name to iterate over (e.g., "posts", "followers")
  steps: BatchStep[];       // Steps to execute each iteration
}

// ─── Verification ───────────────────────────────────────────────────────────

export type VerificationType = "ui_tree" | "pixel_diff" | "vision" | "none";

export interface VerificationConfig {
  type: VerificationType;
  expectedScreen?: string;    // Screen identifier for navigation verification
  timeoutMs?: number;        // Verification timeout, default: 5000
  threshold?: number;         // For pixel_diff: match threshold 0.0-1.0
}

// ─── BATCH_RESULT (Device → Server) ────────────────────────────────────────

export interface BATCH_RESULT {
  type: "BATCH_RESULT";
  batchId: string;           // Must match BATCH_START.batchId
  workflowId: string;
  status: BatchStatus;
  results: StepResult[];
  executedAt: string;         // ISO8601 timestamp
}

export type BatchStatus = "completed" | "partial_failure" | "failed" | "timeout";

export interface StepResult {
  id: number;               // Matches step id from BATCH_START
  status: StepStatus;
  durationMs: number;
  output: StepOutput;
  error?: string;            // Error message if status === "failed"
}

export type StepStatus = "success" | "failed" | "skipped" | "timeout";

export interface StepOutput {
  // Actual coordinates tapped (for tap actions)
  x?: number;
  y?: number;

  // Screen after step execution
  screenAfter?: string;

  // Verification result
  verificationPassed?: boolean;

  // For type action: text that was typed
  textTyped?: string;

  // For swipe: direction performed
  swipeDirection?: string;

  // For condition: which branch was taken
  branchTaken?: "true" | "false" | null;

  // For loop: iteration count
  iterationsCompleted?: number;

  // Additional context
  [key: string]: unknown;
}

// ─── Batch Factory Helpers ───────────────────────────────────────────────────

/**
 * Create a BATCH_START message from workflow steps.
 */
export function createBatchStart(
  batchId: string,
  workflowId: string,
  stepIndex: number,
  steps: BatchStep[],
  options?: Partial<BatchOptions>
): BATCH_START {
  return {
    type: "BATCH_START",
    batchId,
    workflowId,
    stepIndex,
    steps,
    options: {
      continueOnError: options?.continueOnError ?? false,
      timeoutMs: options?.timeoutMs ?? 30_000,
      batchTimeoutMs: options?.batchTimeoutMs ??
        (options?.timeoutMs ? options.timeoutMs * steps.length * 1.5 : undefined),
    },
  };
}

/**
 * Validate a BATCH_RESULT matches the expected batchId.
 */
export function validateBatchResult(
  result: unknown,
  expectedBatchId: string
): result is BATCH_RESULT {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    r.type === "BATCH_RESULT" &&
    typeof r.batchId === "string" &&
    r.batchId === expectedBatchId &&
    Array.isArray(r.results)
  );
}

/**
 * Determine overall batch status from individual step results.
 */
export function computeBatchStatus(results: StepResult[]): BatchStatus {
  if (results.length === 0) return "failed";
  if (results.every(r => r.status === "success")) return "completed";
  if (results.every(r => r.status === "failed" || r.status === "skipped")) return "failed";
  return "partial_failure";
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

export function isActionStep(step: BatchStep): step is ActionStep {
  return step.type === "action";
}

export function isWaitStep(step: BatchStep): step is WaitStep {
  return step.type === "wait";
}

export function isConditionStep(step: BatchStep): step is ConditionStep {
  return step.type === "condition";
}

export function isLoopStep(step: BatchStep): step is LoopStep {
  return step.type === "loop";
}
