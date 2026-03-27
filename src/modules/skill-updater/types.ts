/**
 * skill-updater/types.ts
 * Type definitions for Skill Updater (P4)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface SkillUpdaterConfig {
  auto_apply: boolean;
  max_per_day: number;
  min_confidence: number;
  rollback_monitoring_hours: number;
  
  high_confidence: {
    min_occurrences: number;
    min_vision_confidence: number;
    same_app_version: boolean;
  };
  
  medium_confidence: {
    min_occurrences: number;
    min_vision_confidence: number;
  };
  
  protected_files: string[];
}

export const DEFAULT_CONFIG: SkillUpdaterConfig = {
  auto_apply: true,
  max_per_day: 3,
  min_confidence: 0.85,
  rollback_monitoring_hours: 2,
  
  high_confidence: {
    min_occurrences: 20,
    min_vision_confidence: 0.85,
    same_app_version: true,
  },
  
  medium_confidence: {
    min_occurrences: 10,
    min_vision_confidence: 0.75,
  },
  
  protected_files: ['/skills/primitives/*'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// JOB
// ═══════════════════════════════════════════════════════════════════════════════

export interface SkillUpdateJob {
  id: string;
  app: string;
  elements: string[];
  failure_data: FailureData;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: JobResult;
  created_at: Date;
  completed_at?: Date;
}

export interface FailureData {
  vision_fallback_rate?: number;
  element_not_found_count?: number;
  triggered_by: string;
  triggered_at: string;
  ui_tree_dumps?: UiTreeDump[];
}

export interface UiTreeDump {
  device_id: string;
  app_version: string;
  screen_resolution: string;
  captured_at: string;
  nodes: any[];  // UI tree nodes from device
}

export interface JobResult {
  patches_applied: number;
  patches_pending: number;
  patches_failed: number;
  details: PatchDetail[];
}

export interface PatchDetail {
  element: string;
  action: 'updated' | 'added' | 'removed' | 'failed';
  old_selector?: string;
  new_selector?: string;
  confidence: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH
// ═══════════════════════════════════════════════════════════════════════════════

export interface SkillPatch {
  id: string;
  app: string;
  element: string;
  old_selector: string;
  new_selector: string;
  confidence: number;
  backup_path: string;
  applied_at: Date;
  rolled_back_at?: Date;
}

export interface PatchCandidate {
  element: string;
  old_selector: string;
  new_selector: string;
  confidence: number;
  occurrences: number;
  app_version: string;
  sources: string[];  // device_ids that contributed to this candidate
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

export interface SelectorAnalysis {
  element_name: string;
  current_selector: string;
  found_in_ui_tree: boolean;
  alternative_selectors: AlternativeSelector[];
  recommendation: 'keep' | 'update' | 'manual_review' | 'remove';
}

export interface AlternativeSelector {
  selector: string;
  confidence: number;
  match_type: 'exact' | 'partial' | 'visual_similar';
  occurrences: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════════

export interface RollbackCheck {
  patch_id: string;
  app: string;
  element: string;
  applied_at: Date;
  monitoring_until: Date;
  should_rollback: boolean;
  reason?: string;
  fail_rate_before: number;
  fail_rate_after: number;
}
