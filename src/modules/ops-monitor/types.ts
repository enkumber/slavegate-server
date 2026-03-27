/**
 * ops-monitor/types.ts
 * Type definitions for Ops Monitor (P3)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpsMonitorConfig {
  vision_fallback_warning: number;   // 0.20 (20%)
  vision_fallback_critical: number;  // 0.40 (40%)
  device_offline_warning_min: number;   // 10 minutes
  device_offline_critical_min: number;  // 30 minutes
  fail_rate_threshold: number;       // 0.30 (30%) - triggers immediate run
  lookback_hours: number;            // 1 hour default
}

export const DEFAULT_CONFIG: OpsMonitorConfig = {
  vision_fallback_warning: 0.20,
  vision_fallback_critical: 0.40,
  device_offline_warning_min: 10,
  device_offline_critical_min: 30,
  fail_rate_threshold: 0.30,
  lookback_hours: 1,
};

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════════════════════

export interface UIMetrics {
  app: string;
  total_taps: number;
  coords_success: number;
  ui_tree_success: number;
  vision_success: number;
  vision_fallback_rate: number;  // (ui_tree_success + vision_success) / total where coords failed
  element_not_found_count: number;
}

export interface DeviceMetrics {
  device_id: string;
  friendly_name: string;
  status: string;
  last_seen_at: Date | null;
  minutes_offline: number;
  needs_attention: boolean;
}

export interface AccountMetrics {
  account_id: string;
  username: string;
  platform: string;
  rate_limit_hits: number;
  soft_block_detected: boolean;
  app_crashes: number;
}

export interface MappingMetrics {
  app: string;
  app_version: string;
  unmapped_elements: string[];
  elements_failed: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  type: string;
  severity: AlertSeverity;
  entity_type: 'device' | 'account' | 'app';
  entity_id: string;
  message: string;
  metric_value?: number;
  threshold?: number;
  created_at: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpsMonitorReport {
  run_at: Date;
  lookback_hours: number;
  
  ui_metrics: UIMetrics[];
  device_metrics: DeviceMetrics[];
  account_metrics: AccountMetrics[];
  mapping_metrics: MappingMetrics[];
  
  alerts: Alert[];
  
  actions_taken: {
    devices_flagged: number;
    accounts_flagged: number;
    skill_update_jobs_created: number;
  };
}
