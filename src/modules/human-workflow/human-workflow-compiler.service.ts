import crypto from "crypto";
import { getDb } from "../../db/client";
import { loadMap } from "../app-mapping/recorder.service";
import { validateAppMapQuality, type AppMap, type AppMapQualityReport } from "../app-mapping/schema";
import {
  buildGeneratedWorkflowAppMapCacheMetadata,
  compileGeneratedWorkflowTemplate,
  generatedWorkflowPlanUsesAppMap,
  validateGeneratedWorkflowTemplate,
  withGeneratedWorkflowAppMapCacheMetadata,
  type GeneratedWorkflowCompiledPlan,
} from "../workflows/workflow-validator";
import { workflowService, type GeneratedWorkflowPlanCacheRecord } from "../workflows/workflow.service";
import type { WorkflowGoalContract, WorkflowTemplate } from "../workflows/types";
import { llmJson, type LlmResponseMetadata } from "../../utils/llm";
import { shortcutRegistryService } from "../workflow-shortcuts/shortcut-registry.service";
import { humanWorkflowCompileJobService, type HumanWorkflowCompileJobRecord } from "./compile-job.service";
import {
  normalizeCachedHumanWorkflowTemplate,
  resolveCachedWorkflowSafetyClass,
} from "./human-workflow-normalization";
import { loadRuntimeProfile } from "../app-mapping/runtime-profile";
import {
  capabilityCatalogService,
  formatCompilerRetrievalContext,
  type CompilerRetrievalContext,
} from "./capability-catalog.service";
import { workflowGoalContractReason } from "../workflows/goal-contract";
import {
  compilerControlPlaneError,
  loadHumanWorkflowCompilerControlPlane,
  renderCompilerTemplate,
} from "./compiler-control-plane.service";
import { workflowSegmentComposer } from "../workflow-segments/composer";
import type { ComposedWorkflow } from "../workflow-segments/types";
import {
  segmentBuildJobService,
  type SegmentBuildJob,
  type SegmentBuildReason,
} from "../segment-builder/segment-build-job.service";

const ASYNC_COMPILE_RETRY_AFTER_MS = 2_000;
const DEFAULT_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS = 90_000;
const MAX_HUMAN_WORKFLOW_ASYNC_COMPILE_TIMEOUT_MS = 120_000;
const HUMAN_WORKFLOW_DEBUG_RESPONSE_MAX_CHARS = 100_000;
const HUMAN_WORKFLOW_OUTPUT_CONTRACT_VERSION = "required-v1";

export type HumanWorkflowSafetyClass = string;

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
  ready: true;
  requestKey: string;
  cacheHit: boolean;
  cacheKey: string;
  source: "cache" | "shortcut" | "llm" | "composition";
  compileJobId?: string;
  plan: Record<string, unknown>;
  safetyClass: HumanWorkflowSafetyClass;
  dashboardExecutionAllowed?: boolean;
  safetyPresentationColor?: string;
  dashboardBlockedReason?: string;
  platform: string;
  target: HumanWorkflowTarget;
  llmBudget?: Record<string, unknown>;
  shortcutId?: string | null;
  llmDebug?: HumanWorkflowLlmDebug;
  architecture?: "segments-v1";
  capabilityKey?: string;
  compositionName?: string;
  compositionVersion?: string;
  compositionKey?: string;
  executionKey?: string;
  segmentKeys?: string[];
  segmentRefs?: Array<{ segmentKey: string; segmentVersion: string }>;
  runtimeInputs?: Record<string, unknown>;
  publicRuntimeInputs?: Record<string, unknown>;
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
  ready: false;
  requestKey: string;
  compileJobId: string;
  retryAfterMs: number;
  source: "llm";
};

export type HumanWorkflowSegmentBuildAccepted = {
  ready: false;
  requestKey: string;
  segmentBuildJobId: string;
  retryAfterMs: number;
  source: "agent";
  reason: SegmentBuildReason;
};

export type HumanWorkflowCompileResult =
  | HumanWorkflowCompileReady
  | HumanWorkflowCompileAccepted
  | HumanWorkflowSegmentBuildAccepted;

export function computeHumanWorkflowRequestKey(deviceId: string, accountId: string | null | undefined, intent: string): string {
  const accountKey = accountId && accountId.trim().length > 0 ? accountId : "device";
  return crypto
    .createHash("sha256")
    .update(`${deviceId}:${accountKey}:${intent.trim()}`)
    .digest("hex")
    .slice(0, 24);
}

