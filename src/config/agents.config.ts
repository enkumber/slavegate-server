/**
 * config/agents.config.ts
 * Multi-Agent Architecture configuration.
 */

export const agentConfig = {
  planner: {
    model: process.env.AGENT_PLANNER_MODEL || "anthropic/claude-opus-4-5",
    temperature: 0.3,
    maxTokens: 2000,
  },
  executor: {
    model: process.env.AGENT_EXECUTOR_MODEL || "anthropic/claude-sonnet-4-6",
    temperature: 0.1,
    maxTokens: 1000,
    /** Speculative multi-action lookahead (UFO paper: -51% LLM calls). 1 = disabled. */
    lookahead: parseInt(process.env.AGENT_EXECUTOR_LOOKAHEAD || "3", 10),
  },
  verifier: {
    model: process.env.AGENT_VERIFIER_MODEL || "anthropic/claude-sonnet-4-6",
    temperature: 0.1,
    maxTokens: 500,
  },
  orchestrator: {
    maxRetries: 2,            // 3 total attempts (1 + 2 retries) — was 4, too slow
    stepTimeoutMs: 15_000,    // 15s per action on device (was 30s)
    screenshotDelayMs: 300,   // 300ms settle time (was 500ms)
    screenshotTimeoutMs: 8_000, // 8s — screencap on rooted OnePlus can take 2-3s + WS transfer
    maxStepsPerTask: 250, // Increased for complex tasks (35 likes + 7 comments + 3 follows)
    abortOnConsecutiveFailures: 3,
  },
} as const;

export type AgentRole = "planner" | "executor" | "verifier";
