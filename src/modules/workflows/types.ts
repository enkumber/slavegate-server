/**
 * workflows/types.ts
 * Workflow DAG type definitions — shared between templates, service, and executor.
 * These types define the YAML/JSON DSL structure for workflow templates.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §8 (Workflow Engine)
 */

// ─── Verification strategies ──────────────────────────────────────────────────

export type VerificationStrategy =
  | "local_only"              // L1 (UI tree diff) only
  | "local_with_screenshot"   // L1 + L2 (pixel diff)
  | "full_cascade"            // L1 + L2 + L3 (VLM) — Phase 3
  | "vlm_required";           // L3 direct — Phase 3

// Phase 2: full_cascade and vlm_required return VERIFICATION_NOT_AVAILABLE error
export const PHASE2_UNSUPPORTED_STRATEGIES: VerificationStrategy[] = [
  "full_cascade",
  "vlm_required",
];

// ─── Step types ───────────────────────────────────────────────────────────────

export type StepType =
  | "action"      // Execute a single job on device
  | "wait"        // Wait for condition or fixed duration
  | "condition"   // Branch based on probability or state
  | "loop"        // Repeat steps N times
  | "parallel"    // Future: run steps on different devices simultaneously
  | "checkpoint"; // Explicit checkpoint (auto-checkpoint also after every step)

// ─── Action steps ─────────────────────────────────────────────────────────────

export interface ActionStep {
  type:      "action";
  id?:       string;   // Optional step ID for checkpoint reference
  action:    string;   // Job type: "tap", "scroll", "screenshot", etc.
  /** Target element identifier — resolved by platform parser or A11y service */
  target?:   string;
  /** Coordinates — used if target is not set (raw tap) */
  x?:        number;
  y?:        number;
  /** Params forwarded to JobExecutor */
  params?:   Record<string, unknown>;
  verification?: VerificationStrategy;
  /** How many times to retry on failure */
  retries?:  number;
  /** Timeout for this step in ms (overrides workflow default) */
  timeoutMs?: number;
}

// ─── Wait steps ───────────────────────────────────────────────────────────────

export interface FixedDurationSpec {
  min:          number;
  max:          number;
  distribution: "uniform" | "lognormal" | "normal";
  mean?:        number;  // For lognormal/normal
}

export interface WaitStep {
  type:      "wait";
  id?:       string;
  /** Fixed duration range (ms) */
  duration?: FixedDurationSpec;
  /** Wait until UI element is visible */
  condition?: "ui_element_visible" | "ui_element_gone" | "app_launched" | "network_available";
  element?:  string;   // For ui_element_visible/gone
  timeoutMs?: number;  // Max wait for condition
}

// ─── Condition steps ──────────────────────────────────────────────────────────

export interface ConditionStep {
  type:        "condition";
  id?:         string;
  check:       "random_probability" | "mood_engaged" | "mood_explorer" | "account_warmup";
  probability?: number;  // For random_probability: 0.0-1.0
  if_true:     WorkflowStep[];
  if_false?:   WorkflowStep[];
}

// ─── Loop steps ───────────────────────────────────────────────────────────────

export interface LoopCountSpec {
  min:          number;
  max:          number;
  distribution: "uniform" | "normal";
}

export interface LoopStep {
  type:     "loop";
  id?:      string;
  count:    LoopCountSpec;
  steps:    WorkflowStep[];
  /** Break condition — exit early if met */
  breakOn?: "session_time_exceeded" | "engagement_limit_reached";
}

// ─── Checkpoint steps ─────────────────────────────────────────────────────────

export interface CheckpointStep {
  type:    "checkpoint";
  id:      string;  // Required — checkpoint ID
  reason?: string;
}

// ─── Union type ───────────────────────────────────────────────────────────────

export type WorkflowStep =
  | ActionStep
  | WaitStep
  | ConditionStep
  | LoopStep
  | CheckpointStep;

// ─── Template definition ──────────────────────────────────────────────────────

export interface WorkflowTemplate {
  id:          string;
  name:        string;
  platform:    string;   // "instagram", "tiktok", "reddit", or "*" for platform-agnostic
  description: string;
  version:     string;
  steps:       WorkflowStep[];
  /** Default verification strategy for steps that don't specify one */
  defaultVerificationStrategy: VerificationStrategy;
  /** Data retention days for extracted content */
  dataRetentionDays: number;
  /** Compatible app version patterns (e.g. "300+", "301") */
  compatibleAppVersions?: string[];
}

// ─── Execution state ──────────────────────────────────────────────────────────

export interface WorkflowCheckpoint {
  /** Step index in top-level steps array */
  stepIndex:    number;
  /**
   * Loop iteration tracking — updated after each completed iteration.
   * On resume: skip to currentIteration (avoids double-follow/double-comment).
   * One entry per active nested loop (innermost last).
   */
  loopStack:    Array<{
    stepIndex:         number;  // index of the LoopStep in the steps array
    currentIteration:  number;  // next iteration to execute (0-based, already-done = currentIteration)
    totalIterations:   number;
  }>;
  /** Variables accumulated during execution */
  variables:    Record<string, unknown>;
  /** HBE session params (mood, drift) — stable for entire session */
  hbeParams:    Record<string, unknown>;
  /** Timestamp of last checkpoint */
  checkpointAt: string;  // ISO 8601
}

export type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