export function completedSegmentBuildCapabilityKey(
  job: Pick<SegmentBuildJob, "result">,
): string | null {
  const value = job.result.capabilityKey;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function humanWorkflowCatalogHasCapability(
  context: Pick<CompilerRetrievalContext, "matchedCapabilityKey">,
): boolean {
  return typeof context.matchedCapabilityKey === "string"
    && context.matchedCapabilityKey.length > 0;
}

async function humanWorkflowPackageName(platform: string): Promise<string> {
  const profile = await loadRuntimeProfile(platform);
  if (!profile) {
    throw compilerControlPlaneError(`missing runtime profile ${platform}`);
  }
  return profile.packageName;
}

async function resolveHumanWorkflowPlatform(goal: string): Promise<string | null> {
  const result = await getDb().query<{ app_id: string }>(
    "SELECT app_id FROM resolve_human_workflow_platform($1)",
    [goal],
  );
  return result.rows[0]?.app_id ?? null;
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

function humanWorkflowCacheUsable(
  cached: GeneratedWorkflowPlanCacheRecord,
  compilerVersion: string,
): boolean {
  return humanWorkflowCacheCompilerVersion(cached) === compilerVersion
    && cached.sourceMetadata?.outputContractVersion === HUMAN_WORKFLOW_OUTPUT_CONTRACT_VERSION;
}

export function humanWorkflowExactCacheUsable(
  cached: GeneratedWorkflowPlanCacheRecord,
  compilerVersion: string,
): boolean {
  if (
    cached.sourceMetadata?.architecture === "segments-v1"
    || typeof cached.sourceMetadata?.compositionKey === "string"
    || typeof cached.sourceMetadata?.compositionName === "string"
  ) {
    return false;
  }
  if (humanWorkflowCacheUsable(cached, compilerVersion)) return true;
  return (cached.workflow.outputSchema?.required?.length ?? 0) > 0
    && (cached.workflow.postconditionContract?.all?.length ?? 0) > 0;
}

export function humanWorkflowArtifactMatchesIntent(
  cached: GeneratedWorkflowPlanCacheRecord,
  intent: string,
): boolean {
  const artifactIntent = cached.sourceMetadata?.intent;
  return typeof artifactIntent === "string" && artifactIntent.trim() === intent.trim();
}

function assertHumanWorkflowOutputContract(template: WorkflowTemplate): void {
  if ((template.outputSchema?.required?.length ?? 0) > 0) return;
  throw Object.assign(new Error("dashboard human workflow requires at least one materialized output"), {
    status: 422,
    code: "HUMAN_WORKFLOW_OUTPUT_CONTRACT_REQUIRED",
    retryable: true,
    nextAction: "retry_compile",
  });
}

function inferGeneratedWorkflowAppId(template: WorkflowTemplate): string | null {
  for (const step of template.steps) {
    if (step.type !== "action") continue;
    const packageName = step.params?.packageName;
    if (typeof packageName === "string" && packageName.trim().length > 0) return packageName;
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

export function humanWorkflowUndercompiledReason(workflow: WorkflowTemplate, _intent: string): string | null {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) return "workflow has no steps";
  const actionSteps = steps.filter((step) => step.type === "action");
  if (actionSteps.length === 0) return "workflow has no executable action steps";
  return workflowGoalContractReason(workflow);
}

function humanWorkflowPackageInventoryReason(
  workflow: WorkflowTemplate,
  expectedPackageName: string,
): string | null {
  for (const step of workflow.steps) {
    if (step.type !== "action" || step.params?.packageName === undefined) continue;
    const actual = typeof step.params.packageName === "string" ? step.params.packageName.trim() : "";
    if (!actual) return `${step.id} has an invalid packageName`;
    if (actual !== expectedPackageName) {
      return `${step.id} packageName is not present in the selected PostgreSQL runtime profile`;
    }
  }
  return null;
}

export function assertHumanWorkflowMeaningful(
  workflow: WorkflowTemplate,
  intent: string,
  expectedContract?: WorkflowGoalContract | null,
): void {
  const reason = workflowGoalContractReason(workflow, expectedContract)
    ?? humanWorkflowUndercompiledReason(workflow, intent);
  if (!reason) return;
  throw Object.assign(new Error(`human workflow undercompiled: ${reason}`), {
    status: 422,
    code: "HUMAN_WORKFLOW_UNDERCOMPILED",
    retryable: true,
    nextAction: "retry_compile",
  });
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

function dashboardExecutionPolicy(metadata: Record<string, unknown> | null | undefined): {
  dashboardExecutionAllowed?: boolean;
  safetyPresentationColor?: string;
  dashboardBlockedReason?: string;
} {
  const raw = metadata?.dashboardPolicy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const policy = raw as Record<string, unknown>;
  return {
    ...(typeof policy.executionAllowed === "boolean"
      ? { dashboardExecutionAllowed: policy.executionAllowed }
      : {}),
    ...(typeof policy.presentationColor === "string"
      ? { safetyPresentationColor: policy.presentationColor }
      : {}),
    ...(typeof policy.blockedReason === "string"
      ? { dashboardBlockedReason: policy.blockedReason }
      : {}),
  };
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
  const safetyClass = resolveCachedWorkflowSafetyClass(
    cached as unknown as Record<string, unknown>,
  );
  return {
    ready: true,
    requestKey,
    cacheHit: source === "cache",
    cacheKey: cached.cacheKey,
    source,
    plan: humanWorkflowPlanPreview(workflow, cached.compiledPlan),
    safetyClass,
    ...dashboardExecutionPolicy(cached.sourceMetadata),
    platform: target.account_platform,
    target,
    llmBudget: cached.compiledPlan.llmBudget,
  };
}

async function readyFromComposition(
  composed: ComposedWorkflow,
  target: HumanWorkflowTarget,
  executable = true,
): Promise<HumanWorkflowCompileReady> {
  const compiledPlan = compileGeneratedWorkflowTemplate(composed.template);
  let cached = await workflowService.getGeneratedPlanCache(compiledPlan.cacheKey);
  if (!cached) {
    const save = executable
      ? workflowService.saveExecutableGeneratedPlanCache.bind(workflowService)
      : workflowService.saveCandidateExecutableGeneratedPlanCache.bind(workflowService);
    await save(
      composed.template,
      compiledPlan,
      undefined,
      {
        source: "dashboard_human",
        architecture: composed.architecture,
        ...compositionCapabilityMetadata(composed),
        compositionName: composed.compositionName,
        compositionVersion: composed.compositionVersion,
        compositionKey: composed.compositionKey,
        segmentKeys: composed.segmentKeys,
        segmentRefs: composed.segmentRefs,
        outputContractVersion: HUMAN_WORKFLOW_OUTPUT_CONTRACT_VERSION,
      },
    );
    cached = await workflowService.getGeneratedPlanCache(compiledPlan.cacheKey, {
      includeCandidate: !executable,
    });
  }
  if (!cached) {
    throw Object.assign(new Error("composed workflow artifact could not be persisted"), {
      code: "WORKFLOW_COMPOSITION_PERSISTENCE_FAILED",
    });
  }
  return {
    ready: true,
    requestKey: composed.requestKey,
    cacheHit: true,
    cacheKey: cached.cacheKey,
    source: "composition",
    plan: humanWorkflowPlanPreview(composed.template, compiledPlan),
    safetyClass: composed.template.safetyClass!,
    platform: target.account_platform,
    target,
    llmBudget: compiledPlan.llmBudget,
    architecture: composed.architecture,
    capabilityKey: composed.capabilityKey,
    compositionName: composed.compositionName,
    compositionVersion: composed.compositionVersion,
    compositionKey: composed.compositionKey,
    executionKey: composed.executionKey,
    segmentKeys: composed.segmentKeys,
    segmentRefs: composed.segmentRefs,
    runtimeInputs: composed.runtimeInputs,
    publicRuntimeInputs: composed.publicRuntimeInputs,
  };
}

export function compositionCapabilityMetadata(
  composed: Pick<ComposedWorkflow, "capabilityKey" | "template">,
): {
  capabilityKey: string;
  capabilityRole: "complete";
  goalContract: WorkflowGoalContract | undefined;
} {
  return {
    capabilityKey: composed.capabilityKey,
    capabilityRole: "complete",
    goalContract: composed.template.goalContract,
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
      const platform = await resolveHumanWorkflowPlatform(intent);
      if (!platform) {
        throw Object.assign(new Error("No PostgreSQL runtime profile covers this intent"), {
          status: 422,
          code: "HUMAN_WORKFLOW_RUNTIME_PROFILE_REQUIRED",
          retryable: true,
          nextAction: "configure_runtime_profile",
        });
      }
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
    const explicitPlatform = intent ? await resolveHumanWorkflowPlatform(intent) : null;
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

  async compileCandidateComposition(input: {
    compositionName: string;
    compositionVersion: string;
    deviceId: string;
    accountId?: string | null;
    intent: string;
  }): Promise<HumanWorkflowCompileReady> {
    const intent = input.intent.trim();
    const requestKey = computeHumanWorkflowRequestKey(input.deviceId, input.accountId, intent);
    const target = await this.resolveTarget(input.deviceId, input.accountId, intent);
    if (!target) {
      throw Object.assign(new Error("Device or account not found"), {
        status: 400,
        code: "HUMAN_WORKFLOW_TARGET_NOT_FOUND",
      });
    }
    const composed = await workflowSegmentComposer.composeCandidate({
      compositionName: input.compositionName,
      compositionVersion: input.compositionVersion,
      platform: target.account_platform,
      intent,
      requestKey,
      deviceId: input.deviceId,
      accountId: input.accountId ?? null,
    });
    if (!composed) {
      throw Object.assign(new Error("candidate workflow composition not found"), {
        status: 404,
        code: "WORKFLOW_COMPOSITION_CANDIDATE_NOT_FOUND",
      });
    }
    return readyFromComposition(composed, target, false);
  }

  async compile(input: {
    deviceId: string;
    accountId?: string | null;
    intent: string;
    requestKey?: string;
  }): Promise<HumanWorkflowCompileResult> {
    const intent = input.intent.trim();
    const controlPlane = await loadHumanWorkflowCompilerControlPlane();
    const requestKey = input.requestKey ?? computeHumanWorkflowRequestKey(input.deviceId, input.accountId, intent);
    const target = await this.resolveTarget(input.deviceId, input.accountId, intent);
    if (!target) {
      throw Object.assign(new Error("Device or account not found"), { status: 400, code: "HUMAN_WORKFLOW_TARGET_NOT_FOUND" });
    }

    const exactCached = await workflowService.getGeneratedPlanCacheByRequestKey(requestKey);
    if (
      exactCached
      && humanWorkflowExactCacheUsable(exactCached, controlPlane.version)
      && humanWorkflowArtifactMatchesIntent(exactCached, intent)
    ) {
      return readyFromCache(exactCached, target, requestKey, "cache");
    }

    const catalogContext = await capabilityCatalogService.retrieve(
      intent,
      target.account_platform,
      controlPlane.retrievalPolicy,
    );
    if (!humanWorkflowCatalogHasCapability(catalogContext)) {
      const job = await segmentBuildJobService.createOrGet({
        requestKey,
        deviceId: input.deviceId,
        accountId: input.accountId ?? null,
        intent,
        platform: target.account_platform,
        reason: "capability_missing",
      });
      if (await segmentBuildJobService.isSuccessful(job)) {
        const builtCapabilityKey = completedSegmentBuildCapabilityKey(job);
        if (!builtCapabilityKey) {
          throw Object.assign(new Error("completed segment-build job has no capability result"), {
            status: 409,
            code: "SEGMENT_BUILD_RESULT_MISSING",
          });
        }
        const built = await workflowSegmentComposer.compose({
          capabilityKey: builtCapabilityKey,
          platform: target.account_platform,
          intent,
          requestKey,
          deviceId: input.deviceId,
          accountId: input.accountId ?? null,
        });
        if (!built) {
          throw Object.assign(new Error("completed segment-build job has no promoted composition"), {
            status: 409,
            code: "SEGMENT_BUILD_COMPOSITION_MISSING",
          });
        }
        return readyFromComposition(built, target);
      }
      segmentBuildJobService.dispatchInBackground(job);
      return {
        ready: false,
        requestKey,
        segmentBuildJobId: job.id,
        retryAfterMs: ASYNC_COMPILE_RETRY_AFTER_MS,
        source: "agent",
        reason: "capability_missing",
      };
    }
    const matchedCapabilityKey = catalogContext.matchedCapabilityKey!;
    const composed = await workflowSegmentComposer.compose({
      capabilityKey: matchedCapabilityKey,
      platform: target.account_platform,
      intent,
      requestKey,
      deviceId: input.deviceId,
      accountId: input.accountId ?? null,
    });
    if (composed) return readyFromComposition(composed, target);
    if (catalogContext.matchedCapabilityMetadata?.compositionEnabled === true) {
      const job = await segmentBuildJobService.createOrGet({
        requestKey,
        deviceId: input.deviceId,
        accountId: input.accountId ?? null,
        intent,
        platform: target.account_platform,
        capabilityKey: matchedCapabilityKey,
        reason: "composition_missing",
      });
      segmentBuildJobService.dispatchInBackground(job);
      return {
        ready: false,
        requestKey,
        segmentBuildJobId: job.id,
        retryAfterMs: ASYNC_COMPILE_RETRY_AFTER_MS,
        source: "agent",
        reason: "composition_missing",
      };
    }
    if (!catalogContext.goalContract) {
      throw Object.assign(new Error("PostgreSQL capability has no Goal Contract and no promoted composition"), {
        status: 409,
        code: "HUMAN_WORKFLOW_CAPABILITY_CONTRACT_MISSING",
        retryable: true,
        nextAction: "configure_capability",
      });
    }

    if (catalogContext.fullArtifactCacheKey) {
      const catalogArtifact = await workflowService.getGeneratedPlanCache(catalogContext.fullArtifactCacheKey);
      if (
        catalogArtifact
        && humanWorkflowCacheUsable(catalogArtifact, controlPlane.version)
        && humanWorkflowArtifactMatchesIntent(catalogArtifact, intent)
      ) {
        return readyFromCache(catalogArtifact, target, requestKey, "cache");
      }
    }

    const shortcutMatch = target.account_id
      ? await shortcutRegistryService.lookupActiveShortcut({
          platform: target.account_platform,
          intent,
          target: { ...target, account_id: target.account_id, account_username: target.account_username ?? "" },
        })
      : null;
    if (shortcutMatch) {
      const shortcutSafetyClass = catalogContext.recommendedSafetyClass
        ? controlPlane.safetyClassMap[catalogContext.recommendedSafetyClass]
        : null;
      if (!shortcutSafetyClass) {
        throw compilerControlPlaneError("selected shortcut capability has no configured safety mapping");
      }
      await shortcutRegistryService.recordHit(shortcutMatch.shortcut.id);
      const ready = await this.compileShortcut(shortcutMatch.shortcut.id, shortcutMatch.shortcut.key, shortcutMatch.shortcut.workflowTemplate, {
        requestKey,
        intent,
        target,
      }, controlPlane.version, catalogContext.goalContract, shortcutSafetyClass);
      return ready;
    }

    const job = await humanWorkflowCompileJobService.createOrGet({
      requestKey,
      deviceId: input.deviceId,
      accountId: input.accountId ?? null,
      intent,
      platform: target.account_platform,
    });
    const state = await humanWorkflowCompileJobService.state(job);
    if (state?.terminal && !state.retryable && !state.administrative && job.result) {
      return job.result as HumanWorkflowCompileReady;
    }
    humanWorkflowCompileJobService.runInProcess(job.id, () => this.compileWithLlm({
      requestKey: job.requestKey,
      intent: job.intent,
      target,
    }));
    return {
      ready: false,
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
    const state = await humanWorkflowCompileJobService.state(existing);
    if (!state?.terminal || !state.retryable) return existing;

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
    compilerVersion: string,
    expectedContract: WorkflowGoalContract,
    expectedSafetyClass: HumanWorkflowSafetyClass,
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
    assertHumanWorkflowOutputContract(template);
    if (template.safetyClass !== expectedSafetyClass) {
      throw Object.assign(new Error("shortcut safetyClass does not match PostgreSQL capability policy"), {
        status: 422,
        code: "HUMAN_WORKFLOW_CONTROL_PLANE_MISMATCH",
      });
    }
    assertHumanWorkflowMeaningful(template, input.intent, expectedContract);
    let compiledPlan = compileGeneratedWorkflowTemplate(template);
    compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, packageName);
    await workflowService.saveTemplate(template);
    await workflowService.saveExecutableGeneratedPlanCache(template, compiledPlan, input.requestKey, {
        source: "dashboard_human",
        compilerCacheVersion: compilerVersion,
        outputContractVersion: HUMAN_WORKFLOW_OUTPUT_CONTRACT_VERSION,
        shortcut: shortcutKey,
        shortcutId,
        intent: input.intent,
        deviceId: input.target.device_id,
        accountId: input.target.account_id,
        platform,
        compiledAt: new Date().toISOString(),
    });
    return {
      ready: true,
      requestKey: input.requestKey,
      cacheHit: false,
      cacheKey: compiledPlan.cacheKey,
      source: "shortcut",
      plan: humanWorkflowPlanPreview(template, compiledPlan),
      safetyClass: (template.safetyClass ?? compiledPlan.metadata.safetyClass)!,
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
    const controlPlane = await loadHumanWorkflowCompilerControlPlane();
    const platform = input.target.account_platform;
    const retrievalContext = await capabilityCatalogService.retrieve(
      input.intent,
      platform,
      controlPlane.retrievalPolicy,
    );
    if (!retrievalContext.matchedCapabilityKey || !retrievalContext.goalContract || !retrievalContext.recommendedSafetyClass) {
      throw Object.assign(new Error("No PostgreSQL capability and Goal Contract cover this intent"), {
        status: 422,
        code: "HUMAN_WORKFLOW_CAPABILITY_CONTRACT_REQUIRED",
        retryable: true,
        nextAction: "configure_capability",
      });
    }
    if (retrievalContext.fullArtifactCacheKey) {
      const cached = await workflowService.getGeneratedPlanCache(retrievalContext.fullArtifactCacheKey);
      if (
        cached
        && humanWorkflowCacheUsable(cached, controlPlane.version)
        && humanWorkflowArtifactMatchesIntent(cached, input.intent)
      ) {
        return readyFromCache(cached, input.target, input.requestKey, "cache");
      }
    }
    const safetyClass = controlPlane.safetyClassMap[retrievalContext.recommendedSafetyClass];
    if (!safetyClass) throw compilerControlPlaneError("selected capability safety class has no configured mapping");
    const enforceRetrievedSafetyClass = safetyClass;
    const packageName = await humanWorkflowPackageName(platform);
    const runtimeProfile = await loadRuntimeProfile(platform);
    if (!runtimeProfile) throw compilerControlPlaneError(`missing runtime profile ${platform}`);
    const prompt = renderCompilerTemplate(controlPlane.prompts.compile, {
      goal: input.intent,
      targetContext: JSON.stringify({
        platform,
        account: input.target.account_username,
        deviceId: input.target.device_id,
        previewCompileOnly: true,
        safetyClass,
      }),
      runtimeProfile: JSON.stringify({
        appId: runtimeProfile.appId,
        appName: runtimeProfile.appName,
        packageName: runtimeProfile.packageName,
        safetyPolicy: runtimeProfile.safetyPolicy,
        metadata: runtimeProfile.metadata,
      }),
      retrievalContext: formatCompilerRetrievalContext(retrievalContext),
      toolCatalog: JSON.stringify(controlPlane.toolCatalog),
      compilerPolicy: controlPlane.prompts.policy,
    });

    const llmDebug: HumanWorkflowLlmDebug = {
      sensitive: true,
      compilerCacheVersion: controlPlane.version,
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
        max_tokens: controlPlane.llm.initialMaxTokens,
        system: controlPlane.prompts.compileSystem,
        timeoutMs: humanWorkflowAsyncCompileTimeoutMs(),
        temperature: controlPlane.llm.temperature,
        disableThinking: controlPlane.llm.disableThinking,
        onRawResponse: captureAttempt(1, controlPlane.llm.initialMaxTokens),
      });
      let validation = validateGeneratedWorkflowTemplate(rawWorkflow);
      let template = validation.template;
      const correctiveReason = template
        ? template.platform !== platform
          ? "workflow platform does not match the PostgreSQL runtime profile"
          : template.safetyClass !== enforceRetrievedSafetyClass
          ? "workflow safetyClass does not match the PostgreSQL compiler control plane"
          : retrievalContext.goalContract && !template.goalContract
          ? "LLM-compiled human workflow is missing mandatory workflow.goalContract"
          : humanWorkflowPackageInventoryReason(template, packageName)
          ?? workflowGoalContractReason(template, retrievalContext.goalContract)
          ?? humanWorkflowUndercompiledReason(template, input.intent)
        : `workflow validation failed: ${validation.errors.join("; ")}`;
      if (correctiveReason) {
        rawWorkflow = await llmJson<WorkflowTemplate>(renderCompilerTemplate(controlPlane.prompts.repair, {
          compilePrompt: prompt,
          rejectedWorkflow: JSON.stringify(rawWorkflow),
          reason: correctiveReason,
        }), undefined, {
          max_tokens: controlPlane.llm.repairMaxTokens,
          system: controlPlane.prompts.repairSystem,
          timeoutMs: humanWorkflowAsyncCompileTimeoutMs(),
          temperature: controlPlane.llm.temperature,
          disableThinking: controlPlane.llm.disableThinking,
          onRawResponse: captureAttempt(2, controlPlane.llm.repairMaxTokens),
        });
        validation = validateGeneratedWorkflowTemplate(rawWorkflow);
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
      if (retrievalContext.goalContract && !template.goalContract) {
        throw Object.assign(new Error("workflow is missing mandatory goal contract"), {
          status: 422,
          code: "HUMAN_WORKFLOW_GOAL_CONTRACT_REQUIRED",
          retryable: true,
          nextAction: "retry_compile",
        });
      }
      if (template.platform !== platform || template.safetyClass !== enforceRetrievedSafetyClass) {
        throw Object.assign(new Error("workflow does not match PostgreSQL platform/safety policy"), {
          status: 422,
          code: "HUMAN_WORKFLOW_CONTROL_PLANE_MISMATCH",
          retryable: true,
          nextAction: "retry_compile",
        });
      }
      const packageInventoryReason = humanWorkflowPackageInventoryReason(template, packageName);
      if (packageInventoryReason) {
        throw Object.assign(new Error(`workflow package inventory validation failed: ${packageInventoryReason}`), {
          status: 400,
          code: "HUMAN_WORKFLOW_VALIDATION_FAILED",
          validationErrors: [packageInventoryReason],
        });
      }
      assertHumanWorkflowMeaningful(template, input.intent, retrievalContext.goalContract);
      assertHumanWorkflowOutputContract(template);
      const resolvedSafetyClass = template.safetyClass ?? safetyClass;
      let compiledPlan = compileGeneratedWorkflowTemplate(template);
      compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, packageName);
      await workflowService.saveExecutableGeneratedPlanCache(template, compiledPlan, input.requestKey, {
        source: "dashboard_human",
        compilerCacheVersion: controlPlane.version,
        outputContractVersion: HUMAN_WORKFLOW_OUTPUT_CONTRACT_VERSION,
        intent: input.intent,
        deviceId: input.target.device_id,
        accountId: input.target.account_id,
        platform,
        compiledAt: new Date().toISOString(),
        capabilityKey: retrievalContext.matchedCapabilityKey,
        capabilityRole: "complete",
        goalContract: template.goalContract,
        dashboardPolicy: retrievalContext.matchedCapabilityMetadata?.dashboardPolicy,
        compilerRetrieval: {
          capabilityKey: retrievalContext.matchedCapabilityKey,
          capabilityScore: retrievalContext.matchedCapabilityScore,
          promotedArtifactCount: retrievalContext.knowledge.promotedArtifacts.length,
          promotedSelectorCount: retrievalContext.knowledge.uiGraph.selectors.length,
          promotedTransitionCount: retrievalContext.knowledge.uiGraph.transitions.length,
          avoidedFailureCount: retrievalContext.knowledge.avoid.length,
        },
      });
      return {
        ready: true,
        requestKey: input.requestKey,
        cacheHit: false,
        cacheKey: compiledPlan.cacheKey,
        source: "llm",
        plan: humanWorkflowPlanPreview(template, compiledPlan),
        safetyClass: resolvedSafetyClass,
        ...dashboardExecutionPolicy(retrievalContext.matchedCapabilityMetadata),
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

humanWorkflowCompileJobService.configureRunner(async (job) => {
  const target = await humanWorkflowCompilerService.resolveTarget(
    job.deviceId,
    job.accountId,
    job.intent,
  );
  if (!target) {
    throw Object.assign(new Error("Device or account not found"), {
      status: 400,
      code: "HUMAN_WORKFLOW_TARGET_NOT_FOUND",
    });
  }
  return humanWorkflowCompilerService.compileWithLlm({
    requestKey: job.requestKey,
    intent: job.intent,
    target,
  });
});
