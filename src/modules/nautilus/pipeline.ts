/**
 * nautilus/pipeline.ts
 * Nautilus nightly pipeline orchestration (P10)
 * 
 * Runs the full marketing pipeline:
 * 02:25 → BA → 03:00 → Marketer → 03:45 → Siren → 04:45 → Tactician
 */

import { runBusinessAnalyst, BAResult } from '../marketing-agents/business-analyst';
import { runMarketer, MarketerResult } from '../marketing-agents/marketer';
import { runSiren, SirenResult } from '../marketing-agents/siren';
import { runTactician, TacticianResult } from '../marketing-agents/tactician';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PipelineConfig {
  skip_ba?: boolean;
  skip_marketer?: boolean;
  skip_siren?: boolean;
  skip_tactician?: boolean;
  stop_on_error?: boolean;
}

export interface PipelineResult {
  success: boolean;
  started_at: Date;
  completed_at: Date;
  duration_ms: number;
  
  phases: {
    ba?: BAResult;
    marketer?: MarketerResult;
    siren?: SirenResult;
    tactician?: TacticianResult;
  };
  
  summary: string;
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

export async function runNightlyPipeline(config: PipelineConfig = {}): Promise<PipelineResult> {
  const startedAt = new Date();
  const errors: string[] = [];
  const phases: PipelineResult['phases'] = {};
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('[Nautilus] Starting nightly pipeline');
  console.log('═══════════════════════════════════════════════════════════════');
  
  try {
    // ─── Phase 1: Business Analyst ────────────────────────────────────────────
    if (!config.skip_ba) {
      console.log('\n[Nautilus] Phase 1: Business Analyst');
      console.log('───────────────────────────────────────');
      
      phases.ba = await runBusinessAnalyst();
      
      if (!phases.ba.success) {
        errors.push(`BA failed: ${phases.ba.error}`);
        if (config.stop_on_error) throw new Error(phases.ba.error);
      }
      
      console.log(`[Nautilus] BA: ${phases.ba.summary}`);
    }
    
    // ─── Phase 2: Marketer ────────────────────────────────────────────────────
    if (!config.skip_marketer) {
      console.log('\n[Nautilus] Phase 2: Marketer');
      console.log('───────────────────────────────────────');
      
      phases.marketer = await runMarketer();
      
      if (!phases.marketer.success) {
        errors.push(`Marketer failed: ${phases.marketer.error}`);
        if (config.stop_on_error) throw new Error(phases.marketer.error);
      }
      
      console.log(`[Nautilus] Marketer: ${phases.marketer.summary}`);
    }
    
    // ─── Phase 3: Siren ───────────────────────────────────────────────────────
    if (!config.skip_siren) {
      console.log('\n[Nautilus] Phase 3: Siren');
      console.log('───────────────────────────────────────');
      
      phases.siren = await runSiren();
      
      if (!phases.siren.success) {
        errors.push(`Siren failed: ${phases.siren.error}`);
        if (config.stop_on_error) throw new Error(phases.siren.error);
      }
      
      console.log(`[Nautilus] Siren: ${phases.siren.summary}`);
    }
    
    // ─── Phase 4: Tactician ───────────────────────────────────────────────────
    if (!config.skip_tactician) {
      console.log('\n[Nautilus] Phase 4: Tactician');
      console.log('───────────────────────────────────────');
      
      phases.tactician = await runTactician();
      
      if (!phases.tactician.success) {
        errors.push(`Tactician failed: ${phases.tactician.error}`);
        if (config.stop_on_error) throw new Error(phases.tactician.error);
      }
      
      console.log(`[Nautilus] Tactician: ${phases.tactician.summary}`);
    }
    
  } catch (err) {
    errors.push((err as Error).message);
  }
  
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();
  
  // Build summary
  const summaryParts: string[] = [];
  if (phases.ba) summaryParts.push(`BA: ${phases.ba.accounts_analyzed} accounts`);
  if (phases.marketer) summaryParts.push(`Marketer: ${phases.marketer.accounts_updated} strategies`);
  if (phases.siren) summaryParts.push(`Siren: ${phases.siren.posts_created} posts`);
  if (phases.tactician) summaryParts.push(`Tactician: ${phases.tactician.tasks_created} tasks`);
  
  const summary = summaryParts.join(' | ') || 'No phases executed';
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`[Nautilus] Pipeline complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`[Nautilus] ${summary}`);
  if (errors.length > 0) {
    console.log(`[Nautilus] Errors: ${errors.join(', ')}`);
  }
  console.log('═══════════════════════════════════════════════════════════════');
  
  return {
    success: errors.length === 0,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    phases,
    summary,
    errors,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL PHASE RUNNERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function runPhase(phase: 'ba' | 'marketer' | 'siren' | 'tactician'): Promise<any> {
  switch (phase) {
    case 'ba':
      return runBusinessAnalyst();
    case 'marketer':
      return runMarketer();
    case 'siren':
      return runSiren();
    case 'tactician':
      return runTactician();
    default:
      throw new Error(`Unknown phase: ${phase}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MORNING BRIEFING
// ═══════════════════════════════════════════════════════════════════════════════

export interface MorningBriefing {
  date: string;
  accounts: {
    total: number;
    healthy: number;
    warning: number;
    critical: number;
  };
  tasks_today: number;
  posts_pending_review: number;
  alerts: string[];
}

export async function generateMorningBriefing(db: any): Promise<MorningBriefing> {
  // Get latest report
  const reportResult = await db.query(`
    SELECT data FROM reports 
    WHERE type = 'daily_performance'
    ORDER BY created_at DESC LIMIT 1
  `);
  
  const reportData = reportResult.rows[0]?.data || { summary: {} };
  
  // Get today's tasks
  const tasksResult = await db.query(`
    SELECT COUNT(*) as count FROM tasks
    WHERE scheduled_for::date = CURRENT_DATE
    AND status = 'pending'
  `);
  
  // Get pending review posts
  const postsResult = await db.query(`
    SELECT COUNT(*) as count FROM posts
    WHERE status = 'pending_review'
  `);
  
  // Get critical alerts
  const alertsResult = await db.query(`
    SELECT username, platform FROM accounts
    WHERE flags->>'needs_attention' = 'true'
    LIMIT 5
  `);
  
  const alerts = alertsResult.rows.map((r: any) => 
    `${r.username} (${r.platform}) needs attention`
  );
  
  return {
    date: new Date().toISOString().split('T')[0],
    accounts: {
      total: reportData.summary?.total_accounts || 0,
      healthy: reportData.summary?.healthy || 0,
      warning: reportData.summary?.warning || 0,
      critical: reportData.summary?.critical || 0,
    },
    tasks_today: parseInt(tasksResult.rows[0]?.count) || 0,
    posts_pending_review: parseInt(postsResult.rows[0]?.count) || 0,
    alerts,
  };
}

export function formatBriefingMessage(briefing: MorningBriefing): string {
  const lines = [
    `📊 **Morning Briefing** — ${briefing.date}`,
    '',
    `**Accounts:** ${briefing.accounts.total} total`,
    `  ✅ ${briefing.accounts.healthy} healthy`,
    `  ⚠️ ${briefing.accounts.warning} warning`,
    `  🔴 ${briefing.accounts.critical} critical`,
    '',
    `**Today:** ${briefing.tasks_today} tasks scheduled`,
    `**Pending Review:** ${briefing.posts_pending_review} posts`,
  ];
  
  if (briefing.alerts.length > 0) {
    lines.push('', '**Alerts:**');
    for (const alert of briefing.alerts) {
      lines.push(`  • ${alert}`);
    }
  }
  
  return lines.join('\n');
}
