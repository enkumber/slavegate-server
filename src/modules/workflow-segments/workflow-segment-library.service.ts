import crypto from "crypto";
import { getDb } from "../../db/client";
import type { WorkflowStep, WorkflowTemplate } from "../workflows/types";

export type WorkflowSegmentCategory = "system/android" | `app/${string}`;
export type WorkflowSegmentPlacement = "prefix" | "body" | "suffix";

export interface WorkflowSegment {
  id: string;
  fingerprint: string;
  category: WorkflowSegmentCategory;
  packageName: string | null;
  placement: WorkflowSegmentPlacement;
  semanticTokens: string[];
  steps: WorkflowStep[];
  sourceCacheKey: string;
  sourceWorkflowId: string;
  sourceWorkflowVersion: string;
  sourceIntent: string | null;
  successCount: number;
}

export interface ExtractedWorkflowSegment {
  fingerprint: string;
  category: WorkflowSegmentCategory;
  packageName: string | null;
  placement: WorkflowSegmentPlacement;
  semanticTokens: string[];
  steps: WorkflowStep[];
}

const SYSTEM_ACTIONS = new Set([
  "screen_wake", "unlock", "press_key", "press_back", "home", "back", "recents",
  "open_notifications", "open_quick_settings", "open_settings", "dismiss_keyboard",
  "device_rotate", "device_sleep", "device_lock", "get_screen_state",
]);

// Package-aware actions that are safe to reuse when they target Android's own
// Settings/System UI/launcher surfaces. Raw coordinate taps and text entry are
// deliberately excluded: they are not portable enough for automatic reuse.
const SYSTEM_PACKAGE_NAVIGATION_ACTIONS = new Set([
  "open_app", "intent_send", "wait_for_idle", "detect_current_screen",
  "get_screen_state", "ui_tree_dump", "screenshot", "semantic_tap",
  "a11y_find_tap", "scroll",
]);

const REUSABLE_APP_ACTIONS = new Set([
  "open_app", "intent_send", "wait_for_idle", "detect_current_screen",
  "ui_tree_dump", "semantic_tap", "a11y_find_tap", "scroll",
]);

const MUTATING_RE = /(^|[^a-z0-9])(comment|reply|submit|send|like|upvote|downvote|follow|unfollow|join|share|delete|remove|install|purchase|buy|login|sign[_ -]?in|create[_ -]?account)(?=$|[^a-z0-9])/i;
const TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "then", "this", "that", "workflow",
  "deschide", "mergi", "navigheaza", "navighează", "apoi", "device", "android", "screen",
  "action", "params", "outputvariable", "package", "packagename", "http", "https", "www", "com",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function packageFromStep(step: WorkflowStep, fallbackPackage: string): string {
  if (step.type !== "action") return fallbackPackage;
  const params = isRecord(step.params) ? step.params : {};
  const explicit = typeof params.packageName === "string" ? params.packageName.trim() : "";
  return explicit || fallbackPackage;
}

function isSystemPackage(packageName: string): boolean {
  return packageName === "android"
    || packageName.startsWith("com.android.settings")
    || packageName.startsWith("com.android.systemui")
    || packageName.startsWith("com.google.android.permissioncontroller")
    || packageName.startsWith("com.google.android.apps.nexuslauncher");
}

export function workflowSegmentCategoryForStep(
  step: WorkflowStep,
  fallbackPackage: string,
  previousCategory?: WorkflowSegmentCategory,
): WorkflowSegmentCategory | null {
  if (step.type === "checkpoint") return null;
  if (step.type !== "action") return previousCategory ?? "system/android";
  if (SYSTEM_ACTIONS.has(step.action)) return "system/android";
  const packageName = packageFromStep(step, fallbackPackage);
  return isSystemPackage(packageName) ? "system/android" : `app/${packageName}`;
}

function stableStepShape(step: WorkflowStep): unknown {
  if (step.type === "action") {
    return {
      type: step.type,
      action: step.action,
      target: step.target ?? null,
      params: step.params ?? {},
      expectedScreen: step.expectedScreen ?? null,
      verification: step.verification ?? null,
    };
  }
  if (step.type === "wait") {
    return { type: step.type, duration: step.duration ?? null, condition: step.condition ?? null, element: step.element ?? null };
  }
  return step;
}

function segmentFingerprint(category: WorkflowSegmentCategory, steps: WorkflowStep[]): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ category, steps: steps.map(stableStepShape) }))
    .digest("hex");
}

