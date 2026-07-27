/**
 * scalability.config.ts
 * Centralized configuration for server scalability.
 * All concurrency limits, pool sizes, and timeouts in one place.
 *
 * Architecture for 100-device target:
 * - Per-device: max 1 active workflow at a time
 * - Global: soft limit on concurrent workflows (configurable)
 * - DB pool: sized for max concurrent workflows + HTTP handlers
 * - Worker pool: BullMQ workers scale with concurrency setting
 * - Redis: shared connection with proper pooling
 */

// ─── Environment overrides ──────────────────────────────────────────────────

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export const scalabilityConfig = {
  // ── Device limits ──────────────────────────────────────────────────────
  /** Max concurrent workflows a single device can have (hard limit) */
  maxWorkflowsPerDevice: 1,

  /** Max total concurrent workflows across all devices (soft limit) */
  maxGlobalConcurrentWorkflows: envInt("MAX_CONCURRENT_WORKFLOWS", 50),

  // ── Worker pool ────────────────────────────────────────────────────────
  /** BullMQ worker concurrency — how many workflows one worker processes in parallel */
  workerConcurrency: envInt("WORKFLOW_WORKER_CONCURRENCY", 20),

  /** BullMQ lock duration (ms) — prevents false stalled detection during long steps */
  workerLockDuration: 120_000,

  /** BullMQ stalled check interval (ms) */
  workerStalledInterval: 60_000,

  // ── DB Pool ────────────────────────────────────────────────────────────
  /**
   * PostgreSQL pool max connections.
   * Formula: workerConcurrency + apiHandlers + adminReserve
   * - workerConcurrency: each workflow may hold 1-2 DB connections during checkpoint
   * - apiHandlers: ~10 for HTTP API requests
   * - adminReserve: 5 for monitoring, migrations, etc.
   */
  dbPoolMax: envInt("DB_POOL_MAX", 50),
  /** Statement timeout (ms) — kills any query that runs too long */
  dbStatementTimeout: 15_000,
  /** Connection timeout (ms) — how long to wait for a pool connection */
  dbConnectionTimeout: 5_000,
  /** Idle timeout (ms) — recycle idle connections */
  dbIdleTimeout: 30_000,

  // ── HTTP ───────────────────────────────────────────────────────────────
  /** Global request timeout (ms) — hard deadline for any HTTP request */
  requestTimeout: envInt("REQUEST_TIMEOUT_MS", 30_000),

  /** Rate limit: max requests per minute per client */
  rateLimitPerMinute: envInt("RATE_LIMIT_PER_MINUTE", 200),

  // ── WebSocket ──────────────────────────────────────────────────────────
  /** Max WebSocket connections (hard limit — rejects new connections above this) */
  maxWsConnections: envInt("MAX_WS_CONNECTIONS", 150),
  /** Auth timeout for new WS connections (ms) */
  wsAuthTimeout: 30_000,
  /** PONG timeout — consider connection dead after this (ms) */
  wsPongTimeout: 90_000,
  /** PING interval (ms) */
  wsPingInterval: 30_000,
  /** Rate limit: messages per second per device */
  wsRateLimitPerSecond: 20,
  /** Max message size (bytes) */
  wsMaxMessageSize: 5 * 1024 * 1024, // 5MB

  // ── Workflow Executor ──────────────────────────────────────────────────
  /** Default timeout for JOB_RESULT from device (ms) */
  jobResultTimeout: 300_000, // 5 min
  /** Timeout for queue.add() — prevents blocking HTTP handler (ms) */
  enqueueTimeout: 5_000,
  /** Timeout for DB reads during cancel checks (ms) */
  cancelCheckTimeout: 5_000,

  // ── Queue ──────────────────────────────────────────────────────────────
  /** Workflow queue name */
  workflowQueueName: "workflow_execute",
  /** Max retry attempts for failed workflows */
  workflowMaxRetries: 3,
  /** Backoff delay base for retries (ms) */
  workflowRetryBackoff: 5_000,

  // ── Graceful degradation ───────────────────────────────────────────────
  /**
   * When active workflows >= 80% of maxGlobalConcurrentWorkflows,
   * new workflows get queued with a warning instead of rejected.
   */
  degradationThreshold: 0.8,
} as const;

export type ScalabilityConfig = typeof scalabilityConfig;
