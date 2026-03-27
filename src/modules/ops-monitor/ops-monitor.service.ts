/**
 * ops-monitor/ops-monitor.service.ts
 * Fleet health monitoring (P3)
 * 
 * Spawned by Kraken:
 * - Hourly cron
 * - Threshold trigger (fail rate > 30%)
 */

import { getDb } from '../../db/client';
import {
  OpsMonitorConfig,
  DEFAULT_CONFIG,
  UIMetrics,
  DeviceMetrics,
  AccountMetrics,
  MappingMetrics,
  Alert,
  OpsMonitorReport,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export async function runOpsMonitor(config: Partial<OpsMonitorConfig> = {}): Promise<OpsMonitorReport> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const db = getDb();
  const runAt = new Date();
  const alerts: Alert[] = [];
  
  console.log(`[ops-monitor] Starting health check (lookback: ${cfg.lookback_hours}h)`);
  
  // ─── 1. Collect UI Metrics ──────────────────────────────────────────────────
  const uiMetrics = await collectUIMetrics(db, cfg.lookback_hours);
  
  // Check vision fallback rates
  for (const m of uiMetrics) {
    if (m.vision_fallback_rate >= cfg.vision_fallback_critical) {
      alerts.push({
        type: 'vision_fallback_critical',
        severity: 'critical',
        entity_type: 'app',
        entity_id: m.app,
        message: `Vision fallback rate ${(m.vision_fallback_rate * 100).toFixed(1)}% exceeds critical threshold`,
        metric_value: m.vision_fallback_rate,
        threshold: cfg.vision_fallback_critical,
        created_at: runAt,
      });
    } else if (m.vision_fallback_rate >= cfg.vision_fallback_warning) {
      alerts.push({
        type: 'vision_fallback_warning',
        severity: 'warning',
        entity_type: 'app',
        entity_id: m.app,
        message: `Vision fallback rate ${(m.vision_fallback_rate * 100).toFixed(1)}% exceeds warning threshold`,
        metric_value: m.vision_fallback_rate,
        threshold: cfg.vision_fallback_warning,
        created_at: runAt,
      });
    }
  }
  
  // ─── 2. Collect Device Metrics ──────────────────────────────────────────────
  const deviceMetrics = await collectDeviceMetrics(db);
  
  // Check offline devices
  for (const d of deviceMetrics) {
    if (d.minutes_offline >= cfg.device_offline_critical_min) {
      alerts.push({
        type: 'device_offline_critical',
        severity: 'critical',
        entity_type: 'device',
        entity_id: d.device_id,
        message: `Device ${d.friendly_name} offline for ${d.minutes_offline} minutes`,
        metric_value: d.minutes_offline,
        threshold: cfg.device_offline_critical_min,
        created_at: runAt,
      });
      d.needs_attention = true;
    } else if (d.minutes_offline >= cfg.device_offline_warning_min) {
      alerts.push({
        type: 'device_offline_warning',
        severity: 'warning',
        entity_type: 'device',
        entity_id: d.device_id,
        message: `Device ${d.friendly_name} offline for ${d.minutes_offline} minutes`,
        metric_value: d.minutes_offline,
        threshold: cfg.device_offline_warning_min,
        created_at: runAt,
      });
    }
  }
  
  // ─── 3. Collect Account Metrics ─────────────────────────────────────────────
  const accountMetrics = await collectAccountMetrics(db, cfg.lookback_hours);
  
  // Check rate limits and soft blocks
  for (const a of accountMetrics) {
    if (a.soft_block_detected) {
      alerts.push({
        type: 'soft_block_detected',
        severity: 'critical',
        entity_type: 'account',
        entity_id: a.account_id,
        message: `Account ${a.username} (${a.platform}) appears soft blocked`,
        created_at: runAt,
      });
    }
    if (a.rate_limit_hits > 0) {
      alerts.push({
        type: 'rate_limit_hit',
        severity: 'warning',
        entity_type: 'account',
        entity_id: a.account_id,
        message: `Account ${a.username} hit rate limit ${a.rate_limit_hits} times`,
        metric_value: a.rate_limit_hits,
        created_at: runAt,
      });
    }
  }
  
  // ─── 4. Collect Mapping Metrics ─────────────────────────────────────────────
  const mappingMetrics = await collectMappingMetrics(db, cfg.lookback_hours);
  
  for (const m of mappingMetrics) {
    if (m.unmapped_elements.length > 0) {
      alerts.push({
        type: 'unmapped_elements',
        severity: 'warning',
        entity_type: 'app',
        entity_id: m.app,
        message: `App ${m.app} has ${m.unmapped_elements.length} unmapped elements`,
        metric_value: m.unmapped_elements.length,
        created_at: runAt,
      });
    }
  }
  
  // ─── 5. Take Actions ────────────────────────────────────────────────────────
  const actions = {
    devices_flagged: 0,
    accounts_flagged: 0,
    skill_update_jobs_created: 0,
  };
  
  // Flag devices
  for (const d of deviceMetrics) {
    if (d.needs_attention) {
      await flagDevice(db, d.device_id, d.minutes_offline);
      actions.devices_flagged++;
    }
  }
  
  // Update device health check timestamp for all devices
  await updateDeviceHealthCheck(db);
  
  // Flag accounts
  for (const a of accountMetrics) {
    if (a.soft_block_detected || a.rate_limit_hits > 0) {
      await flagAccount(db, a.account_id, a.soft_block_detected, a.rate_limit_hits);
      actions.accounts_flagged++;
    }
  }
  
  // Create skill update jobs for critical vision fallback
  for (const m of uiMetrics) {
    if (m.vision_fallback_rate >= cfg.vision_fallback_critical) {
      await createSkillUpdateJob(db, m.app, m);
      actions.skill_update_jobs_created++;
    }
  }
  
  // ─── 6. Build Report ────────────────────────────────────────────────────────
  const report: OpsMonitorReport = {
    run_at: runAt,
    lookback_hours: cfg.lookback_hours,
    ui_metrics: uiMetrics,
    device_metrics: deviceMetrics,
    account_metrics: accountMetrics,
    mapping_metrics: mappingMetrics,
    alerts,
    actions_taken: actions,
  };
  
  console.log(`[ops-monitor] Complete. Alerts: ${alerts.length}, Actions: ${JSON.stringify(actions)}`);
  
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLLECTORS
// ═══════════════════════════════════════════════════════════════════════════════

async function collectUIMetrics(db: any, lookbackHours: number): Promise<UIMetrics[]> {
  const result = await db.query(`
    SELECT 
      app,
      COUNT(*) as total_taps,
      SUM(CASE WHEN method_used = 'coords' THEN 1 ELSE 0 END) as coords_success,
      SUM(CASE WHEN method_used = 'ui_tree' THEN 1 ELSE 0 END) as ui_tree_success,
      SUM(CASE WHEN method_used = 'vision' THEN 1 ELSE 0 END) as vision_success,
      SUM(CASE WHEN NOT verified THEN 1 ELSE 0 END) as element_not_found_count
    FROM navigation_logs
    WHERE timestamp > NOW() - INTERVAL '${lookbackHours} hours'
    GROUP BY app
  `);
  
  return result.rows.map((row: any) => {
    const total = parseInt(row.total_taps) || 1;
    const coordsFailed = total - (parseInt(row.coords_success) || 0);
    const visionUsed = (parseInt(row.ui_tree_success) || 0) + (parseInt(row.vision_success) || 0);
    
    return {
      app: row.app,
      total_taps: total,
      coords_success: parseInt(row.coords_success) || 0,
      ui_tree_success: parseInt(row.ui_tree_success) || 0,
      vision_success: parseInt(row.vision_success) || 0,
      vision_fallback_rate: coordsFailed > 0 ? visionUsed / coordsFailed : 0,
      element_not_found_count: parseInt(row.element_not_found_count) || 0,
    };
  });
}

async function collectDeviceMetrics(db: any): Promise<DeviceMetrics[]> {
  const result = await db.query(`
    SELECT 
      id as device_id,
      friendly_name,
      status,
      last_seen_at,
      EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 60 as minutes_offline
    FROM devices
    WHERE status != 'revoked'
  `);
  
  return result.rows.map((row: any) => ({
    device_id: row.device_id,
    friendly_name: row.friendly_name || 'Unknown',
    status: row.status,
    last_seen_at: row.last_seen_at,
    minutes_offline: row.status === 'online' ? 0 : Math.round(parseFloat(row.minutes_offline) || 0),
    needs_attention: false,
  }));
}

async function collectAccountMetrics(db: any, lookbackHours: number): Promise<AccountMetrics[]> {
  // Get accounts with their flags
  const result = await db.query(`
    SELECT 
      id as account_id,
      username,
      platform,
      flags
    FROM accounts
    WHERE status != 'banned'
  `);
  
  // TODO: Cross-reference with execution_logs for rate_limit_hits and app_crashes
  // For now, extract from flags
  
  return result.rows.map((row: any) => {
    const flags = row.flags || {};
    return {
      account_id: row.account_id,
      username: row.username,
      platform: row.platform,
      rate_limit_hits: flags.rate_limit_hits || 0,
      soft_block_detected: !!flags.soft_blocked_until,
      app_crashes: flags.app_crashes || 0,
    };
  });
}

async function collectMappingMetrics(db: any, lookbackHours: number): Promise<MappingMetrics[]> {
  const result = await db.query(`
    SELECT 
      app,
      app_version,
      unmapped_elements,
      elements_failed
    FROM mapping_reports
    WHERE created_at > NOW() - INTERVAL '${lookbackHours} hours'
    ORDER BY created_at DESC
  `);
  
  // Dedupe by app (keep latest)
  const byApp = new Map<string, MappingMetrics>();
  for (const row of result.rows) {
    if (!byApp.has(row.app)) {
      byApp.set(row.app, {
        app: row.app,
        app_version: row.app_version,
        unmapped_elements: row.unmapped_elements || [],
        elements_failed: row.elements_failed || 0,
      });
    }
  }
  
  return Array.from(byApp.values());
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function flagDevice(db: any, deviceId: string, minutesOffline: number): Promise<void> {
  await db.query(`
    UPDATE devices
    SET flags = flags || $1::jsonb
    WHERE id = $2
  `, [
    JSON.stringify({
      offline_since: new Date(Date.now() - minutesOffline * 60 * 1000).toISOString(),
      needs_attention: true,
    }),
    deviceId,
  ]);
  
  console.log(`[ops-monitor] Flagged device ${deviceId} (offline ${minutesOffline}min)`);
}

async function updateDeviceHealthCheck(db: any): Promise<void> {
  await db.query(`
    UPDATE devices
    SET flags = flags || '{"last_health_check": "${new Date().toISOString()}"}'::jsonb
    WHERE status != 'revoked'
  `);
}

async function flagAccount(db: any, accountId: string, softBlocked: boolean, rateLimitHits: number): Promise<void> {
  const updates: any = {};
  
  if (softBlocked) {
    // Set soft block for 24 hours
    updates.soft_blocked_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  
  if (rateLimitHits > 0) {
    // Set rate limit for 1 hour
    updates.rate_limited_until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }
  
  await db.query(`
    UPDATE accounts
    SET flags = flags || $1::jsonb
    WHERE id = $2
  `, [JSON.stringify(updates), accountId]);
  
  console.log(`[ops-monitor] Flagged account ${accountId} (soft_blocked: ${softBlocked}, rate_limits: ${rateLimitHits})`);
}

async function createSkillUpdateJob(db: any, app: string, metrics: UIMetrics): Promise<void> {
  // Check if there's already a pending job for this app
  const existing = await db.query(`
    SELECT id FROM skill_update_jobs
    WHERE app = $1 AND status = 'pending'
    LIMIT 1
  `, [app]);
  
  if (existing.rows.length > 0) {
    console.log(`[ops-monitor] Skill update job already pending for ${app}`);
    return;
  }
  
  await db.query(`
    INSERT INTO skill_update_jobs (app, elements, failure_data, status)
    VALUES ($1, $2, $3, 'pending')
  `, [
    app,
    JSON.stringify([]), // Elements to update will be determined by Skill Updater
    JSON.stringify({
      vision_fallback_rate: metrics.vision_fallback_rate,
      element_not_found_count: metrics.element_not_found_count,
      triggered_by: 'ops_monitor',
      triggered_at: new Date().toISOString(),
    }),
  ]);
  
  console.log(`[ops-monitor] Created skill update job for ${app} (vision_fallback: ${(metrics.vision_fallback_rate * 100).toFixed(1)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════════

let schedulerInterval: NodeJS.Timeout | null = null;

export function startOpsMonitorScheduler(intervalMs: number = 60 * 60 * 1000): void {
  if (schedulerInterval) {
    console.log('[ops-monitor] Scheduler already running');
    return;
  }
  
  console.log(`[ops-monitor] Starting scheduler (interval: ${intervalMs / 1000 / 60} min)`);
  
  // Run immediately
  runOpsMonitor().catch(err => console.error('[ops-monitor] Error:', err));
  
  // Schedule hourly runs
  schedulerInterval = setInterval(() => {
    runOpsMonitor().catch(err => console.error('[ops-monitor] Error:', err));
  }, intervalMs);
}

export function stopOpsMonitorScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[ops-monitor] Scheduler stopped');
  }
}