export function semanticTokens(value: unknown): string[] {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return [...new Set(raw.toLowerCase()
    .replace(/https?:\/\//g, " ")
    .replace(/[^a-z0-9._/-]+/g, " ")
    .split(/[\s/._-]+/)
    .filter((token) => token.length >= 3 && !TOKEN_STOPWORDS.has(token) && !/^\d+$/.test(token)))]
    .sort();
}

function appStepReusable(step: WorkflowStep): boolean {
  if (step.type === "wait") return true;
  if (step.type !== "action" || !REUSABLE_APP_ACTIONS.has(step.action)) return false;
  return !MUTATING_RE.test(JSON.stringify({
    target: step.target ?? null,
    params: step.params ?? {},
    expectedScreen: step.expectedScreen ?? null,
  }));
}

function stepReusable(step: WorkflowStep, category: WorkflowSegmentCategory): boolean {
  if (category === "system/android") {
    if (step.type === "wait") return true;
    if (step.type !== "action") return false;
    return SYSTEM_ACTIONS.has(step.action)
      || (SYSTEM_PACKAGE_NAVIGATION_ACTIONS.has(step.action)
        && !MUTATING_RE.test(JSON.stringify({
          target: step.target ?? null,
          params: step.params ?? {},
          expectedScreen: step.expectedScreen ?? null,
        })));
  }
  return appStepReusable(step);
}

function inferPlacement(start: number, end: number, total: number): WorkflowSegmentPlacement {
  if (start === 0) return "prefix";
  if (end === total - 1) return "suffix";
  return "body";
}

export function extractReusableWorkflowSegments(input: {
  workflow: WorkflowTemplate;
  packageName: string;
  intent?: string | null;
}): ExtractedWorkflowSegment[] {
  const extracted: ExtractedWorkflowSegment[] = [];
  let current: { category: WorkflowSegmentCategory; start: number; steps: WorkflowStep[] } | null = null;
  let previousCategory: WorkflowSegmentCategory | undefined;

  const flush = (end: number): void => {
    if (!current || current.steps.length === 0) return;
    // A detached wait has no reusable navigation semantics of its own.
    if (!current.steps.some((step) => step.type === "action")) {
      current = null;
      return;
    }
    const category = current.category;
    const packageName = category === "system/android" ? null : category.slice(4);
    const tokens = semanticTokens(category === "system/android"
      ? [category, current.steps.map(stableStepShape)]
      : [input.intent ?? "", category, current.steps.map(stableStepShape)]);
    extracted.push({
      fingerprint: segmentFingerprint(category, current.steps),
      category,
      packageName,
      placement: inferPlacement(current.start, end, input.workflow.steps.length),
      semanticTokens: tokens,
      steps: current.steps,
    });
    current = null;
  };

  input.workflow.steps.forEach((step, index) => {
    const category = workflowSegmentCategoryForStep(step, input.packageName, previousCategory);
    if (!category || !stepReusable(step, category)) {
      flush(index - 1);
      return;
    }
    previousCategory = category;
    if (!current || current.category !== category) {
      flush(index - 1);
      current = { category, start: index, steps: [] };
    }
    current.steps.push(step);
  });
  flush(input.workflow.steps.length - 1);
  return extracted;
}

function rowToSegment(row: Record<string, unknown>): WorkflowSegment {
  return {
    id: row.id as string,
    fingerprint: row.fingerprint as string,
    category: row.category as WorkflowSegmentCategory,
    packageName: (row.package_name as string | null) ?? null,
    placement: row.placement as WorkflowSegmentPlacement,
    semanticTokens: (row.semantic_tokens as string[]) ?? [],
    steps: row.steps as WorkflowStep[],
    sourceCacheKey: row.source_cache_key as string,
    sourceWorkflowId: row.source_workflow_id as string,
    sourceWorkflowVersion: row.source_workflow_version as string,
    sourceIntent: (row.source_intent as string | null) ?? null,
    successCount: Number(row.success_count ?? 0),
  };
}

export function rankWorkflowSegments(segments: WorkflowSegment[], intent: string): WorkflowSegment[] {
  const requested = new Set(semanticTokens(intent));
  const isReadinessSegment = (segment: WorkflowSegment): boolean => {
    const actions = segment.steps
      .filter((step) => step.type === "action")
      .map((step) => step.type === "action" ? step.action : "");
    return actions.includes("screen_wake") || actions.includes("unlock");
  };
  const score = (segment: WorkflowSegment): number => {
    const matched = segment.semanticTokens.filter((token) => requested.has(token)).length;
    const coverage = requested.size > 0 ? matched / requested.size : 0;
    if (segment.category === "system/android") {
      return (isReadinessSegment(segment) ? 1_000 : 0) + matched * 100 + segment.successCount;
    }
    return matched * 100 + coverage * 10 + Math.min(segment.successCount, 20);
  };
  return segments
    .filter((segment) => segment.category === "system/android"
      ? isReadinessSegment(segment) || segment.semanticTokens.some((token) => requested.has(token))
      : segment.semanticTokens.some((token) => requested.has(token)))
    .sort((left, right) => score(right) - score(left));
}

function stepIdentity(step: WorkflowStep): string {
  return JSON.stringify(stableStepShape(step));
}

export function composeWorkflowWithSegments(
  gapSteps: WorkflowStep[],
  selected: WorkflowSegment[],
): WorkflowStep[] {
  const ordered = [
    ...selected.filter((segment) => segment.placement === "prefix"),
    ...selected.filter((segment) => segment.placement === "body"),
  ];
  const suffix = selected.filter((segment) => segment.placement === "suffix");
  const output: WorkflowStep[] = [];
  const seen = new Set<string>();
  const append = (step: WorkflowStep, segment?: WorkflowSegment, index?: number): void => {
    const identity = stepIdentity(step);
    if (seen.has(identity)) return;
    seen.add(identity);
    output.push(segment && step.id
      ? { ...step, id: `reuse_${segment.id.slice(0, 8)}_${index}_${step.id}` } as WorkflowStep
      : step);
  };
  ordered.forEach((segment) => segment.steps.forEach((step, index) => append(step, segment, index)));
  gapSteps.forEach((step) => append(step));
  suffix.forEach((segment) => segment.steps.forEach((step, index) => append(step, segment, index)));
  return output;
}

export class WorkflowSegmentLibraryService {
  async recordSelectedSegmentOutcome(input: {
    segmentIds: string[];
    success: boolean;
    taskId?: string | null;
    workflowRunId?: string | null;
    reason?: string | null;
  }): Promise<void> {
    if (input.segmentIds.length === 0) return;
    await getDb().query(
      `UPDATE workflow_segment_library
       SET success_count = success_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
           failure_count = failure_count + CASE WHEN $2::boolean THEN 0 ELSE 1 END,
           validation_state = CASE
             WHEN NOT $2::boolean
              AND failure_count + 1 >= 3
              AND success_count < (failure_count + 1) * 2
               THEN 'quarantined'
             ELSE validation_state
           END,
           compiler_eligible = CASE
             WHEN NOT $2::boolean
              AND failure_count + 1 >= 3
              AND success_count < (failure_count + 1) * 2
               THEN FALSE
             ELSE compiler_eligible
           END,
           last_success_at = CASE WHEN $2::boolean THEN NOW() ELSE last_success_at END,
           evidence = evidence || jsonb_build_object(
             'lastReuseOutcome', CASE WHEN $2::boolean THEN 'success' ELSE 'failure' END,
             'lastReuseTaskId', $3::text,
             'lastReuseWorkflowRunId', $4::text,
             'lastReuseReason', $5::text,
             'lastReuseEvaluatedAt', NOW()
           ),
           updated_at = NOW()
       WHERE id = ANY($1::uuid[])
         AND validation_state <> 'revoked'`,
      [input.segmentIds, input.success, input.taskId ?? null, input.workflowRunId ?? null, input.reason ?? null],
    );
  }

  async learnFromSuccessfulWorkflow(input: {
    workflow: WorkflowTemplate;
    cacheKey: string;
    intent?: string | null;
    packageName: string;
    taskId?: string | null;
    workflowRunId?: string | null;
    stepsCompleted: number;
    totalSteps: number;
    excludeComposedReuseSteps?: boolean;
  }): Promise<ExtractedWorkflowSegment[]> {
    if (input.totalSteps <= 0 || input.stepsCompleted < input.totalSteps) return [];
    const learningWorkflow = input.excludeComposedReuseSteps
      ? {
          ...input.workflow,
          steps: input.workflow.steps.filter((step) => !step.id?.startsWith("reuse_")),
        }
      : input.workflow;
    const segments = extractReusableWorkflowSegments({ ...input, workflow: learningWorkflow });
    const db = getDb();
    for (const segment of segments) {
      await db.query(
        `INSERT INTO workflow_segment_library
           (fingerprint, category, package_name, placement, semantic_tokens, steps,
            source_cache_key, source_workflow_id, source_workflow_version, source_intent,
            validation_state, compiler_eligible, success_count, last_success_at, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'promoted', TRUE, 1, NOW(), $11)
         ON CONFLICT (fingerprint) DO UPDATE SET
           success_count = workflow_segment_library.success_count + 1,
           validation_state = 'promoted',
           compiler_eligible = TRUE,
           last_success_at = NOW(),
           evidence = workflow_segment_library.evidence || EXCLUDED.evidence,
           updated_at = NOW()`,
        [
          segment.fingerprint, segment.category, segment.packageName, segment.placement,
          segment.semanticTokens, JSON.stringify(segment.steps), input.cacheKey,
          input.workflow.id, input.workflow.version, input.intent ?? null,
          JSON.stringify({
            validation: "successful_full_execution",
            taskId: input.taskId ?? null,
            workflowRunId: input.workflowRunId ?? null,
            stepsCompleted: input.stepsCompleted,
            totalSteps: input.totalSteps,
            validatedAt: new Date().toISOString(),
          }),
        ],
      );
    }
    return segments;
  }

  async selectForCompilation(input: { packageName: string; intent: string }): Promise<WorkflowSegment[]> {
    const result = await getDb().query(
      `SELECT * FROM workflow_segment_library
       WHERE validation_state = 'promoted'
         AND compiler_eligible = TRUE
         AND category = ANY($1::text[])
       ORDER BY success_count DESC, last_success_at DESC
       LIMIT 100`,
      [["system/android", `app/${input.packageName}`]],
    );
    const ranked = rankWorkflowSegments(result.rows.map(rowToSegment), input.intent);
    const system = ranked.find((segment) => segment.category === "system/android");
    const app = ranked.filter((segment) => segment.category !== "system/android").slice(0, 1);
    return [...(system ? [system] : []), ...app];
  }
}

export const workflowSegmentLibraryService = new WorkflowSegmentLibraryService();
