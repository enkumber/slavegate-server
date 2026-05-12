/**
 * agents/types.ts
 * Multi-Agent Architecture type definitions.
 * Reference: Mobile-Agent v2 — Planner/Executor/Verifier pattern.
 */

// ─── Planner ──────────────────────────────────────────────────────────────────

export interface PlannerInput {
  task: string;              // "Unfollow users who don't follow back"
  appContext: string;        // "instagram"
  deviceId: string;
  currentScreenshot?: string; // base64 (optional, for context)
}

export interface PlanStep {
  id: number;
  action: string;            // "tap" | "swipe" | "type" | "wait" | "back" | "scroll"
  description: string;       // "Navigate to profile tab"
  target?: string;           // Element hint: "profile_tab", "following_count", "unfollow_button"
  expectedScreen?: string;   // "profile_screen", "following_list"
  params?: Record<string, unknown>;  // Extra params: { text: "search query" }, { direction: "up" }
  optional?: boolean;        // true = skip on failure, don't abort
  fallbackStrategy?: string; // "scroll_and_retry" | "go_back_and_retry"
}

export interface PlannerOutput {
  steps: PlanStep[];
  estimatedActions: number;
  complexity: "simple" | "medium" | "complex";
  reasoning: string;
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export interface ExecutorInput {
  step: PlanStep;
  deviceId: string;
  platform: string;          // "instagram"
  screenshot: string;        // base64
  uiTree?: string;           // a11y dump (optional)
  screenType?: string;       // Current screen hint for L1.5
  /** Speculative multi-action: remaining steps after current (for lookahead) */
  remainingSteps?: PlanStep[];
  /** How many actions to predict (1 = single action, 2-3 = speculative batch) */
  lookahead?: number;
}

export type ActionType = "tap" | "swipe" | "type" | "wait" | "back" | "scroll" | "skip";

export interface ExecutorAction {
  type: ActionType;
  x?: number;                // Normalized 0-1 for tap
  y?: number;
  element?: string;
  startX?: number;           // For swipe
  startY?: number;
  endX?: number;
  endY?: number;
  text?: string;             // For type action
  ms?: number;               // For wait action
  direction?: "up" | "down" | "left" | "right";  // For scroll
  reason?: string;           // For skip
}

export interface ExecutorOutput {
  action: ExecutorAction;
  confidence: number;        // 0.0-1.0
  reasoning: string;
  source: "cascade" | "vlm" | "llm_inferred";
  cascadeLevel?: string;
  /** Speculative multi-action: additional predicted actions (UFO paper: -51% LLM calls) */
  speculativeActions?: ExecutorAction[];
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

export interface VerifierInput {
  step: PlanStep;
  actionTaken: ExecutorAction;
  screenshotBefore: string;  // base64
  screenshotAfter: string;   // base64
  platform: string;
}

export type VerificationStatus = "success" | "retry" | "abort" | "skip";

export interface VerifierOutput {
  status: VerificationStatus;
  reason: string;
  confidence: number;
  suggestedCorrection?: ExecutorAction;
  shouldInvalidateCache: boolean;
  detectedScreen?: string;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface TaskResult {
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  failedStep?: number;
  failReason?: string;
  tokenUsage: TokenUsage;
  durationMs: number;
}

export interface TokenUsage {
  planner: { input: number; output: number };
  executor: { input: number; output: number; calls: number };
  verifier: { input: number; output: number; calls: number };
  total: number;
}

// ─── LLM Client ───────────────────────────────────────────────────────────────

export interface LlmCompletionRequest {
  model: string;
  systemPrompt: string;
  userContent: LlmContent[];
  temperature: number;
  maxTokens: number;
}

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "image"; base64: string; mediaType?: string };

export interface LlmCompletionResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}
