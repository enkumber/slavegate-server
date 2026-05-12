/**
 * business-analyst/ba.service.ts
 * Business Analyst agent logic (P6)
 * 
 * Spawned by Nautilus at 02:25 (pre-nightly).
 * Analyzes account performance, generates reports, updates flags.
 */

import { getDb } from '../../../db/client';
import {
  BAConfig,
  DEFAULT_CONFIG,
  AccountData,
  ExecutionLogEntry,
  AccountAnalysis,
  HealthStatus,
  BAReport,
  BAAlert,
  BAResult,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export async function runBusinessAnalyst(config: Partial<BAConfig> = {}): Promise<BAResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const db = getDb();
  
  console.log(`[BA] Starting analysis (lookback: ${cfg.lookback_hours}h)`);
  
  try {
    // ─── 1. Collect Data ──────────────────────────────────────────────────────
    const accounts = await getAccounts(db);
    const execLogs = await getExecutionLogs(db, cfg.lookback_hours);
    
    if (accounts.length === 0) {
      return {
        success: true,
        summary: 'No accounts to analyze',
        accounts_analyzed: 0,
        flags_updated: 0,
        duration_ms: Date.now() - startTime,
      };
    }
    
    // ─── 2. Analyze Each Account ──────────────────────────────────────────────
    const analyses: AccountAnalysis[] = [];
    
    for (const account of accounts) {
      const accountLogs = execLogs.filter(l => l.account_id === account.id);
      const analysis = analyzeAccount(account, accountLogs, cfg);
      analyses.push(analysis);
    }
    
    // ─── 3. Build Report ──────────────────────────────────────────────────────
    const report = buildReport(analyses, cfg.lookback_hours);
    
    // ─── 4. Save Report ───────────────────────────────────────────────────────
    const reportId = await saveReport(db, report);
    
    // ─── 5. Update Account Flags ──────────────────────────────────────────────
    let flagsUpdated = 0;
    for (const analysis of analyses) {
      const updated = await updateAccountFlags(db, analysis);
      if (updated) flagsUpdated++;
    }
    
    // ─── 6. Build Summary ─────────────────────────────────────────────────────
    const summary = `Analyzed ${accounts.length} accounts: ${report.summary.healthy} healthy, ${report.summary.warning} warning, ${report.summary.critical} critical`;
    
    console.log(`[BA] Complete: ${summary}`);
    
    return {
      success: true,
      report_id: reportId,
      summary,
      accounts_analyzed: accounts.length,
      flags_updated: flagsUpdated,
      duration_ms: Date.now() - startTime,
    };
    
  } catch (err) {
    console.error('[BA] Error:', err);
    return {
      success: false,
      summary: 'Analysis failed',
      accounts_analyzed: 0,
      flags_updated: 0,
      duration_ms: Date.now() - startTime,
      error: (err as Error).message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

async function getAccounts(db: any): Promise<AccountData[]> {
  const result = await db.query(`
    SELECT id, username, platform, client_id, type, status, metrics, flags, device_id, created_at, updated_at
    FROM accounts
    WHERE status NOT IN ('banned', 'deleted')
    ORDER BY updated_at DESC
  `);
  
  return result.rows;
}

async function getExecutionLogs(db: any, lookbackHours: number): Promise<ExecutionLogEntry[]> {
  const result = await db.query(`
    SELECT id, account_id, task_type, success, error, created_at
    FROM execution_logs
    WHERE created_at > NOW() - INTERVAL '${lookbackHours} hours'
    ORDER BY created_at DESC
  `);
  
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeAccount(
  account: AccountData,
  logs: ExecutionLogEntry[],
  cfg: BAConfig
): AccountAnalysis {
  // Calculate success rate
  const totalActions = logs.length;
  const successfulActions = logs.filter(l => l.success).length;
  const successRate = totalActions > 0 ? successfulActions / totalActions : 1;
  
  // Check flags
  const now = new Date();
  const rateLimitActive = account.flags?.rate_limited_until 
    ? new Date(account.flags.rate_limited_until) > now 
    : false;
  const softBlockActive = account.flags?.soft_blocked_until 
    ? new Date(account.flags.soft_blocked_until) > now 
    : false;
  
  // Collect recent errors
  const recentErrors = logs
    .filter(l => !l.success && l.error)
    .slice(0, 5)
    .map(l => l.error!);
  
  // Determine engagement trend
  const metrics = account.metrics || {};
  let engagementTrend: 'up' | 'stable' | 'down' | 'unknown' = 'unknown';
  if (metrics.growth_7d !== undefined) {
    if (metrics.growth_7d > 0.05) engagementTrend = 'up';
    else if (metrics.growth_7d < -0.05) engagementTrend = 'down';
    else engagementTrend = 'stable';
  }
  
  // Classify health status
  let healthStatus: HealthStatus = 'healthy';
  const recommendations: string[] = [];
  
  if (account.status === 'suspended') {
    healthStatus = 'suspended';
    recommendations.push('Account suspended - manual intervention required');
  } else if (softBlockActive) {
    healthStatus = 'critical';
    recommendations.push('Soft block active - reduce activity');
  } else if (successRate < cfg.thresholds.warning_success_rate) {
    healthStatus = 'critical';
    recommendations.push('Very low success rate - check for UI changes or blocks');
  } else if (rateLimitActive || successRate < cfg.thresholds.healthy_success_rate) {
    healthStatus = 'warning';
    if (rateLimitActive) recommendations.push('Rate limit active - slow down');
    if (successRate < cfg.thresholds.healthy_success_rate) {
      recommendations.push('Success rate below healthy threshold');
    }
  }
  
  // Additional recommendations
  if (totalActions === 0) {
    recommendations.push('No activity in analysis period');
  }
  if (engagementTrend === 'down') {
    recommendations.push('Engagement trending down - review content strategy');
  }
  
  return {
    account_id: account.id,
    username: account.username,
    platform: account.platform,
    client_id: account.client_id,
    total_actions: totalActions,
    successful_actions: successfulActions,
    success_rate: successRate,
    rate_limit_active: rateLimitActive,
    soft_block_active: softBlockActive,
    recent_errors: recentErrors,
    engagement_trend: engagementTrend,
    health_status: healthStatus,
    recommendations,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════

function buildReport(analyses: AccountAnalysis[], lookbackHours: number): BAReport {
  const now = new Date();
  const periodStart = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  
  // Count by health status
  const healthy = analyses.filter(a => a.health_status === 'healthy').length;
  const warning = analyses.filter(a => a.health_status === 'warning').length;
  const critical = analyses.filter(a => a.health_status === 'critical').length;
  const suspended = analyses.filter(a => a.health_status === 'suspended').length;
  
  // Calculate overall stats
  const totalActions = analyses.reduce((sum, a) => sum + a.total_actions, 0);
  const successfulActions = analyses.reduce((sum, a) => sum + a.successful_actions, 0);
  const overallSuccessRate = totalActions > 0 ? successfulActions / totalActions : 1;
  
  // Find top performers and problems
  const sorted = [...analyses].sort((a, b) => b.success_rate - a.success_rate);
  const topPerformers = sorted
    .filter(a => a.health_status === 'healthy')
    .slice(0, 5)
    .map(a => a.username);
  const needsAttention = sorted
    .filter(a => a.health_status === 'critical' || a.health_status === 'suspended')
    .map(a => a.username);
  
  // Generate alerts
  const alerts: BAAlert[] = [];
  
  if (overallSuccessRate < 0.7) {
    alerts.push({
      severity: 'critical',
      message: `Overall success rate is ${(overallSuccessRate * 100).toFixed(1)}%`,
      action_required: 'Review system health and skill files',
    });
  }
  
  for (const analysis of analyses) {
    if (analysis.soft_block_active) {
      alerts.push({
        severity: 'critical',
        account_id: analysis.account_id,
        message: `${analysis.username} is soft blocked`,
        action_required: 'Pause activity, wait 24-48h',
      });
    }
  }
  
  if (critical > analyses.length * 0.3) {
    alerts.push({
      severity: 'warning',
      message: `${critical} accounts (${((critical / analyses.length) * 100).toFixed(0)}%) are in critical state`,
      action_required: 'Review platform changes or rate limits',
    });
  }
  
  return {
    type: 'daily_performance',
    period_start: periodStart,
    period_end: now,
    summary: {
      total_accounts: analyses.length,
      healthy,
      warning,
      critical,
      suspended,
      total_actions: totalActions,
      overall_success_rate: overallSuccessRate,
      top_performers: topPerformers,
      needs_attention: needsAttention,
    },
    accounts: analyses,
    alerts,
    created_at: now,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

async function saveReport(db: any, report: BAReport): Promise<string> {
  const result = await db.query(`
    INSERT INTO reports (type, data, period_start, period_end)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [
    report.type,
    JSON.stringify({
      summary: report.summary,
      accounts: report.accounts,
      alerts: report.alerts,
    }),
    report.period_start,
    report.period_end,
  ]);
  
  return result.rows[0].id;
}

async function updateAccountFlags(db: any, analysis: AccountAnalysis): Promise<boolean> {
  const updates: any = {
    ba_reviewed_at: new Date().toISOString(),
  };
  
  if (analysis.health_status === 'critical' || analysis.health_status === 'suspended') {
    updates.needs_attention = true;
    updates.last_issue = analysis.recommendations[0] || 'Critical health status';
  } else {
    updates.needs_attention = false;
  }
  
  const result = await db.query(`
    UPDATE accounts
    SET flags = COALESCE(flags, '{}'::jsonb) || $1::jsonb,
        updated_at = NOW()
    WHERE id = $2
  `, [JSON.stringify(updates), analysis.account_id]);
  
  return result.rowCount > 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { BAConfig, BAReport, BAResult, AccountAnalysis };
