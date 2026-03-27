/**
 * business-analyst/types.ts
 * Type definitions for Business Analyst (P6)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface BAConfig {
  lookback_hours: number;           // Default 24h
  timeout_minutes: number;          // Max runtime (30 min)
  
  thresholds: {
    healthy_success_rate: number;   // >= 0.80
    warning_success_rate: number;   // >= 0.50
    // Below warning = critical
  };
}

export const DEFAULT_CONFIG: BAConfig = {
  lookback_hours: 24,
  timeout_minutes: 30,
  thresholds: {
    healthy_success_rate: 0.80,
    warning_success_rate: 0.50,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════

export interface AccountData {
  id: string;
  username: string;
  platform: string;
  client_id: string | null;
  type: 'farming' | 'business' | null;
  status: string;
  metrics: AccountMetrics | null;
  flags: AccountFlags | null;
  device_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccountMetrics {
  followers?: number;
  following?: number;
  posts?: number;
  engagement_rate?: number;
  avg_likes?: number;
  avg_comments?: number;
  growth_7d?: number;
  last_post_at?: string;
}

export interface AccountFlags {
  rate_limited_until?: string;
  soft_blocked_until?: string;
  needs_attention?: boolean;
  ba_reviewed_at?: string;
  last_issue?: string;
}

export interface ExecutionLogEntry {
  id: string;
  account_id: string;
  task_type: string;
  success: boolean;
  error?: string;
  created_at: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'suspended';

export interface AccountAnalysis {
  account_id: string;
  username: string;
  platform: string;
  client_id: string | null;
  
  // Performance
  total_actions: number;
  successful_actions: number;
  success_rate: number;
  
  // Issues
  rate_limit_active: boolean;
  soft_block_active: boolean;
  recent_errors: string[];
  
  // Engagement (if available)
  engagement_trend: 'up' | 'stable' | 'down' | 'unknown';
  
  // Classification
  health_status: HealthStatus;
  recommendations: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

export interface BAReport {
  id?: string;
  type: 'daily_performance';
  period_start: Date;
  period_end: Date;
  
  summary: {
    total_accounts: number;
    healthy: number;
    warning: number;
    critical: number;
    suspended: number;
    
    total_actions: number;
    overall_success_rate: number;
    
    top_performers: string[];      // account usernames
    needs_attention: string[];     // account usernames
  };
  
  accounts: AccountAnalysis[];
  
  alerts: BAAlert[];
  
  created_at: Date;
}

export interface BAAlert {
  severity: 'info' | 'warning' | 'critical';
  account_id?: string;
  message: string;
  action_required?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════

export interface BAResult {
  success: boolean;
  report_id?: string;
  summary: string;
  accounts_analyzed: number;
  flags_updated: number;
  duration_ms: number;
  error?: string;
}
