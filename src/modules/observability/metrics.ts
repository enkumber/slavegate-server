/**
 * observability/metrics.ts
 * Prometheus metrics for Phone Network server.
 *
 * Dependency: prom-client@15 (add to package.json, run npm install)
 * Exposed at GET /metrics (Prometheus scrape endpoint, no auth — firewall in prod).
 *
 * Namespaces:
 *   phone_network_workflow_*   — workflow execution stats
 *   phone_network_job_*        — individual job dispatch/result
 *   phone_network_device_*     — device connectivity and health
 *   phone_network_parser_*     — data pipeline extraction quality
 *   phone_network_vlm_*        — VLM token cost and latency
 *   phone_network_account_*    — account lifecycle events
 */

/* eslint-disable @typescript-eslint/no-var-requires */
// Dynamic require: prom-client may not be installed in dev without npm install.
// In production: always installed (listed in package.json dependencies).
// TS type: use any to avoid missing type declarations before npm install.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let promClient: any = null;
try {
  promClient = require("prom-client");
} catch {
  console.warn("[metrics] prom-client not installed — metrics disabled. Run: npm install prom-client");
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const registry = promClient ? new promClient.Registry() : null;
if (promClient && registry) {
  registry.setDefaultLabels({ service: "phone-network" });
  promClient.collectDefaultMetrics({ register: registry });
}

// ─── Metric factory helpers ───────────────────────────────────────────────────

type LabelNames = readonly string[];

function makeCounter(opts: { name: string; help: string; labelNames: LabelNames }) {
  if (!promClient || !registry) return null;
  return new promClient.Counter({ ...opts, registers: [registry] });
}
function makeHistogram(opts: { name: string; help: string; labelNames: LabelNames; buckets: number[] }) {
  if (!promClient || !registry) return null;
  return new promClient.Histogram({ ...opts, registers: [registry] });
}
function makeGauge(opts: { name: string; help: string; labelNames: LabelNames }) {
  if (!promClient || !registry) return null;
  return new promClient.Gauge({ ...opts, registers: [registry] });
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const workflowTotal      = makeCounter({ name: "phone_network_workflow_total",           help: "Total workflows started",              labelNames: ["template", "device_id"] });
export const workflowCompleted  = makeCounter({ name: "phone_network_workflow_completed_total", help: "Workflows completed successfully",      labelNames: ["template"] });
export const workflowFailed     = makeCounter({ name: "phone_network_workflow_failed_total",    help: "Workflows failed",                      labelNames: ["template", "reason"] });
export const workflowDuration   = makeHistogram({ name: "phone_network_workflow_duration_seconds", help: "Workflow execution duration", labelNames: ["template"], buckets: [30, 60, 120, 300, 600, 1800] });

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export const jobDispatched = makeCounter({ name: "phone_network_job_dispatched_total", help: "Jobs dispatched to devices",      labelNames: ["action", "device_id", "platform"] });
export const jobSuccess    = makeCounter({ name: "phone_network_job_success_total",    help: "Jobs completed successfully",     labelNames: ["action", "verification_level"] });
export const jobFailed     = makeCounter({ name: "phone_network_job_failed_total",     help: "Jobs failed",                     labelNames: ["action", "reason"] });
export const jobLatency    = makeHistogram({ name: "phone_network_job_latency_seconds", help: "Job round-trip latency", labelNames: ["action"], buckets: [0.5, 1, 2, 5, 10, 30] });

// ─── Devices ──────────────────────────────────────────────────────────────────

export const devicesConnected    = makeGauge({ name: "phone_network_devices_connected",      help: "Currently connected devices", labelNames: [] });
export const deviceOfflineEvents = makeCounter({ name: "phone_network_device_offline_total", help: "Device disconnect events",    labelNames: ["device_id", "location"] });
export const deviceBatteryLevel  = makeGauge({ name: "phone_network_device_battery_percent", help: "Device battery level %",     labelNames: ["device_id"] });
export const deviceMemoryUsage   = makeGauge({ name: "phone_network_device_memory_mb",       help: "Device available memory MB", labelNames: ["device_id"] });

// ─── Parser ───────────────────────────────────────────────────────────────────

export const parserExtracted  = makeCounter({ name: "phone_network_parser_extracted_total",  help: "Content items extracted",           labelNames: ["platform", "content_type", "parser_version"] });
export const parserDuplicates = makeCounter({ name: "phone_network_parser_duplicates_total", help: "Duplicate items skipped",           labelNames: ["platform"] });
export const parserConfidence = makeHistogram({ name: "phone_network_parser_confidence",     help: "Extraction confidence scores",      labelNames: ["platform", "parser_version"], buckets: [0.3, 0.5, 0.65, 0.75, 0.85, 0.9, 0.95, 1.0] });

// ─── VLM ──────────────────────────────────────────────────────────────────────

export const vlmRequests  = makeCounter({ name: "phone_network_vlm_requests_total",   help: "VLM API requests made",     labelNames: ["provider", "request_type", "device_id"] });
export const vlmTokensUsed = makeCounter({ name: "phone_network_vlm_tokens_total",   help: "VLM tokens consumed",       labelNames: ["provider", "device_id"] });
export const vlmLatency   = makeHistogram({ name: "phone_network_vlm_latency_seconds", help: "VLM API call latency",    labelNames: ["provider"], buckets: [0.5, 1, 2, 5, 10, 15, 30] });
export const vlmErrors    = makeCounter({ name: "phone_network_vlm_errors_total",     help: "VLM API errors",           labelNames: ["provider", "error_type"] });

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const accountsByStatus = makeGauge({ name: "phone_network_accounts_by_status",      help: "Account count by status",          labelNames: ["platform", "status"] });
export const accountBanned    = makeCounter({ name: "phone_network_account_banned_total",  help: "Accounts banned",                  labelNames: ["platform", "reason"] });
export const accountChallenged = makeCounter({ name: "phone_network_account_challenged_total", help: "Accounts challenged",          labelNames: ["platform"] });

// ─── Kill switch ──────────────────────────────────────────────────────────────
/** 1 = active, 0 = inactive — used by Alertmanager rule KillSwitchActivated */
export const killSwitchActive = makeGauge({ name: "phone_network_kill_switch_active", help: "Kill switch state (1=active)", labelNames: [] });

// ─── Detection events ─────────────────────────────────────────────────────────
export const detectionEvents     = makeCounter({ name: "phone_network_detection_events_total", help: "Anti-detection events by type", labelNames: ["device_id", "event_type"] });
export const parserConfidenceAvg = makeGauge({   name: "phone_network_parser_confidence_avg",  help: "Parser avg confidence per platform", labelNames: ["platform"] });

// ─── Device last-seen timestamp (for Alertmanager DeviceOffline rule) ──────────
/** Unix timestamp (seconds) of last heartbeat per device. Used in prometheus rule:
 *  time() - phone_network_device_last_seen_seconds > 300 → DeviceOffline alert */
export const deviceLastSeen = makeGauge({ name: "phone_network_device_last_seen_seconds", help: "Unix timestamp of last device heartbeat", labelNames: ["device_id"] });

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function recordDeviceHealth(deviceId: string, health: {
  batteryLevel?: number;
  memoryAvailableMb?: number;
}): void {
  if (health.batteryLevel != null) deviceBatteryLevel?.labels(deviceId).set(health.batteryLevel);
  if (health.memoryAvailableMb != null) deviceMemoryUsage?.labels(deviceId).set(health.memoryAvailableMb);
  deviceLastSeen?.labels(deviceId).set(Math.floor(Date.now() / 1000));
}

export async function refreshAccountMetrics(db: { query: Function }): Promise<void> {
  if (!accountsByStatus) return;
  try {
    const rows = await db.query("SELECT platform, status, COUNT(*) AS count FROM accounts GROUP BY platform, status");
    accountsByStatus.reset();
    for (const row of rows.rows) {
      accountsByStatus.labels(row.platform, row.status).set(parseInt(row.count, 10));
    }
  } catch { /* non-fatal */ }
}
