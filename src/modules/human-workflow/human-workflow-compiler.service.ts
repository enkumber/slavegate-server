import crypto from "crypto";
import { getDb } from "../../db/client";
import { loadMap } from "../app-mapping/recorder.service";
import { validateAppMapQuality, type AppMap, type AppMapQualityReport, type ElementDef } from "../app-mapping/schema";
import {
  buildGeneratedWorkflowAppMapCacheMetadata,
  compileGeneratedWorkflowTemplate,
  generatedWorkflowPlanUsesAppMap,
  validateGeneratedWorkflowTemplate,
  withGeneratedWorkflowAppMapCacheMetadata,
  type GeneratedWorkflowCompiledPlan,
} from "../workflows/workflow-validator";
import { workflowService, type GeneratedWorkflowPlanCacheRecord } from "../workflows/workflow.service";
import type { WorkflowTemplate } from "../workflows/types";
import { llmJson, type LlmResponseMetadata } from "../../utils/llm";
import { shortcutRegistryService } from "../workflow-shortcuts/shortcut-registry.service";
import { humanWorkflowCompileJobService, type HumanWorkflowCompileJobRecord } from "./compile-job.service";
import {
  normalizeCachedHumanWorkflowTemplate,
} from "./human-workflow-normalization";
import { listRuntimeProfiles, loadRuntimeProfile } from "../app-mapping/runtime-profile";

const ASYNC_COMPILE_RETRY_AFTER_MS = 2_000;
const DEFAULT_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS = 90_000;
const MAX_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS = 120_000;
const HUMAN_WORKFLOW_INITIAL_MAX_TOKENS = 4_096;
const HUMAN_WORKFLOW_REPAIR_MAX_TOKENS = 6_144;
const HUMAN_WORKFLOW_DEBUG_RESPONSE_MAX_CHARS = 100_000;
const HUMAN_WORKFLOW_COMPILER_CACHE_VERSION = "2026-07-22-data-driven-edge-v1";
const HUMAN_WORKFLOW_COMPILER_POLICY_KEY = "human_workflow_compiler_policy";

async function loadHumanWorkflowCompilerPolicy(): Promise<string> {
  try {
    const result = await getDb().query<{ content: string }>(
      "SELECT content FROM system_prompts WHERE key = $1 LIMIT 1",
      [HUMAN_WORKFLOW_COMPILER_POLICY_KEY],
    );
    const content = result.rows[0]?.content;
    return typeof content === "string" ? content.trim() : "";
  } catch {
    return "";
  }
}

async function availableRuntimeProfiles() {
  try {
    return await listRuntimeProfiles();
  } catch {
    // The runtime registry is optional while compiling in isolated/test
    // environments. Never replace missing data with application-specific
    // constants: retain the caller-provided generic app identifier instead.
    return [];
  }
}

export type HumanWorkflowSafetyClass = "read_only" | "standard" | "destructive";

export interface HumanWorkflowTarget {
  device_id: string;
  device_model: string | null;
  device_name: string | null;
  account_id: string | null;
  account_username: string | null;
  account_platform: string;
  client_id: string | null;
}

export type HumanWorkflowCompileReady = {
  status: "ready";
  requestKey: string;
  cacheHit: boolean;
  cacheKey: string;
  source: "cache" | "shortcut" | "llm";
  compileJobId?: string;
  plan: Record<string, unknown>;
  safetyClass: HumanWorkflowSafetyClass;
  platform: string;
  target: HumanWorkflowTarget;
  llmBudget?: Record<string, unknown>;
  shortcutId?: string | null;
  llmDebug?: HumanWorkflowLlmDebug;
};

export interface HumanWorkflowLlmDebugAttempt {
  attempt: number;
  provider: string;
  model: string;
  endpoint: string;
  maxTokens: number;
  rawResponse: string;
  responseTruncated: boolean;
  capturedAt: string;
}

export interface HumanWorkflowLlmDebug {
  sensitive: true;
  compilerCacheVersion: string;
  attempts: HumanWorkflowLlmDebugAttempt[];
  failure?: string;
  validationErrors?: string[];
}

export type HumanWorkflowCompileAccepted = {
  status: "compiling";
  requestKey: string;
  compileJobId: string;
  retryAfterMs: number;
  source: "llm";
};

export type HumanWorkflowCompileResult = HumanWorkflowCompileReady | HumanWorkflowCompileAccepted;

export function computeHumanWorkflowRequestKey(deviceId: string, accountId: string | null | undefined, intent: string): string {
  const accountKey = accountId && accountId.trim().length > 0 ? accountId : "device";
  return crypto
    .createHash("sha256")
    .update(`${deviceId}:${accountKey}:${intent.trim()}`)
    .digest("hex")
    .slice(0, 24);
}

