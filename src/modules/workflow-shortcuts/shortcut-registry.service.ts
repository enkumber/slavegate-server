import { getDb } from "../../db/client";
import type {
  WorkflowShortcutIntentPattern,
  WorkflowShortcutMatch,
  WorkflowShortcutRecord,
} from "./shortcut-registry.types";

function normalizeShortcutText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function rowToShortcut(row: Record<string, unknown>): WorkflowShortcutRecord {
  return {
    id: row.id as string,
    key: row.key as string,
    platform: row.platform as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    status: row.status as WorkflowShortcutRecord["status"],
    priority: Number(row.priority ?? 100),
    intentPatterns: (row.intent_patterns as WorkflowShortcutIntentPattern[] | null) ?? [],
    aliases: (row.aliases as string[] | null) ?? [],
    matchConfig: (row.match_config as Record<string, unknown> | null) ?? {},
    workflowTemplate: row.workflow_template as WorkflowShortcutRecord["workflowTemplate"],
    compatibility: (row.compatibility as Record<string, unknown> | null) ?? {},
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    usageCount: Number(row.usage_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

function hasMutationTerms(normalizedIntent: string): boolean {
  return /\b(?:autentifica|cumpara|delete|dezactiveaza|dezurmareste|follow|join|like|login|mesaj|parola|posteaza|publish|reply|schimba|scrie|send|sterge|trimite|type|unfollow|upvote|vote|urmareste|comenteaza|comentezi)\b/.test(normalizedIntent);
}

function hasRejectedTerms(matchConfig: Record<string, unknown>, normalizedIntent: string): boolean {
  const rejectTerms = matchConfig.rejectTerms;
  if (!Array.isArray(rejectTerms)) return false;
  return rejectTerms.some((term) => (
    typeof term === "string" && normalizedIntent.includes(normalizeShortcutText(term))
  ));
}

function patternMatches(pattern: WorkflowShortcutIntentPattern, normalizedIntent: string): boolean {
  if (pattern.type === "exact") {
    return normalizeShortcutText(pattern.pattern ?? "") === normalizedIntent;
  }
  if (pattern.type === "regex") {
    if (!pattern.pattern) return false;
    return new RegExp(pattern.pattern, "i").test(normalizedIntent);
  }
  if (pattern.type === "contains_all") {
    const terms = pattern.terms ?? [];
    return terms.length > 0 && terms.every((term) => normalizedIntent.includes(normalizeShortcutText(term)));
  }
  return false;
}

export class ShortcutRegistryService {
  async lookupActiveShortcut(input: {
    platform: string;
    intent: string;
    target?: Record<string, unknown>;
  }): Promise<WorkflowShortcutMatch | null> {
    const platform = input.platform.toLowerCase();
    const normalizedIntent = normalizeShortcutText(input.intent);
    const result = await getDb().query(
      `SELECT *
       FROM workflow_shortcuts
       WHERE platform = $1 AND status = 'active'
       ORDER BY priority ASC, updated_at DESC, key ASC`,
      [platform],
    );

    for (const row of result.rows as Record<string, unknown>[]) {
      const shortcut = rowToShortcut(row);
      if (shortcut.matchConfig.readOnlyOnly === true && hasMutationTerms(normalizedIntent)) continue;
      if (hasRejectedTerms(shortcut.matchConfig, normalizedIntent)) continue;
      const patterns = shortcut.intentPatterns.length > 0
        ? shortcut.intentPatterns
        : shortcut.aliases.map((alias) => ({ type: "exact", pattern: alias }) as WorkflowShortcutIntentPattern);
      const matchedPattern = patterns.find((pattern) => patternMatches(pattern, normalizedIntent)) ?? null;
      if (matchedPattern) return { shortcut, normalizedIntent, matchedPattern };
    }

    return null;
  }

  async recordHit(shortcutId: string): Promise<void> {
    await getDb().query(
      `UPDATE workflow_shortcuts
       SET usage_count = usage_count + 1, last_used_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [shortcutId],
    );
  }

  async recordRunResult(shortcutId: string, success: boolean): Promise<void> {
    await getDb().query(
      `UPDATE workflow_shortcuts
       SET success_count = success_count + $2,
           failure_count = failure_count + $3,
           updated_at = NOW()
       WHERE id = $1`,
      [shortcutId, success ? 1 : 0, success ? 0 : 1],
    );
  }
}

export const shortcutRegistryService = new ShortcutRegistryService();
