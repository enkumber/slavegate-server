/**
 * workflows/screen-verifier.ts
 * Screen verification after workflow steps.
 * 
 * Story: US-WORKFLOW-SCREEN-VERIFY
 * 
 * Integrates Screen Detection Cascade with Workflow Executor
 * to verify device landed on expected screen after each action.
 */

import { screenDetectionService } from '../screen-detection/screen-detection.service';
import type { ScreenId, DetectedScreen } from '../screen-detection/types';
import { getDb } from '../../db/client';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ScreenMismatchPolicy {
  /** How many times to retry the step on mismatch */
  maxRetries: number;
  /** Delay before retry in ms */
  delayMs: number;
  /** What to do on mismatch */
  action: 'retry_step' | 'abort' | 'continue_with_warning';
}

export interface ScreenVerificationResult {
  /** Whether detected screen matches expected */
  match: boolean;
  /** Full detection result from cascade */
  detected: DetectedScreen;
  /** What we expected */
  expected: ScreenId | ScreenId[];
  /** Whether confidence threshold was met */
  confidenceMet: boolean;
  /** Should executor retry the step */
  shouldRetry: boolean;
  /** Should executor abort the workflow */
  shouldAbort: boolean;
  /** Verification latency (total, including detection) */
  totalLatencyMs: number;
}

