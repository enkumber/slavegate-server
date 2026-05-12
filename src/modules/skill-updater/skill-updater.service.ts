/**
 * skill-updater/skill-updater.service.ts
 * Self-healing skill file updates (P4)
 * 
 * Spawned by Kraken when skill_update_jobs has pending jobs.
 * Updates selectors and structure, NOT coordinates (that's Hydra's job).
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/client';
import { loadSkillFile, saveSkillFile } from '../skills/skill.service';
import {
  SkillUpdaterConfig,
  DEFAULT_CONFIG,
  SkillUpdateJob,
  JobResult,
  PatchDetail,
  SkillPatch,
  PatchCandidate,
  SelectorAnalysis,
  RollbackCheck,
} from './types';

const BACKUP_DIR = path.join(__dirname, '../../..', 'backups', 'skills');

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export async function processSkillUpdateJobs(config: Partial<SkillUpdaterConfig> = {}): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const db = getDb();
  
  // Check daily limit
  const todayCount = await getTodayPatchCount(db);
  if (todayCount >= cfg.max_per_day) {
    console.log(`[skill-updater] Daily limit reached (${todayCount}/${cfg.max_per_day})`);
    return;
  }
  
  // Get pending jobs
  const jobs = await getPendingJobs(db);
  if (jobs.length === 0) {
    console.log('[skill-updater] No pending jobs');
    return;
  }
  
  console.log(`[skill-updater] Processing ${jobs.length} pending jobs`);
  
  for (const job of jobs) {
    if (todayCount >= cfg.max_per_day) {
      console.log('[skill-updater] Daily limit reached, stopping');
      break;
    }
    
    try {
      await processJob(db, job, cfg);
    } catch (err) {
      console.error(`[skill-updater] Error processing job ${job.id}:`, err);
      await markJobFailed(db, job.id, (err as Error).message);
    }
  }
}

async function processJob(db: any, job: SkillUpdateJob, cfg: SkillUpdaterConfig): Promise<void> {
  console.log(`[skill-updater] Processing job ${job.id} for ${job.app}`);
  
  // Mark as processing
  await db.query(`UPDATE skill_update_jobs SET status = 'processing' WHERE id = $1`, [job.id]);
  
  const result: JobResult = {
    patches_applied: 0,
    patches_pending: 0,
    patches_failed: 0,
    details: [],
  };
  
  // ─── 1. GATHER — collect failure data and ui_tree dumps ─────────────────────
  const uiTreeDumps = await gatherUiTreeDumps(db, job.app);
  
  if (uiTreeDumps.length === 0) {
    console.log(`[skill-updater] No UI tree dumps found for ${job.app}`);
    await markJobCompleted(db, job.id, result);
    return;
  }
  
  // ─── 2. ANALYZE — check app versions, consistency ───────────────────────────
  const appVersions = [...new Set(uiTreeDumps.map(d => d.app_version))];
  if (appVersions.length > 1) {
    console.log(`[skill-updater] Multiple app versions detected: ${appVersions.join(', ')}`);
    // Use the most common version
  }
  
  // ─── 3. INSPECT — load skill file, analyze each element ─────────────────────
  const skill = await loadSkillFile(job.app);
  if (!skill) {
    throw new Error(`Skill file not found for ${job.app}`);
  }
  
  const allElements = [
    ...Object.keys(skill.button_map.fixed_elements),
    ...Object.keys(skill.button_map.contextual_elements),
    ...Object.keys(skill.button_map.variable_elements),
  ];
  
  const analyses: SelectorAnalysis[] = [];
  
  for (const elementName of allElements) {
    const analysis = analyzeElement(elementName, skill, uiTreeDumps);
    analyses.push(analysis);
  }
  
  // ─── 4. GENERATE — create patch candidates ──────────────────────────────────
  const candidates: PatchCandidate[] = [];
  
  for (const analysis of analyses) {
    if (analysis.recommendation === 'update' && analysis.alternative_selectors.length > 0) {
      const best = analysis.alternative_selectors[0];
      candidates.push({
        element: analysis.element_name,
        old_selector: analysis.current_selector,
        new_selector: best.selector,
        confidence: best.confidence,
        occurrences: best.occurrences,
        app_version: appVersions[0],
        sources: [],
      });
    }
  }
  
  // ─── 5. APPLY — apply high-confidence patches ───────────────────────────────
  for (const candidate of candidates) {
    const patchResult = await applyPatch(db, job.app, candidate, skill, cfg);
    result.details.push(patchResult);
    
    if (patchResult.action === 'updated') {
      result.patches_applied++;
    } else if (patchResult.action === 'failed') {
      result.patches_failed++;
    } else {
      result.patches_pending++;
    }
  }
  
  // Save updated skill file if patches were applied
  if (result.patches_applied > 0) {
    skill.updated_at = new Date();
    await saveSkillFile(job.app, skill);
  }
  
  // ─── 6. SCRIE — mark job completed ──────────────────────────────────────────
  await markJobCompleted(db, job.id, result);
  
  console.log(`[skill-updater] Job ${job.id} completed: ${result.patches_applied} applied, ${result.patches_pending} pending, ${result.patches_failed} failed`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATHER
// ═══════════════════════════════════════════════════════════════════════════════

async function gatherUiTreeDumps(db: any, app: string): Promise<any[]> {
  // In a real implementation, this would fetch stored UI tree dumps
  // For now, return empty array - UI tree dumps would come from device logs
  
  // TODO: Implement UI tree dump storage and retrieval
  // This would query a separate table or artifact storage
  
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYZE
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeElement(elementName: string, skill: any, uiTreeDumps: any[]): SelectorAnalysis {
  let currentSelector = '';
  
  // Get current selector
  if (skill.button_map.fixed_elements[elementName]) {
    currentSelector = skill.button_map.fixed_elements[elementName].selector;
  } else if (skill.button_map.contextual_elements[elementName]) {
    currentSelector = skill.button_map.contextual_elements[elementName].selector;
  } else if (skill.button_map.variable_elements[elementName]) {
    currentSelector = skill.button_map.variable_elements[elementName].selector;
  }
  
  // Search for selector in UI tree dumps
  let foundCount = 0;
  const alternatives: Map<string, { count: number; confidence: number }> = new Map();
  
  for (const dump of uiTreeDumps) {
    const found = findSelectorInTree(dump.nodes, currentSelector);
    if (found) {
      foundCount++;
    } else {
      // Look for similar elements
      const similar = findSimilarElements(dump.nodes, elementName, currentSelector);
      for (const s of similar) {
        const existing = alternatives.get(s.selector) || { count: 0, confidence: 0 };
        alternatives.set(s.selector, {
          count: existing.count + 1,
          confidence: Math.max(existing.confidence, s.confidence),
        });
      }
    }
  }
  
  const totalDumps = uiTreeDumps.length || 1;
  const foundRate = foundCount / totalDumps;
  
  // Build alternative selectors list
  const alternativeSelectors = Array.from(alternatives.entries())
    .map(([selector, data]) => ({
      selector,
      confidence: data.confidence,
      match_type: 'partial' as const,
      occurrences: data.count,
    }))
    .sort((a, b) => b.confidence - a.confidence);
  
  // Determine recommendation
  let recommendation: 'keep' | 'update' | 'manual_review' | 'remove' = 'keep';
  
  if (foundRate < 0.5 && alternativeSelectors.length > 0 && alternativeSelectors[0].confidence >= 0.85) {
    recommendation = 'update';
  } else if (foundRate < 0.5 && alternativeSelectors.length > 0) {
    recommendation = 'manual_review';
  } else if (foundRate < 0.2 && alternativeSelectors.length === 0) {
    recommendation = 'remove';
  }
  
  return {
    element_name: elementName,
    current_selector: currentSelector,
    found_in_ui_tree: foundRate >= 0.5,
    alternative_selectors: alternativeSelectors,
    recommendation,
  };
}

function findSelectorInTree(nodes: any[], selector: string): boolean {
  if (!nodes) return false;
  
  for (const node of nodes) {
    if (node.resourceId === selector || node.className === selector) {
      return true;
    }
    if (node.children && findSelectorInTree(node.children, selector)) {
      return true;
    }
  }
  
  return false;
}

function findSimilarElements(nodes: any[], elementName: string, currentSelector: string): Array<{ selector: string; confidence: number }> {
  const results: Array<{ selector: string; confidence: number }> = [];
  
  // Extract base patterns from element name and current selector
  const nameParts = elementName.toLowerCase().split(/[._]/);
  const selectorParts = currentSelector.toLowerCase().split(/[/:_]/);
  
  const searchNodes = (nodeList: any[]) => {
    if (!nodeList) return;
    
    for (const node of nodeList) {
      const nodeId = (node.resourceId || '').toLowerCase();
      const nodeClass = (node.className || '').toLowerCase();
      
      // Check for partial matches
      let matchScore = 0;
      for (const part of nameParts) {
        if (part.length > 2 && (nodeId.includes(part) || nodeClass.includes(part))) {
          matchScore += 0.3;
        }
      }
      
      if (matchScore > 0 && node.resourceId && node.resourceId !== currentSelector) {
        results.push({
          selector: node.resourceId,
          confidence: Math.min(matchScore, 0.9),
        });
      }
      
      if (node.children) {
        searchNodes(node.children);
      }
    }
  };
  
  searchNodes(nodes);
  
  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPLY
// ═══════════════════════════════════════════════════════════════════════════════

async function applyPatch(
  db: any,
  app: string,
  candidate: PatchCandidate,
  skill: any,
  cfg: SkillUpdaterConfig
): Promise<PatchDetail> {
  // Check confidence threshold
  if (candidate.confidence < cfg.min_confidence) {
    return {
      element: candidate.element,
      action: 'failed',
      old_selector: candidate.old_selector,
      new_selector: candidate.new_selector,
      confidence: candidate.confidence,
      error: `Confidence ${candidate.confidence} below threshold ${cfg.min_confidence}`,
    };
  }
  
  // Check if protected
  for (const pattern of cfg.protected_files) {
    if (candidate.element.includes(pattern.replace('*', ''))) {
      return {
        element: candidate.element,
        action: 'failed',
        old_selector: candidate.old_selector,
        new_selector: candidate.new_selector,
        confidence: candidate.confidence,
        error: 'Element is in protected file',
      };
    }
  }
  
  // Create backup
  const backupPath = await createBackup(app);
  
  // Apply the patch to skill object
  let applied = false;
  
  if (skill.button_map.fixed_elements[candidate.element]) {
    skill.button_map.fixed_elements[candidate.element].selector = candidate.new_selector;
    skill.button_map.fixed_elements[candidate.element].last_verified = new Date();
    applied = true;
  } else if (skill.button_map.contextual_elements[candidate.element]) {
    skill.button_map.contextual_elements[candidate.element].selector = candidate.new_selector;
    skill.button_map.contextual_elements[candidate.element].last_verified = new Date();
    applied = true;
  } else if (skill.button_map.variable_elements[candidate.element]) {
    skill.button_map.variable_elements[candidate.element].selector = candidate.new_selector;
    applied = true;
  }
  
  if (!applied) {
    return {
      element: candidate.element,
      action: 'failed',
      old_selector: candidate.old_selector,
      new_selector: candidate.new_selector,
      confidence: candidate.confidence,
      error: 'Element not found in skill file',
    };
  }
  
  // Log patch to DB
  await db.query(`
    INSERT INTO skill_patches (app, element, old_selector, new_selector, confidence, backup_path)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [app, candidate.element, candidate.old_selector, candidate.new_selector, candidate.confidence, backupPath]);
  
  console.log(`[skill-updater] Applied patch: ${app}:${candidate.element} → ${candidate.new_selector} (confidence: ${candidate.confidence})`);
  
  return {
    element: candidate.element,
    action: 'updated',
    old_selector: candidate.old_selector,
    new_selector: candidate.new_selector,
    confidence: candidate.confidence,
  };
}

async function createBackup(app: string): Promise<string> {
  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `${app}_${timestamp}.skill.bak`);
  
  const skillPath = path.join(__dirname, '../skills/templates', `${app}.skill`);
  if (fs.existsSync(skillPath)) {
    fs.copyFileSync(skillPath, backupPath);
  }
  
  return backupPath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════════

export async function checkAndRollback(config: Partial<SkillUpdaterConfig> = {}): Promise<RollbackCheck[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const db = getDb();
  const results: RollbackCheck[] = [];
  
  // Get patches applied in monitoring window
  const monitoringCutoff = new Date(Date.now() - cfg.rollback_monitoring_hours * 60 * 60 * 1000);
  
  const patches = await db.query(`
    SELECT * FROM skill_patches
    WHERE applied_at > $1 AND rolled_back_at IS NULL
  `, [monitoringCutoff]);
  
  for (const patch of patches.rows) {
    const check = await evaluatePatchHealth(db, patch, cfg);
    results.push(check);
    
    if (check.should_rollback) {
      await rollbackPatch(db, patch);
    }
  }
  
  return results;
}

async function evaluatePatchHealth(db: any, patch: SkillPatch, cfg: SkillUpdaterConfig): Promise<RollbackCheck> {
  // Get fail rate before and after patch
  const beforeResult = await db.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN NOT verified THEN 1 ELSE 0 END) as failed
    FROM navigation_logs
    WHERE app = $1 AND element_name = $2 AND timestamp < $3
    AND timestamp > $3 - INTERVAL '1 hour'
  `, [patch.app, patch.element, patch.applied_at]);
  
  const afterResult = await db.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN NOT verified THEN 1 ELSE 0 END) as failed
    FROM navigation_logs
    WHERE app = $1 AND element_name = $2 AND timestamp > $3
  `, [patch.app, patch.element, patch.applied_at]);
  
  const beforeTotal = parseInt(beforeResult.rows[0]?.total) || 1;
  const beforeFailed = parseInt(beforeResult.rows[0]?.failed) || 0;
  const afterTotal = parseInt(afterResult.rows[0]?.total) || 1;
  const afterFailed = parseInt(afterResult.rows[0]?.failed) || 0;
  
  const failRateBefore = beforeFailed / beforeTotal;
  const failRateAfter = afterFailed / afterTotal;
  
  // Rollback if fail rate increased significantly
  const shouldRollback = failRateAfter > failRateBefore + 0.1 && afterTotal >= 5;
  
  return {
    patch_id: patch.id,
    app: patch.app,
    element: patch.element,
    applied_at: patch.applied_at,
    monitoring_until: new Date(patch.applied_at.getTime() + cfg.rollback_monitoring_hours * 60 * 60 * 1000),
    should_rollback: shouldRollback,
    reason: shouldRollback ? `Fail rate increased from ${(failRateBefore * 100).toFixed(1)}% to ${(failRateAfter * 100).toFixed(1)}%` : undefined,
    fail_rate_before: failRateBefore,
    fail_rate_after: failRateAfter,
  };
}

async function rollbackPatch(db: any, patch: SkillPatch): Promise<void> {
  console.log(`[skill-updater] Rolling back patch ${patch.id}: ${patch.app}:${patch.element}`);
  
  // Restore from backup
  if (fs.existsSync(patch.backup_path)) {
    const skillPath = path.join(__dirname, '../skills/templates', `${patch.app}.skill`);
    fs.copyFileSync(patch.backup_path, skillPath);
  }
  
  // Mark as rolled back
  await db.query(`
    UPDATE skill_patches SET rolled_back_at = NOW() WHERE id = $1
  `, [patch.id]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getPendingJobs(db: any): Promise<SkillUpdateJob[]> {
  const result = await db.query(`
    SELECT * FROM skill_update_jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `);
  
  return result.rows.map((row: any) => ({
    id: row.id,
    app: row.app,
    elements: row.elements || [],
    failure_data: row.failure_data || {},
    status: row.status,
    result: row.result,
    created_at: row.created_at,
    completed_at: row.completed_at,
  }));
}

async function getTodayPatchCount(db: any): Promise<number> {
  const result = await db.query(`
    SELECT COUNT(*) as count FROM skill_patches
    WHERE applied_at > CURRENT_DATE
  `);
  return parseInt(result.rows[0]?.count) || 0;
}

async function markJobCompleted(db: any, jobId: string, result: JobResult): Promise<void> {
  await db.query(`
    UPDATE skill_update_jobs
    SET status = 'completed', result = $1, completed_at = NOW()
    WHERE id = $2
  `, [JSON.stringify(result), jobId]);
}

async function markJobFailed(db: any, jobId: string, error: string): Promise<void> {
  await db.query(`
    UPDATE skill_update_jobs
    SET status = 'failed', result = $1, completed_at = NOW()
    WHERE id = $2
  `, [JSON.stringify({ error }), jobId]);
}