async function humanWorkflowPackageName(platform: string): Promise<string> {
  let direct = null;
  try {
    direct = await loadRuntimeProfile(platform);
  } catch {
    direct = null;
  }
  if (direct) return direct.packageName;
  const profiles = await availableRuntimeProfiles();
  const normalized = platform.trim().toLowerCase();
  const match = profiles.find((profile) =>
    typeof profile.appId === "string" && profile.appId.toLowerCase() === normalized ||
    typeof profile.packageName === "string" && profile.packageName.toLowerCase() === normalized ||
    typeof profile.appName === "string" && profile.appName.toLowerCase() === normalized
  );
  return match?.packageName ?? platform;
}

async function inferHumanWorkflowPlatform(goal: string): Promise<string> {
  const normalized = goal.toLowerCase();
  const profiles = await availableRuntimeProfiles();
  const match = profiles
    .map((profile) => {
      const labels = [profile.appId, profile.packageName, profile.appName]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => value.toLowerCase());
      const score = labels.reduce((total, label) => total + (normalized.includes(label) ? label.length : 0), 0);
      return { profile, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)[0]?.profile;
  return match?.appId ?? "android";
}

export function isAccountlessHumanWorkflowIntent(goal: string): boolean {
  // Accept ANY intent — no account_id required
  // This allows device-only workflows like:
  // - Creating new social accounts (Gmail, etc.)
  // - Farming operations
  // - App installation
  // - Any other device-level action
  return true;
}

function humanWorkflowAsyncCompileTimeoutMs(): number {
  const configured = Number.parseInt(process.env.HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS ?? "", 10);
  const requested = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS;
  return Math.min(requested, MAX_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS);
}

function humanWorkflowPlanPreview(template: WorkflowTemplate, compiledPlan: GeneratedWorkflowCompiledPlan): Record<string, unknown> {
  return {
    templateId: template.id,
    version: template.version,
    steps: template.steps,
    actions: compiledPlan.steps
      .filter((step) => step.type === "action")
      .map((step) => ({
        id: step.id,
        action: step.action,
        path: step.path,
        target: step.selectorName ?? step.selectorId ?? null,
        bindingSource: step.bindingSource ?? null,
        usedAppMap: step.usedAppMap ?? false,
      })),
    compiledPlan,
  };
}

function humanWorkflowCacheCompilerVersion(cached: GeneratedWorkflowPlanCacheRecord): string | null {
  const version = cached.sourceMetadata?.compilerCacheVersion;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function humanWorkflowCacheUsable(cached: GeneratedWorkflowPlanCacheRecord, _intent: string): boolean {
  if (cached.sourceMetadata?.source !== "dashboard_human") return true;
  return humanWorkflowCacheCompilerVersion(cached) === HUMAN_WORKFLOW_COMPILER_CACHE_VERSION;
}

function inferGeneratedWorkflowAppId(template: WorkflowTemplate): string | null {
  for (const step of template.steps) {
    if (step.type === "action" && step.action === "open_app") {
      const packageName = step.params?.packageName;
      if (typeof packageName === "string" && packageName.trim().length > 0) return packageName;
    }
  }
  return null;
}

function hydrateTemplatePlaceholders(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => replacements[key] ?? _match);
  }
  if (Array.isArray(value)) return value.map((item) => hydrateTemplatePlaceholders(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hydrateTemplatePlaceholders(item, replacements)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const READINESS_ONLY_ACTIONS = new Set([
  "screen_wake",
  "unlock",
  "wait_for_idle",
  "detect_current_screen",
  "ui_tree_dump",
]);

function isReadinessOnlyIntent(goal: string): boolean {
  const normalized = goal.toLowerCase();
  const asksForReadiness = /\b(wake|wakeup|unlock|deblocheaza|deblochează|aprinde|trezeste|trezește|screen)\b/.test(normalized);
  const asksForRealWork = /\b(create|creeaza|creează|install|instaleaza|instalează|open|deschide|navigate|mergi|comment|comentariu|posteaza|postează|type|scrie)\b/.test(normalized);
  return asksForReadiness && !asksForRealWork;
}

export function humanWorkflowUndercompiledReason(workflow: WorkflowTemplate, intent: string): string | null {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) return "workflow has no steps";
  if (isReadinessOnlyIntent(intent)) return null;

  const actionSteps = steps.filter((step) => step.type === "action");
  if (actionSteps.length === 0) return "workflow has no executable action steps";
  const readinessOnly = actionSteps.every((step) => READINESS_ONLY_ACTIONS.has(String(step.action ?? "")));
  if (readinessOnly) {
    return "workflow only wakes/unlocks/observes the device and does not perform the requested task";
  }
  return null;
}

export function assertHumanWorkflowMeaningful(workflow: WorkflowTemplate, intent: string): void {
  const reason = humanWorkflowUndercompiledReason(workflow, intent);
  if (!reason) return;
  throw Object.assign(new Error(`human workflow undercompiled: ${reason}`), {
    status: 422,
    code: "HUMAN_WORKFLOW_UNDERCOMPILED",
    retryable: true,
    nextAction: "retry_compile",
  });
}

function compactHumanWorkflowAppMapHints(appMap: AppMap | null, goal: string): string {
  if (!appMap) return "No app map available; use UI-tree semantic targets.";
  const goalTerms = new Set(
    goal
      .toLowerCase()
      .replace(/[^a-z0-9_/\s]+/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3)
  );
  const scored: Array<{ score: number; pageId: string; elementId: string; element: ElementDef }> = [];
  for (const [pageId, page] of Object.entries(appMap.pages)) {
    for (const [elementId, element] of Object.entries(page.elements)) {
      const label = [
        elementId,
        element.text,
        element.contentDescription,
        element.resourceId,
        element.semanticId,
      ].filter(Boolean).join(" ").toLowerCase();
      let score = 0;
      if (label.includes("search")) score += 5;
      if (label.includes("tab") || label.includes("nav")) score += 1;
      for (const term of goalTerms) {
        if (label.includes(term.replace(/^\//, ""))) score += 3;
      }
      if (score > 0) scored.push({ score, pageId, elementId, element });
    }
  }
  const hints = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ pageId, elementId, element }) => {
      const label = element.text || element.contentDescription || element.resourceId || element.semanticId || elementId;
      return `${pageId}.${elementId}=${label}`;
    });
  return hints.length > 0
    ? `Relevant app map selectors: ${hints.join("; ")}`
    : `App map ${appMap.appName} has ${appMap.pageCount} pages; no goal-specific selector hints found.`;
}

function buildHumanWorkflowCompilePrompt(input: {
  platform: string;
  packageName: string;
  goal: string;
  target: HumanWorkflowTarget;
  appMap: AppMap | null;
  compilerPolicy: string;
}): string {
  const safetyClass = inferHumanWorkflowSafetyClass(input.goal);
  return [
    "Return JSON only. Generate one Phone Network WorkflowTemplate.",
    `Goal: ${input.goal}`,
    `Context: platform ${input.platform}, package ${input.packageName}, account ${input.target.account_username ? `@${input.target.account_username}` : "(none; device-management workflow)"}, preview compile only.`,
    compactHumanWorkflowAppMapHints(input.appMap, input.goal),
    "Required fields: id,name,platform,description,version,runtimeContract,steps,defaultVerificationStrategy,dataRetentionDays.",
    "runtimeContract must be edge-workflow/v2. The complete workflow runs locally on Android.",
    `platform must be exactly ${input.platform}.`,
    "Every step needs id and type. Step types: action,wait,condition,loop,checkpoint.",
    "All pauses, timeouts, retries, failure branches and decisions must be explicit in the workflow payload.",
    `safetyClass must be exactly ${safetyClass}.`,
    "Allowed actions are generic interpreter primitives only: screen_wake,unlock,open_app,close_app,intent_send,a11y_find_tap,ocr_find_tap,tap,long_press,double_tap,swipe,scroll,type_text,set_focused_text,press_key,keyevent,ui_tree_dump,screenshot,screenshot_for_vlm,wait_for_idle,set_variable,classify_ui_tree,request_llm.",
    "Never use semantic_tap or an application-specific opcode. Selectors, packages, URLs, normalized coordinates and state rules must be explicit data from this prompt/App Map.",
    "Use request_llm only when semantic reasoning or creative generation is genuinely required. It must declare prompt, targetVariable or saveOutputAs, timeoutMs, responseFormat, and success/failure branches.",
    "Prefer selector-first navigation. Coordinates, when required, must be normalized and followed by an explicit state check.",
    `Use params.packageName=${input.packageName} when the workflow explicitly opens the target app.`,
    safetyClass === "read_only" ? "Do not include mutating actions." : "Include only mutations explicitly requested by the user.",
    "checkpoint is type checkpoint, never an action.",
    "defaultVerificationStrategy must be local_only. dataRetentionDays must be 7.",
    "No intent or outputSchema fields.",
    input.compilerPolicy ? `Runtime compiler policy from PostgreSQL:\n${input.compilerPolicy}` : "",
  ].filter(Boolean).join("\n");
}

function buildHumanWorkflowRepairPrompt(input: {
  compilePrompt: string;
  rejectedWorkflow: unknown;
  reason: string;
}): string {
  return [
    input.compilePrompt,
    "",
    "CORRECTIVE COMPILATION REQUIRED.",
    `The previous candidate was rejected as invalid or undercompiled: ${input.reason}.`,
    "Return a complete replacement workflow that performs the user's actual goal end to end.",
    "Wake, unlock, waits, screen detection, UI dumps, and checkpoints are preparation/evidence only; they do not satisfy the goal.",
    "Include the concrete app-opening, navigation, tapping, and text-entry actions needed by the goal.",
    "For account-creation goals, include the account-creation path and all requested user-authorized form values, including a generated username/password when requested.",
    "Do not return or repeat a readiness-only workflow.",
    `Rejected candidate: ${JSON.stringify(input.rejectedWorkflow)}`,
  ].join("\n");
}

function inferHumanWorkflowSafetyClass(goal: string): HumanWorkflowSafetyClass {
  const normalized = goal.toLowerCase();
  if (/\b(delete|remove|uninstall|factory reset|sterge|șterge|dezinstaleaza|dezinstalează)\b/.test(normalized)) return "destructive";
  if (/\b(create|install|update|write|type|send|post|submit|comment|like|follow|join|creeaza|creează|instaleaza|instalează|scrie|trimite|posteaza|postează|comenteaza|comentează)\b/.test(normalized)) return "standard";
  return "read_only";
}

function normalizeHumanWorkflowTemplateCandidate(
  rawWorkflow: unknown,
  input: { platform: string; packageName: string; goal: string }
): unknown {
  if (!isRecord(rawWorkflow)) return rawWorkflow;
  const workflow: Record<string, unknown> = { ...rawWorkflow };
  workflow.id = typeof workflow.id === "string" && workflow.id.trim()
    ? workflow.id
    : `human_${input.platform}_${crypto.createHash("sha1").update(input.goal).digest("hex").slice(0, 10)}`;
  workflow.name = typeof workflow.name === "string" && workflow.name.trim() ? workflow.name : "Human workflow";
  workflow.platform = input.platform;
  workflow.description = typeof workflow.description === "string" && workflow.description.trim()
    ? workflow.description
    : input.goal;
  workflow.version = typeof workflow.version === "string" && workflow.version.trim() ? workflow.version : "1.0.0";
  workflow.runtimeContract = "edge-workflow/v2";
  workflow.defaultVerificationStrategy = workflow.defaultVerificationStrategy === "local_with_screenshot"
    ? "local_with_screenshot"
    : "local_only";
  workflow.safetyClass = workflow.safetyClass === "standard" || workflow.safetyClass === "destructive" || workflow.safetyClass === "read_only"
    ? workflow.safetyClass
    : inferHumanWorkflowSafetyClass(input.goal);
  workflow.dataRetentionDays = typeof workflow.dataRetentionDays === "number" && workflow.dataRetentionDays >= 0
    ? workflow.dataRetentionDays
    : 7;
  delete workflow.intent;
  delete workflow.outputSchema;
  delete workflow.allowedRecoveryRequests;
  const isReadOnly = workflow.safetyClass === "read_only";
  workflow.recoveryPolicy = {
    autonomy: "ai_autopilot",
    maxAttemptsPerStep: isReadOnly ? 3 : 2,
    maxAttemptsPerWorkflow: isReadOnly ? 6 : 4,
    maxRecoveryActionsPerAttempt: isReadOnly ? 6 : 4,
    allowedRecoveryRequests: [
      "ai_recovery_workflow",
      "refresh_screen_state",
      "retry_current_step",
      "return_to_anchor",
      "dismiss_transient_ui",
      "navigate_back_once",
      "verify_anchor",
    ],
    requireStateVerification: true,
    learnFromFailure: true,
  };

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    workflow.steps = [
      { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
      { id: "unlock_device", type: "action", action: "unlock", params: {} },
    ];
  }

  if (Array.isArray(workflow.steps)) {
    const normalizedSteps: unknown[] = [];
    for (let index = 0; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      if (!isRecord(step)) {
        normalizedSteps.push(step);
        continue;
      }
      const normalized: Record<string, unknown> = { ...step };
      normalized.id = typeof normalized.id === "string" && normalized.id.trim() ? normalized.id : `step_${index + 1}`;
      if (normalized.action === "checkpoint") {
        normalized.type = "checkpoint";
        delete normalized.action;
      } else if (!normalized.type && typeof normalized.action === "string") {
        normalized.type = "action";
      }
      if (normalized.type === "action" && (normalized.action === "open_app" || normalized.action === "close_app")) {
        const params = isRecord(normalized.params) ? { ...normalized.params } : {};
        if (typeof params.packageName !== "string" || !params.packageName.trim()) {
          params.packageName = typeof params.app_id === "string" ? params.app_id : input.packageName;
        }
        delete params.app_id;
        normalized.params = params;
      }
      if (normalized.type === "action" && normalized.action === "open_app" && isRecord(normalized.params)) {
        const params = { ...normalized.params };
        if (typeof params.uri === "string" && params.uri.trim().length > 0) {
          normalized.action = "intent_send";
          normalized.id = normalized.id === `step_${index + 1}` ? `step_${index + 1}_intent_send` : normalized.id;
          normalized.params = {
            action: "android.intent.action.VIEW",
            packageName: typeof params.packageName === "string" ? params.packageName : input.packageName,
            uri: params.uri,
          };
        }
      }
      if (normalized.type === "checkpoint" && isRecord(normalized.params)) {
        const reason = normalized.params.reason ?? normalized.params.label ?? normalized.params.expectedScreen;
        if (typeof reason === "string" && !normalized.reason) normalized.reason = reason;
        delete normalized.params;
      }
      if (normalized.type === "wait") {
        normalizeHumanWorkflowWaitStep(normalized);
      }
      normalizedSteps.push(normalized);
    }
    workflow.steps = normalizedSteps;
    workflow.steps = ensureHumanWorkflowPreambleSteps(workflow.steps as unknown[]);
    return workflow;
  }
  return workflow;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeHumanWorkflowWaitStep(step: Record<string, unknown>): void {
  const params = isRecord(step.params) ? step.params : {};
  if (typeof step.condition !== "string" && typeof params.condition === "string") {
    step.condition = params.condition;
  }
  if (isRecord(step.duration)) {
    delete step.params;
    return;
  }
  const explicitDuration =
    numberFromUnknown(step.duration) ??
    numberFromUnknown(step.durationMs) ??
    numberFromUnknown(step.timeoutMs) ??
    numberFromUnknown(params.durationMs) ??
    numberFromUnknown(params.timeoutMs) ??
    numberFromUnknown(params.waitMs) ??
    numberFromUnknown(params.ms);
  if (explicitDuration !== null || typeof step.condition !== "string") {
    const durationMs = explicitDuration ?? 1_000;
    step.duration = { min: durationMs, max: durationMs, distribution: "uniform" };
  }
  delete step.params;
}

function ensureHumanWorkflowPreambleSteps(steps: unknown[]): unknown[] {
  const hasAction = (action: string): boolean => steps.some((step) =>
    isRecord(step) && step.type === "action" && step.action === action
  );
  const normalized = [...steps];
  if (!hasAction("screen_wake")) {
    normalized.unshift({
      id: "wake_screen",
      type: "action",
      action: "screen_wake",
      params: {},
      timeoutMs: 10_000,
    });
  }
  if (!hasAction("unlock")) {
    const insertAt = normalized.findIndex((step) =>
      !(isRecord(step) && step.type === "action" && step.action === "screen_wake")
    );
    normalized.splice(insertAt === -1 ? normalized.length : insertAt, 0, {
      id: "unlock_device",
      type: "action",
      action: "unlock",
      params: {},
      timeoutMs: 15_000,
    });
  }
  return normalized;
}

async function loadGeneratedWorkflowCurrentAppMap(
  appId: string | null | undefined
): Promise<{ appMap: AppMap | null; quality: AppMapQualityReport | null }> {
  if (!appId) return { appMap: null, quality: null };
  const appMap = await loadMap(appId);
  if (!appMap) return { appMap: null, quality: null };
  return { appMap, quality: validateAppMapQuality(appMap) };
}

async function annotateGeneratedWorkflowCompiledPlanForCache(
  template: WorkflowTemplate,
  compiledPlan: GeneratedWorkflowCompiledPlan,
  appId?: string | null
): Promise<GeneratedWorkflowCompiledPlan> {
  if (!generatedWorkflowPlanUsesAppMap(compiledPlan)) return compiledPlan;
  const current = await loadGeneratedWorkflowCurrentAppMap(appId ?? inferGeneratedWorkflowAppId(template));
  if (!current.appMap || !current.quality) return compiledPlan;
  return withGeneratedWorkflowAppMapCacheMetadata(
    compiledPlan,
    buildGeneratedWorkflowAppMapCacheMetadata(current.appMap, current.quality)
  );
}

function readyFromCache(
  cached: GeneratedWorkflowPlanCacheRecord,
  target: HumanWorkflowTarget,
  requestKey: string,
  source: "cache" | "shortcut" = "cache",
): HumanWorkflowCompileReady {
  const cachedIntent = typeof cached.sourceMetadata?.intent === "string" ? cached.sourceMetadata.intent : requestKey;
  const workflow = normalizeCachedHumanWorkflowTemplate(cached.workflow, cached.sourceMetadata);
  assertHumanWorkflowMeaningful(workflow, cachedIntent);
  return {
    status: "ready",
    requestKey,
    cacheHit: source === "cache",
    cacheKey: cached.cacheKey,
    source,
    plan: humanWorkflowPlanPreview(workflow, cached.compiledPlan),
    safetyClass: cached.workflow.safetyClass ?? cached.compiledPlan.metadata.safetyClass ?? "read_only",
    platform: target.account_platform,
    target,
    llmBudget: cached.compiledPlan.llmBudget,
  };
}

function cacheKeyFromCompileJob(job: HumanWorkflowCompileJobRecord): string | null {
  if (typeof job.cacheKey === "string" && job.cacheKey.length > 0) return job.cacheKey;
  const resultCacheKey = job.result?.cacheKey;
  return typeof resultCacheKey === "string" && resultCacheKey.length > 0 ? resultCacheKey : null;
}

export class HumanWorkflowCompilerService {
  async resolveTarget(deviceId: string, accountId: string | null | undefined, intent?: string): Promise<HumanWorkflowTarget | null> {
    if (!accountId && intent && isAccountlessHumanWorkflowIntent(intent)) {
      const platform = await inferHumanWorkflowPlatform(intent);
      const result = await getDb().query(
        `SELECT id AS device_id, model AS device_model, friendly_name AS device_name
         FROM devices
         WHERE id = $1`,
        [deviceId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        device_id: row.device_id as string,
        device_model: (row.device_model as string | null) ?? null,
        device_name: (row.device_name as string | null) ?? null,
        account_id: null,
        account_username: null,
        account_platform: platform,
        client_id: null,
      };
    }
    if (!accountId) return null;
    const result = await getDb().query(
      `SELECT
         d.id AS device_id,
         d.model AS device_model,
         d.friendly_name AS device_name,
         a.id AS account_id,
         a.username AS account_username,
         a.platform AS account_platform,
         a.device_id AS account_device_id,
         a.client_id AS client_id
       FROM devices d
       LEFT JOIN accounts a ON a.id = $2
       WHERE d.id = $1`,
      [deviceId, accountId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || !row.account_id) return null;
    if (row.account_device_id !== row.device_id) {
      throw Object.assign(new Error("Account is not bound to selected device"), { status: 400, code: "ACCOUNT_DEVICE_MISMATCH" });
    }
    const inferredPlatform = intent ? await inferHumanWorkflowPlatform(intent) : "android";
    const explicitPlatform = inferredPlatform === "android" ? null : inferredPlatform;
    if (explicitPlatform && explicitPlatform !== String(row.account_platform).toLowerCase()) {
      return {
        device_id: row.device_id as string,
        device_model: (row.device_model as string | null) ?? null,
        device_name: (row.device_name as string | null) ?? null,
        account_id: null,
        account_username: null,
        account_platform: explicitPlatform,
        client_id: null,
      };
    }
    return {
      device_id: row.device_id as string,
      device_model: (row.device_model as string | null) ?? null,
      device_name: (row.device_name as string | null) ?? null,
      account_id: row.account_id as string,
      account_username: row.account_username as string,
      account_platform: row.account_platform as string,
      client_id: (row.client_id as string | null) ?? null,
    };
  }

  async compile(input: {
    deviceId: string;
    accountId?: string | null;
    intent: string;
  }): Promise<HumanWorkflowCompileResult> {
    const intent = input.intent.trim();
    const requestKey = computeHumanWorkflowRequestKey(input.deviceId, input.accountId, intent);
    const target = await this.resolveTarget(input.deviceId, input.accountId, intent);
    if (!target) {
      throw Object.assign(new Error("Device or account not found"), { status: 400, code: "HUMAN_WORKFLOW_TARGET_NOT_FOUND" });
    }

    const cached = await workflowService.getGeneratedPlanCacheByRequestKey(requestKey);
    if (cached && humanWorkflowCacheUsable(cached, intent)) return readyFromCache(cached, target, requestKey, "cache");

    const shortcutMatch = target.account_id
      ? await shortcutRegistryService.lookupActiveShortcut({
          platform: target.account_platform,
          intent,
          target: { ...target, account_id: target.account_id, account_username: target.account_username ?? "" },
        })
      : null;
    if (shortcutMatch) {
      await shortcutRegistryService.recordHit(shortcutMatch.shortcut.id);
      const ready = await this.compileShortcut(shortcutMatch.shortcut.id, shortcutMatch.shortcut.key, shortcutMatch.shortcut.workflowTemplate, {
        requestKey,
        intent,
        target,
      });
      return ready;
    }

    let existingJob = await humanWorkflowCompileJobService.getByRequestKey(requestKey);
    if (existingJob?.status === "ready" && existingJob.result) {
      const jobCacheKey = cacheKeyFromCompileJob(existingJob);
      const cachedJobArtifact = jobCacheKey ? await workflowService.getGeneratedPlanCache(jobCacheKey) : null;
      if (cachedJobArtifact && humanWorkflowCacheUsable(cachedJobArtifact, intent)) {
        return readyFromCache(cachedJobArtifact, target, requestKey, "cache");
      }
      const requeued = await humanWorkflowCompileJobService.requeueMissingArtifact(existingJob.id);
      existingJob = requeued ?? { ...existingJob, status: "failed", error: "compile artifact missing; retry compile" };
    }
    const job = existingJob ?? await humanWorkflowCompileJobService.createOrGet({
      requestKey,
      deviceId: input.deviceId,
      accountId: input.accountId ?? null,
      intent,
      platform: target.account_platform,
    });
    if (job.status === "queued" || job.status === "failed") {
      humanWorkflowCompileJobService.runInProcess(job.id, () => this.compileWithLlm({ requestKey, intent, target }));
    }
    return {
      status: "compiling",
      requestKey,
      compileJobId: job.id,
      retryAfterMs: ASYNC_COMPILE_RETRY_AFTER_MS,
      source: "llm",
    };
  }

  async getCompileJob(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    return humanWorkflowCompileJobService.getById(id);
  }

  async retryCompileJob(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const existing = await humanWorkflowCompileJobService.getById(id);
    if (!existing) return null;
    if (existing.status === "queued" || existing.status === "running") return existing;
    if (existing.status !== "failed") return existing;

    const target = await this.resolveTarget(existing.deviceId, existing.accountId, existing.intent);
    if (!target) {
      throw Object.assign(new Error("Device or account not found"), { status: 400, code: "HUMAN_WORKFLOW_TARGET_NOT_FOUND" });
    }
    const job = await humanWorkflowCompileJobService.requeueFailed(id);
    if (!job) return existing;
    humanWorkflowCompileJobService.runInProcess(job.id, () => this.compileWithLlm({
      requestKey: job.requestKey,
      intent: job.intent,
      target,
    }));
    return job;
  }

  async compileShortcut(
    shortcutId: string,
    shortcutKey: string,
    rawTemplate: WorkflowTemplate,
    input: { requestKey: string; intent: string; target: HumanWorkflowTarget },
  ): Promise<HumanWorkflowCompileReady> {
    const platform = input.target.account_platform.toLowerCase();
    const packageName = await humanWorkflowPackageName(platform);
    const hydrated = hydrateTemplatePlaceholders(rawTemplate, { platform, packageName }) as WorkflowTemplate;
    const validation = validateGeneratedWorkflowTemplate(hydrated);
    if (!validation.template) {
      throw Object.assign(new Error("workflow failed validation"), {
        status: 400,
        code: "HUMAN_WORKFLOW_VALIDATION_FAILED",
        validationErrors: validation.errors,
      });
    }
    const template = validation.template;
    assertHumanWorkflowMeaningful(template, input.intent);
    let compiledPlan = compileGeneratedWorkflowTemplate(template);
    compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, packageName);
    await workflowService.saveTemplate(template);
    await workflowService.saveGeneratedPlanCache(template, compiledPlan, input.requestKey, {
      artifactState: "promoted",
      sourceMetadata: {
        source: "dashboard_human",
        compilerCacheVersion: HUMAN_WORKFLOW_COMPILER_CACHE_VERSION,
        shortcut: shortcutKey,
        shortcutId,
        intent: input.intent,
        deviceId: input.target.device_id,
        accountId: input.target.account_id,
        platform,
        compiledAt: new Date().toISOString(),
      },
    });
    return {
      status: "ready",
      requestKey: input.requestKey,
      cacheHit: false,
      cacheKey: compiledPlan.cacheKey,
      source: "shortcut",
      plan: humanWorkflowPlanPreview(template, compiledPlan),
      safetyClass: template.safetyClass ?? compiledPlan.metadata.safetyClass ?? "read_only",
      platform,
      target: input.target,
      llmBudget: compiledPlan.llmBudget,
      shortcutId,
    };
  }

  async compileWithLlm(input: {
    requestKey: string;
    intent: string;
    target: HumanWorkflowTarget;
  }): Promise<HumanWorkflowCompileReady> {
    const platform = input.target.account_platform;
    const packageName = await humanWorkflowPackageName(platform);
    const appMap = await loadMap(packageName);
    const compilerPolicy = await loadHumanWorkflowCompilerPolicy();
    const prompt = buildHumanWorkflowCompilePrompt({
      platform,
      packageName,
      goal: input.intent,
      target: input.target,
      appMap,
      compilerPolicy,
    });

    const llmDebug: HumanWorkflowLlmDebug = {
      sensitive: true,
      compilerCacheVersion: HUMAN_WORKFLOW_COMPILER_CACHE_VERSION,
      attempts: [],
    };
    const captureAttempt = (attempt: number, maxTokens: number) =>
      (response: string, metadata: LlmResponseMetadata): void => {
        llmDebug.attempts.push({
          attempt,
          provider: metadata.provider,
          model: metadata.model,
          endpoint: metadata.endpoint,
          maxTokens,
          rawResponse: response.slice(0, HUMAN_WORKFLOW_DEBUG_RESPONSE_MAX_CHARS),
          responseTruncated: response.length > HUMAN_WORKFLOW_DEBUG_RESPONSE_MAX_CHARS,
          capturedAt: new Date().toISOString(),
        });
      };

    try {
      let rawWorkflow = await llmJson<WorkflowTemplate>(prompt, undefined, {
        max_tokens: HUMAN_WORKFLOW_INITIAL_MAX_TOKENS,
        system: "You are a Phone Network workflow compiler. Return only valid WorkflowTemplate JSON. No reasoning.",
        timeoutMs: humanWorkflowAsyncCompileTimeoutMs(),
        temperature: 0,
        disableThinking: true,
        onRawResponse: captureAttempt(1, HUMAN_WORKFLOW_INITIAL_MAX_TOKENS),
      });
      let normalizedWorkflow = normalizeHumanWorkflowTemplateCandidate(rawWorkflow, { platform, packageName, goal: input.intent });
      let validation = validateGeneratedWorkflowTemplate(normalizedWorkflow);
      let template = validation.template;
      const correctiveReason = template
        ? humanWorkflowUndercompiledReason(template, input.intent)
        : `workflow validation failed: ${validation.errors.join("; ")}`;
      if (correctiveReason) {
        rawWorkflow = await llmJson<WorkflowTemplate>(buildHumanWorkflowRepairPrompt({
          compilePrompt: prompt,
          rejectedWorkflow: rawWorkflow,
          reason: correctiveReason,
        }), undefined, {
          max_tokens: HUMAN_WORKFLOW_REPAIR_MAX_TOKENS,
          system: "You are a Phone Network workflow compiler repairing an undercompiled plan. Return only complete valid WorkflowTemplate JSON. No reasoning.",
          timeoutMs: humanWorkflowAsyncCompileTimeoutMs(),
          temperature: 0,
          disableThinking: true,
          onRawResponse: captureAttempt(2, HUMAN_WORKFLOW_REPAIR_MAX_TOKENS),
        });
        normalizedWorkflow = normalizeHumanWorkflowTemplateCandidate(rawWorkflow, { platform, packageName, goal: input.intent });
        validation = validateGeneratedWorkflowTemplate(normalizedWorkflow);
        if (!validation.template) {
          throw Object.assign(new Error("corrective workflow failed validation"), {
            status: 400,
            code: "HUMAN_WORKFLOW_VALIDATION_FAILED",
            validationErrors: validation.errors,
          });
        }
        template = validation.template;
      }
      if (!template) {
        throw Object.assign(new Error("workflow failed validation"), {
          status: 400,
          code: "HUMAN_WORKFLOW_VALIDATION_FAILED",
          validationErrors: validation.errors,
        });
      }
      assertHumanWorkflowMeaningful(template, input.intent);
      const safetyClass = template.safetyClass ?? inferHumanWorkflowSafetyClass(input.intent);
      let compiledPlan = compileGeneratedWorkflowTemplate(template);
      compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, packageName);
      await workflowService.saveExecutableGeneratedPlanCache(template, compiledPlan, input.requestKey, {
        source: "dashboard_human",
        compilerCacheVersion: HUMAN_WORKFLOW_COMPILER_CACHE_VERSION,
        intent: input.intent,
        deviceId: input.target.device_id,
        accountId: input.target.account_id,
        platform,
        compiledAt: new Date().toISOString(),
      });
      return {
        status: "ready",
        requestKey: input.requestKey,
        cacheHit: false,
        cacheKey: compiledPlan.cacheKey,
        source: "llm",
        plan: humanWorkflowPlanPreview(template, compiledPlan),
        safetyClass,
        platform,
        target: input.target,
        llmBudget: compiledPlan.llmBudget,
        llmDebug,
      };
    } catch (err) {
      const typed = err as Error & { debugPayload?: Record<string, unknown>; validationErrors?: string[] };
      llmDebug.failure = typed.message;
      if (typed.validationErrors?.length) llmDebug.validationErrors = typed.validationErrors;
      typed.debugPayload = { llmDebug };
      throw typed;
    }
  }
}

export const humanWorkflowCompilerService = new HumanWorkflowCompilerService();