export interface VerifyScreenParams {
  deviceId: string;
  platform: string;
  workflowId: string;
  stepIndex: number;
  expectedScreen: ScreenId | ScreenId[];
  confidenceThreshold?: number;
  policy?: ScreenMismatchPolicy;
  currentRetry?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_POLICY: ScreenMismatchPolicy = {
  maxRetries: 2,
  delayMs: 500,
  action: 'retry_step',
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN VERIFICATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify that device is on expected screen after a workflow step.
 * Uses Screen Detection Cascade (L1 → L2 → L3) for detection.
 * 
 * @returns ScreenVerificationResult with match status and action flags
 */
export async function verifyScreenAfterStep(
  params: VerifyScreenParams
): Promise<ScreenVerificationResult> {
  const {
    deviceId,
    platform,
    workflowId,
    stepIndex,
    expectedScreen,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    policy = DEFAULT_POLICY,
    currentRetry = 0,
  } = params;

  const start = Date.now();

  // Clear cache to ensure fresh detection
  screenDetectionService.clearCache(deviceId);

  // Run cascade detection
  let detected: DetectedScreen;
  try {
    detected = await screenDetectionService.detectScreen({
      deviceId,
      platform,
      // Total budget: 20s — accounts for device job queue contention under concurrent workflows
      // L1: up to 8s (ui_tree_dump), L2: up to 5s (ocr_full), L3: up to 5s (screenshot + VLM)
      // Previously 5_000 — too small; device queue serializes jobs from multiple concurrent workflows
      timeoutMs: 20_000,
      skipCache: true,
    });
  } catch (err) {
    // Detection failed entirely — treat as mismatch
    console.error(`[screen-verify] Detection failed: ${(err as Error).message}`);
    detected = {
      screenId: 'UNKNOWN',
      confidence: 0,
      method: 'ui_tree',
      markers: ['detection_error'],
      navBar: { visible: false, selectedTab: null },
      overlays: [],
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }

  const totalLatencyMs = Date.now() - start;

  // Check match
  const expectedArray = Array.isArray(expectedScreen) ? expectedScreen : [expectedScreen];
  const screenMatches = expectedArray.includes(detected.screenId);
  const confidenceMet = detected.confidence >= confidenceThreshold;
  const match = screenMatches && confidenceMet;

  // Build result
  const result: ScreenVerificationResult = {
    match,
    detected,
    expected: expectedScreen,
    confidenceMet,
    shouldRetry: false,
    shouldAbort: false,
    totalLatencyMs,
  };

  // Determine action on mismatch
  if (!match) {
    if (policy.action === 'retry_step' && currentRetry < policy.maxRetries) {
      result.shouldRetry = true;
    } else if (policy.action === 'abort') {
      result.shouldAbort = true;
    } else if (policy.action === 'retry_step' && currentRetry >= policy.maxRetries) {
      // Exhausted retries — abort
      result.shouldAbort = true;
    }
    // 'continue_with_warning' leaves both false — executor continues
  }

  // Log for observability
  const logLevel = match ? 'log' : 'warn';
  console[logLevel](
    `[screen-verify] ${workflowId} step ${stepIndex}: ` +
    `detected=${detected.screenId} (conf=${detected.confidence.toFixed(2)}), ` +
    `expected=[${expectedArray.join(',')}], match=${match}, ` +
    `method=${detected.method}, latency=${detected.latencyMs}ms, ` +
    `retry=${currentRetry}/${policy.maxRetries}`
  );

  // Persist to DB (fire-and-forget)
  logVerificationToDb(workflowId, stepIndex, detected, expectedArray, match, totalLatencyMs).catch(
    (err) => console.warn(`[screen-verify] DB log failed: ${(err as Error).message}`)
  );

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DB LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

async function logVerificationToDb(
  workflowId: string,
  stepIndex: number,
  detected: DetectedScreen,
  expected: ScreenId[],
  match: boolean,
  totalLatencyMs: number
): Promise<void> {
  const db = getDb();
  
  await db.query(
    `INSERT INTO workflow_screen_verifications
       (workflow_id, step_index, detected_screen, detected_confidence, 
        detection_method, expected_screens, match, latency_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      workflowId,
      stepIndex,
      detected.screenId,
      detected.confidence,
      detected.method,
      expected,
      match,
      totalLatencyMs,
    ]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get verification stats for a workflow.
 * Useful for observability dashboards.
 */
export async function getVerificationStats(
  workflowId: string
): Promise<{
  total: number;
  matches: number;
  matchRate: number;
  avgLatencyMs: number;
  methodBreakdown: Record<string, number>;
}> {
  const db = getDb();
  
  const result = await db.query(
    `SELECT 
       COUNT(*) as total,
       SUM(CASE WHEN match THEN 1 ELSE 0 END) as matches,
       AVG(latency_ms) as avg_latency,
       detection_method,
       COUNT(*) as method_count
     FROM workflow_screen_verifications
     WHERE workflow_id = $1
     GROUP BY detection_method`,
    [workflowId]
  );

  if (result.rows.length === 0) {
    return { total: 0, matches: 0, matchRate: 0, avgLatencyMs: 0, methodBreakdown: {} };
  }

  const total = result.rows.reduce((sum, r) => sum + parseInt(r.total), 0);
  const matches = result.rows.reduce((sum, r) => sum + parseInt(r.matches), 0);
  const avgLatency = result.rows.reduce((sum, r) => sum + parseFloat(r.avg_latency) * parseInt(r.total), 0) / total;
  
  const methodBreakdown: Record<string, number> = {};
  for (const row of result.rows) {
    methodBreakdown[row.detection_method] = parseInt(row.method_count);
  }

  return {
    total,
    matches,
    matchRate: total > 0 ? (matches / total) * 100 : 0,
    avgLatencyMs: avgLatency,
    methodBreakdown,
  };
}

/**
 * Get global verification stats for observability.
 */
export async function getGlobalVerificationStats(
  days: number = 7
): Promise<{
  total: number;
  matchRate: number;
  avgLatencyMs: number;
  byMethod: Record<string, { count: number; matchRate: number }>;
}> {
  const db = getDb();
  
  const result = await db.query(
    `SELECT 
       detection_method,
       COUNT(*) as total,
       SUM(CASE WHEN match THEN 1 ELSE 0 END) as matches,
       AVG(latency_ms) as avg_latency
     FROM workflow_screen_verifications
     WHERE created_at > NOW() - INTERVAL '${days} days'
     GROUP BY detection_method`,
    []
  );

  if (result.rows.length === 0) {
    return { total: 0, matchRate: 0, avgLatencyMs: 0, byMethod: {} };
  }

  const total = result.rows.reduce((sum, r) => sum + parseInt(r.total), 0);
  const matches = result.rows.reduce((sum, r) => sum + parseInt(r.matches), 0);
  const avgLatency = result.rows.reduce((sum, r) => sum + parseFloat(r.avg_latency) * parseInt(r.total), 0) / total;

  const byMethod: Record<string, { count: number; matchRate: number }> = {};
  for (const row of result.rows) {
    const count = parseInt(row.total);
    const rowMatches = parseInt(row.matches);
    byMethod[row.detection_method] = {
      count,
      matchRate: count > 0 ? (rowMatches / count) * 100 : 0,
    };
  }

  return {
    total,
    matchRate: total > 0 ? (matches / total) * 100 : 0,
    avgLatencyMs: avgLatency,
    byMethod,
  };
}
