import crypto from "crypto";
import { getDb } from "../../db/client";
import { loadMap } from "../app-mapping/recorder.service";
import { validateAppMapQuality, type AppMap, type AppMapQualityReport, type ElementDef } from "../app-mapping/schema";
import {
  resolveGeneratedWorkflowScreens,
} from "../workflows/generated-workflow-prompt";
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
import { llmJson } from "../../utils/llm";
import { shortcutRegistryService } from "../workflow-shortcuts/shortcut-registry.service";
import { humanWorkflowCompileJobService, type HumanWorkflowCompileJobRecord } from "./compile-job.service";

const ASYNC_COMPILE_RETRY_AFTER_MS = 2_000;
const DEFAULT_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS = 90_000;
const MAX_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS = 120_000;
const PLATFORM_APP_IDS: Record<string, string> = {
  reddit: "com.reddit.frontpage",
  instagram: "com.instagram.android",
  tiktok: "com.zhiliaoapp.musically",
  facebook: "com.facebook.katana",
  twitter: "com.twitter.android",
};

export type HumanWorkflowSafetyClass = "read_only" | "standard" | "destructive";

export interface HumanWorkflowTarget {
  device_id: string;
  device_model: string | null;
  device_name: string | null;
  account_id: string;
  account_username: string;
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
};

export type HumanWorkflowCompileAccepted = {
  status: "compiling";
  requestKey: string;
  compileJobId: string;
  retryAfterMs: number;
  source: "llm";
};

export type HumanWorkflowCompileResult = HumanWorkflowCompileReady | HumanWorkflowCompileAccepted;

export function computeHumanWorkflowRequestKey(deviceId: string, accountId: string, intent: string): string {
  return crypto
    .createHash("sha256")
    .update(`${deviceId}:${accountId}:${intent.trim()}`)
    .digest("hex")
    .slice(0, 24);
}

