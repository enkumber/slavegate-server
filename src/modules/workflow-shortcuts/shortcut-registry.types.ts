import type { WorkflowTemplate } from "../workflows/types";

export type WorkflowShortcutStatus = "active" | "disabled" | "draft";

export type WorkflowShortcutIntentPattern =
  | { type: "contains_all"; locale?: string; terms?: string[] }
  | { type: "regex"; locale?: string; pattern?: string }
  | { type: "exact"; locale?: string; pattern?: string };

export interface WorkflowShortcutRecord {
  id: string;
  key: string;
  platform: string;
  name: string;
  description: string | null;
  status: WorkflowShortcutStatus;
  priority: number;
  intentPatterns: WorkflowShortcutIntentPattern[];
  aliases: string[];
  matchConfig: Record<string, unknown>;
  workflowTemplate: WorkflowTemplate;
  compatibility: Record<string, unknown>;
  metadata: Record<string, unknown>;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: string | null;
}

export interface WorkflowShortcutMatch {
  shortcut: WorkflowShortcutRecord;
  normalizedIntent: string;
  matchedPattern: WorkflowShortcutIntentPattern | null;
}