function humanWorkflowAppId(platform: string): string {
  return PLATFORM_APP_IDS[platform.toLowerCase()] ?? platform;
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
}): string {
  const screens = resolveGeneratedWorkflowScreens(input.platform)
    .filter((screen) => screen === "UNKNOWN" || screen.startsWith(input.platform.toUpperCase()))
    .slice(0, 8)
    .join(", ");
  return [
    "Return JSON only. Generate one Phone Network WorkflowTemplate.",
    `Goal: ${input.goal}`,
    `Context: platform ${input.platform}, package ${input.packageName}, account @${input.target.account_username}, preview compile only.`,
    compactHumanWorkflowAppMapHints(input.appMap, input.goal),
    "Required fields: id,name,platform,description,version,steps,defaultVerificationStrategy,dataRetentionDays.",
    `platform must be exactly ${input.platform}.`,
    "Every step needs id and type. Step types: action,wait,checkpoint.",
    "Allowed actions: open_app,intent_send,wait_for_idle,semantic_tap,a11y_find_tap,press_key,scroll,detect_current_screen,ui_tree_dump.",
    "Start device workflows with action screen_wake, then action unlock, before opening or navigating apps.",
    `open_app must use params.packageName=${input.packageName}.`,
    `To open a subreddit or URL, use intent_send with params.uri=https://www.reddit.com/r/<subreddit>/ and params.packageName=${input.packageName}. Do not put uri on open_app.`,
    "For navigation/read-only goals, include a final ui_tree_dump with params.outputVariable=\"_finalUiTree\" before the checkpoint.",
    "semantic_tap is only for known product targets and must include params.target, for example reddit.first_visible_post.open_comments.",
    "checkpoint is type checkpoint, never an action.",
    "defaultVerificationStrategy must be local_only. dataRetentionDays must be 7.",
    screens ? `Known screens: ${screens}.` : "Use UNKNOWN if screen is uncertain.",
    "No safetyClass, intent, outputSchema, credentials, passwords, or private tokens.",
  ].join("\n");
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
  workflow.defaultVerificationStrategy = workflow.defaultVerificationStrategy === "local_with_screenshot"
    ? "local_with_screenshot"
    : "local_only";
  workflow.dataRetentionDays = typeof workflow.dataRetentionDays === "number" && workflow.dataRetentionDays >= 0
    ? workflow.dataRetentionDays
    : 7;
  delete workflow.safetyClass;
  delete workflow.intent;
  delete workflow.outputSchema;
  delete workflow.allowedRecoveryRequests;

  if (Array.isArray(workflow.steps)) {
    workflow.steps = workflow.steps.map((step, index) => {
      if (!isRecord(step)) return step;
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
        if (typeof params.packageName !== "string") {
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
      return normalized;
    });
    workflow.steps = ensureHumanWorkflowPreambleSteps(workflow.steps as unknown[]);
    workflow.steps = ensureHumanWorkflowEvidenceSteps(workflow.steps as unknown[], input);
  }
  return workflow;
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

function isHumanNavigationGoal(input: { platform: string; goal: string }): boolean {
  const goal = input.goal.toLowerCase();
  return input.platform.toLowerCase() === "reddit" && (
    goal.includes("mergi pe") ||
    goal.includes("go to") ||
    goal.includes("navigate") ||
    goal.includes("/r/") ||
    goal.includes("/askreddit") ||
    goal.includes("askreddit")
  );
}

function ensureHumanWorkflowEvidenceSteps(
  steps: unknown[],
  input: { platform: string; packageName: string; goal: string },
): unknown[] {
  if (!isHumanNavigationGoal(input)) return steps;
  const hasEvidenceDump = steps.some((step) => {
    if (!isRecord(step) || step.type !== "action" || step.action !== "ui_tree_dump") return false;
    const params = isRecord(step.params) ? step.params : {};
    return params.outputVariable === "_finalUiTree";
  });
  if (hasEvidenceDump) return steps;

  const evidenceStep = {
    id: "capture_final_ui_tree",
    type: "action",
    action: "ui_tree_dump",
    params: {
      packageName: input.packageName,
      outputVariable: "_finalUiTree",
    },
    timeoutMs: 10_000,
  };
  const checkpointIndex = steps.findIndex((step) => isRecord(step) && step.type === "checkpoint");
  if (checkpointIndex === -1) return [...steps, evidenceStep];
  return [
    ...steps.slice(0, checkpointIndex),
    evidenceStep,
    ...steps.slice(checkpointIndex),
  ];
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
  return {
    status: "ready",
    requestKey,
    cacheHit: source === "cache",
    cacheKey: cached.cacheKey,
    source,
    plan: humanWorkflowPlanPreview(cached.workflow, cached.compiledPlan),
    safetyClass: "read_only",
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
  async resolveTarget(deviceId: string, accountId: string): Promise<HumanWorkflowTarget | null> {
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
    accountId: string;
    intent: string;
  }): Promise<HumanWorkflowCompileResult> {
    const intent = input.intent.trim();
    const requestKey = computeHumanWorkflowRequestKey(input.deviceId, input.accountId, intent);
    const target = await this.resolveTarget(input.deviceId, input.accountId);
    if (!target) {
      throw Object.assign(new Error("Device or account not found"), { status: 400, code: "HUMAN_WORKFLOW_TARGET_NOT_FOUND" });
    }

    const cached = await workflowService.getGeneratedPlanCacheByRequestKey(requestKey);
    if (cached) return readyFromCache(cached, target, requestKey, "cache");

    const shortcutMatch = await shortcutRegistryService.lookupActiveShortcut({
      platform: target.account_platform,
      intent,
      target: { ...target },
    });
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
      if (cachedJobArtifact) return existingJob.result as HumanWorkflowCompileReady;
      const requeued = await humanWorkflowCompileJobService.requeueMissingArtifact(existingJob.id);
      existingJob = requeued ?? { ...existingJob, status: "failed", error: "compile artifact missing; retry compile" };
    }
    const job = existingJob ?? await humanWorkflowCompileJobService.createOrGet({
      requestKey,
      deviceId: input.deviceId,
      accountId: input.accountId,
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

    const target = await this.resolveTarget(existing.deviceId, existing.accountId);
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
    const packageName = humanWorkflowAppId(platform);
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
    let compiledPlan = compileGeneratedWorkflowTemplate(template);
    compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, packageName);
    await workflowService.saveTemplate(template);
    await workflowService.saveGeneratedPlanCache(template, compiledPlan, input.requestKey, {
      source: "dashboard_human",
      shortcut: shortcutKey,
      shortcutId,
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
      source: "shortcut",
      plan: humanWorkflowPlanPreview(template, compiledPlan),
      safetyClass: "read_only",
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
    const packageName = humanWorkflowAppId(platform);
    const appMap = await loadMap(packageName);
    const prompt = buildHumanWorkflowCompilePrompt({
      platform,
      packageName,
      goal: input.intent,
      target: input.target,
      appMap,
    });

    const rawWorkflow = await llmJson<WorkflowTemplate>(prompt, undefined, {
      max_tokens: 1536,
      system: "You are a Phone Network workflow compiler. Return only valid WorkflowTemplate JSON. No reasoning.",
      timeoutMs: humanWorkflowAsyncCompileTimeoutMs(),
      temperature: 0,
      disableThinking: true,
    });
    const normalizedWorkflow = normalizeHumanWorkflowTemplateCandidate(rawWorkflow, { platform, packageName, goal: input.intent });
    const validation = validateGeneratedWorkflowTemplate(normalizedWorkflow);
    if (!validation.template) {
      throw Object.assign(new Error("workflow failed validation"), {
        status: 400,
        code: "HUMAN_WORKFLOW_VALIDATION_FAILED",
        validationErrors: validation.errors,
      });
    }
    const template = validation.template;
    let compiledPlan = compileGeneratedWorkflowTemplate(template);
    compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, packageName);
    await workflowService.saveTemplate(template);
    await workflowService.saveGeneratedPlanCache(template, compiledPlan, input.requestKey, {
      source: "dashboard_human",
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
      safetyClass: "read_only",
      platform,
      target: input.target,
      llmBudget: compiledPlan.llmBudget,
    };
  }
}

export const humanWorkflowCompilerService = new HumanWorkflowCompilerService();
