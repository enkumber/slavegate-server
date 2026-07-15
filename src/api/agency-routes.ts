/**
 * api/agency-routes.ts
 * REST API routes for Marketing Agency — clients, materials, posts, tasks, reports.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAdminAuth } from "./auth.middleware";
import { getDb } from "../db/client";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { workflowEvents } from "../modules/workflow-events";
import { listToolCatalog } from "../modules/tool-catalog/tool-catalog";
import { listCompilerKnowledge } from "../modules/compiler-knowledge/compiler-knowledge-base";
import { buildCompilerAwareness } from "../modules/compiler-awareness/compiler-awareness";
import { buildCompilerControlPlane } from "../modules/compiler-control-plane/compiler-control-plane";
import { listCompilerPolicyGatesWithConfig } from "../modules/compiler-policy-gates/compiler-policy-gates";
import {
  buildWorkflowDefinitionResolution,
  rowToWorkflowDefinition,
  workflowDefinitionScopeFor,
  workflowDefinitionToExecutableTemplate,
  workflowDefinitionRegistryPolicy,
} from "../modules/workflow-definition-registry/workflow-definition-registry";
import {
  buildWorkflowValidationPipeline,
  workflowValidationPipelinePolicy,
} from "../modules/workflow-validation-pipeline/workflow-validation-pipeline";
import { workflowService } from "../modules/workflows/workflow.service";
import { compileGeneratedWorkflowTemplate } from "../modules/workflows/workflow-validator";
import { taskRunnerService } from "../modules/task-runner";

const router = Router();

const SPRINT_2_READ_ONLY_INTENTS = new Set(["reddit_account_health_scan"]);

const GENERATED_WORKFLOW_KEY_RE = /^[a-f0-9]{24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publishAgencyWorkflowQueued(input: {
  agencyWorkflowRunId: string;
  taskId: string;
  clientId?: string | null;
  accountId?: string | null;
  deviceId: string;
  intent: string;
  platform?: string;
}): void {
  workflowEvents.publish({
    source: "agency",
    event: "queued",
    taskId: input.taskId,
    agencyWorkflowRunId: input.agencyWorkflowRunId,
    clientId: input.clientId ?? undefined,
    accountId: input.accountId ?? undefined,
    deviceId: input.deviceId,
    mode: "edge",
    status: "queued",
    message: "Generated workflow task queued",
    details: {
      intent: input.intent,
      platform: input.platform,
    },
  });
}

function computeWorkflowDefinitionAutoUseRequestKey(input: {
  definitionId: string;
  definitionVersion: number;
  deviceId: string;
  accountId?: string | null;
}): string {
  return crypto
    .createHash("sha256")
    .update([
      "workflow-definition-auto-use",
      input.definitionId,
      String(input.definitionVersion),
      input.deviceId,
      input.accountId ?? "device",
    ].join(":"))
    .digest("hex")
    .slice(0, 24);
}

// ─── Pagination helper ────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, parseInt(query.page as string ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize as string ?? "50", 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function rowToAgencyWorkflowRun(row: Record<string, unknown>): Record<string, unknown> {
  const deviceId = row.device_id as string;
  const feedbackRating = typeof row.feedback_rating === "string" ? row.feedback_rating : null;
  const output: Record<string, unknown> = {
    id: row.id,
    clientId: row.client_id,
    accountId: row.account_id,
    deviceId,
    shortDeviceId: deviceId?.slice(0, 8),
    taskId: row.task_id ?? null,
    workflowId: row.workflow_id ?? null,
    platform: row.platform,
    intent: row.intent,
    safetyClass: row.safety_class,
    requestKey: row.request_key ?? null,
    cacheKey: row.cache_key ?? null,
    canonicalWorkflowId: row.canonical_workflow_id,
    canonicalWorkflowVersion: row.canonical_workflow_version,
    compiledPlanHash: row.compiled_plan_hash,
    status: row.status,
    output: row.output ?? {},
    tokenUsage: row.token_usage ?? {},
    recoveryRequests: row.recovery_requests ?? 0,
    error: row.error ?? null,
    context: row.context ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ?? null,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ?? null,
    accountUsername: row.account_username ?? null,
    accountPlatform: row.account_platform ?? null,
    clientName: row.client_name ?? null,
    deviceName: row.device_name ?? null,
    feedback: feedbackRating
      ? {
          rating: feedbackRating,
          lastGoodStepIndex: typeof row.feedback_last_good_step_index === "number" ? row.feedback_last_good_step_index : null,
          note: row.feedback_note ?? null,
          source: row.feedback_source ?? null,
          at: row.feedback_at instanceof Date ? row.feedback_at.toISOString() : row.feedback_at ?? null,
        }
      : null,
  };
  if (row.include_timeline === true) {
    output.artifactState = row.artifact_state ?? null;
    output.workflowStatus = row.workflow_status ?? null;
    output.timeline = buildAgencyWorkflowTimeline(row);
    output.stepCandidates = normalizeJsonArray(row.step_candidates).map(rowToStepCandidate);
  }
  return output;
}

function rowToStepCandidate(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    stepIndex: row.step_index,
    stepId: row.step_id ?? null,
    label: row.label,
    action: row.action ?? null,
    type: row.type ?? null,
    stepStatus: row.step_status ?? null,
    candidateState: row.candidate_state,
    requestKey: row.request_key ?? null,
    cacheKey: row.cache_key ?? null,
    canonicalWorkflowId: row.canonical_workflow_id ?? null,
    canonicalWorkflowVersion: row.canonical_workflow_version ?? null,
    lastGoodStepIndex: row.last_good_step_index,
    stepSnapshot: row.step_snapshot ?? {},
    evidence: row.evidence ?? {},
    note: row.note ?? null,
    reviewNote: row.review_note ?? null,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at ?? null,
    validationContract: row.validation_contract ?? {},
    validationEvidence: row.validation_evidence ?? {},
    validatedBy: row.validated_by ?? null,
    validatedAt: row.validated_at instanceof Date ? row.validated_at.toISOString() : row.validated_at ?? null,
    libraryState: row.library_state ?? "review_only",
    promotionScope: row.promotion_scope ?? null,
    promotionNote: row.promotion_note ?? null,
    promotedBy: row.promoted_by ?? null,
    promotedAt: row.promoted_at instanceof Date ? row.promoted_at.toISOString() : row.promoted_at ?? null,
    revokedBy: row.revoked_by ?? null,
    revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at ?? null,
    runStatus: row.run_status ?? null,
    runIntent: row.run_intent ?? null,
    deviceName: row.device_name ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
  };
}

function rowToStepLibraryEntry(row: Record<string, unknown>): Record<string, unknown> {
  const candidate = rowToStepCandidate(row);
  const contract = normalizeJsonObject(row.validation_contract);
  const contractScope = typeof contract.scope === "string" && contract.scope.trim().length > 0
    ? contract.scope.trim()
    : "manual_review";
  const promotionScope = typeof row.promotion_scope === "string" && row.promotion_scope.trim().length > 0
    ? row.promotion_scope.trim()
    : null;
  const libraryState = typeof row.library_state === "string" ? row.library_state : "review_only";
  const effectiveScope = promotionScope ?? contractScope;
  const preconditions = nonEmptyStringArray(contract.preconditions);
  const postconditions = nonEmptyStringArray(contract.postconditions);
  const compatibility = normalizeJsonObject(contract.compatibility);
  const evidence = normalizeJsonObject(row.validation_evidence);
  const limitedReuse = libraryState === "limited_reuse" && !!promotionScope;
  const gates = {
    validatedStep: row.candidate_state === "validated_step",
    contractPresent: Object.keys(contract).length > 0,
    preconditionsPresent: preconditions.length > 0,
    postconditionsPresent: postconditions.length > 0,
    evidencePresent: Object.keys(evidence).length > 0,
    compatibilityDeclared: Object.keys(compatibility).length > 0,
    successfulSourceStep: row.step_status === "succeeded",
    successfulSourceRun: row.run_status === "completed",
    scopedReuse: contractScope !== "manual_review",
    limitedReusePromoted: limitedReuse,
    compilerAutoUseEnabled: false,
  };
  const blockers: string[] = [];
  if (!gates.preconditionsPresent) blockers.push("missing_preconditions");
  if (!gates.postconditionsPresent) blockers.push("missing_postconditions");
  if (!gates.evidencePresent) blockers.push("missing_validation_evidence");
  if (!gates.compatibilityDeclared) blockers.push("missing_compatibility");
  if (!gates.successfulSourceStep) blockers.push("source_step_not_succeeded");
  if (!gates.successfulSourceRun) blockers.push("source_run_not_completed");
  if (!gates.scopedReuse) blockers.push("reuse_scope_not_explicit");
  if (!gates.limitedReusePromoted) blockers.push("limited_reuse_not_promoted");
  if (libraryState === "revoked") blockers.push("limited_reuse_revoked");
  blockers.push("compiler_auto_use_disabled");

  const readyGateCount = [
    gates.validatedStep,
    gates.contractPresent,
    gates.preconditionsPresent,
    gates.postconditionsPresent,
    gates.evidencePresent,
    gates.compatibilityDeclared,
    gates.successfulSourceStep,
    gates.successfulSourceRun,
    gates.scopedReuse,
    gates.limitedReusePromoted,
  ].filter(Boolean).length;
  const readinessScore = Math.round((readyGateCount / 10) * 100) / 100;
  const readinessState = blockers.length === 1 && blockers[0] === "compiler_auto_use_disabled"
    ? "limited_reuse_ready"
    : blockers.length === 2 && blockers.includes("limited_reuse_not_promoted") && blockers.includes("compiler_auto_use_disabled")
      ? "review_ready"
    : "needs_review";
  return {
    id: row.id,
    stepCandidateId: row.id,
    name: row.label,
    action: row.action ?? null,
    type: row.type ?? null,
    status: "validated_step",
    libraryState,
    reuseScope: effectiveScope,
    promotionScope,
    reusable: limitedReuse,
    compilerEligible: false,
    confidence: readinessScore,
    readiness: {
      state: readinessState,
      score: readinessScore,
      threshold: 0.9,
      gates,
      blockers,
      notes: [
        limitedReuse
          ? "Step is promoted for limited-scope reuse only."
          : "Step is validated but still waiting for explicit limited-scope promotion.",
        "Compiler auto-use remains disabled until a later explicit compiler policy.",
      ],
    },
    contract,
    evidence,
    preconditions,
    postconditions,
    compatibility,
    sourceCandidate: candidate,
    runId: row.run_id,
    runIntent: row.run_intent ?? null,
    runStatus: row.run_status ?? null,
    deviceName: row.device_name ?? null,
    validatedBy: row.validated_by ?? null,
    validatedAt: row.validated_at instanceof Date ? row.validated_at.toISOString() : row.validated_at ?? null,
    promotionNote: row.promotion_note ?? null,
    promotedBy: row.promoted_by ?? null,
    promotedAt: row.promoted_at instanceof Date ? row.promoted_at.toISOString() : row.promoted_at ?? null,
    revokedBy: row.revoked_by ?? null,
    revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
  };
}

function rowToStepLibraryPromotionEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    stepCandidateId: row.step_candidate_id,
    action: row.action,
    libraryState: row.library_state,
    promotionScope: row.promotion_scope ?? null,
    note: row.note ?? null,
    actor: row.actor ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
    stepName: row.step_name ?? null,
    stepAction: row.step_action ?? null,
    runIntent: row.run_intent ?? null,
    deviceName: row.device_name ?? null,
  };
}

function policyGateId(gate: Record<string, unknown>): string | null {
  return typeof gate.id === "string" && gate.id.trim().length > 0 ? gate.id.trim() : null;
}

function collectPolicyGatesFromValue(value: unknown, out: Map<string, Record<string, unknown>>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPolicyGatesFromValue(item, out);
    return;
  }

  const object = value as Record<string, unknown>;
  const policyGates = normalizeJsonArray(object.policyGates);
  for (const gate of policyGates) {
    const id = policyGateId(gate);
    if (id && !out.has(id)) out.set(id, gate);
  }
  const decisionGates = normalizeJsonArray(object.policyGateSummary);
  for (const gate of decisionGates) {
    const id = policyGateId(gate);
    if (id && !out.has(id)) out.set(id, gate);
  }

  for (const nested of Object.values(object)) {
    if (nested && typeof nested === "object") collectPolicyGatesFromValue(nested, out);
  }
}

function compilerAwarenessEventPolicyGateSummary(row: Record<string, unknown>): Record<string, unknown> {
  const gatesById = new Map<string, Record<string, unknown>>();
  collectPolicyGatesFromValue(row.decision, gatesById);
  collectPolicyGatesFromValue(row.candidates, gatesById);
  const gates = Array.from(gatesById.values()).map((gate) => ({
    id: gate.id,
    category: gate.category ?? null,
    state: gate.state ?? null,
    risk: gate.risk ?? null,
    owner: gate.owner ?? null,
    safeToAutoApply: gate.safeToAutoApply === true,
  }));
  return {
    gates,
    total: gates.length,
    blocked: gates.filter((gate) => gate.state === "blocked").length,
    highRisk: gates.filter((gate) => gate.risk === "high").length,
    safeToAutoApply: gates.filter((gate) => gate.safeToAutoApply === true).length,
  };
}

function rowToCompilerAwarenessEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    intent: row.intent ?? null,
    action: row.action ?? null,
    terms: Array.isArray(row.terms) ? row.terms : [],
    summary: row.summary ?? {},
    policy: row.policy ?? {},
    candidates: row.candidates ?? {},
    decision: row.decision ?? {},
    policyGateSummary: compilerAwarenessEventPolicyGateSummary(row),
    actor: row.actor ?? null,
    source: row.source ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
  };
}

function rowToCompilerControlPlaneEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    intent: row.intent ?? null,
    action: row.action ?? null,
    deviceId: row.device_id ?? null,
    requestedScope: row.requested_scope ?? null,
    summary: row.summary ?? {},
    policy: row.policy ?? {},
    dryRun: row.dry_run ?? {},
    capabilityManifest: row.capability_manifest ?? {},
    limitedReusePlan: row.limited_reuse_plan ?? {},
    actor: row.actor ?? null,
    source: row.source ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
  };
}

function rowToWorkflowValidationEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    definitionId: row.definition_id ?? null,
    definitionKey: row.definition_key ?? null,
    definitionVersion: row.definition_version ?? null,
    intent: row.intent ?? null,
    platform: row.platform ?? null,
    summary: row.summary ?? {},
    policy: row.policy ?? {},
    staticValidation: row.static_validation ?? {},
    dryRun: row.dry_run ?? {},
    smokeReadiness: row.smoke_readiness ?? {},
    canaryReadiness: row.canary_readiness ?? {},
    regressionReadiness: row.regression_readiness ?? {},
    decision: row.decision ?? {},
    actor: row.actor ?? null,
    source: row.source ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
  };
}

function rowToWorkflowDefinitionPromotionEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    definitionId: row.definition_id ?? null,
    definitionKey: row.definition_key ?? null,
    definitionVersion: row.definition_version ?? null,
    action: row.action ?? null,
    previousState: row.previous_state ?? null,
    nextState: row.next_state ?? null,
    promotionScope: row.promotion_scope ?? null,
    note: row.note ?? null,
    actor: row.actor ?? null,
    policy: row.policy ?? {},
    validationSnapshot: row.validation_snapshot ?? {},
    promotionConfidence: Number(row.promotion_confidence ?? 0),
    promotionReadiness: row.promotion_readiness ?? {},
    promotionScopeDetails: row.promotion_scope_details ?? {},
    rollbackPreview: row.rollback_preview ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
  };
}

async function getCompilerPolicyGates(db: ReturnType<typeof getDb>, filters: {
  category?: string;
  state?: string;
  risk?: string;
  owner?: string;
} = {}) {
  const configRows = await db.query(
    `SELECT gate_id, state, version, owner, risk, config, updated_by, updated_at
     FROM agency_compiler_policy_gate_config`
  );
  return listCompilerPolicyGatesWithConfig(configRows.rows, filters);
}

type WorkflowRunFeedbackRating = "ok" | "not_ok" | "partial";

function parseWorkflowRunFeedback(input: unknown): {
  rating: WorkflowRunFeedbackRating;
  lastGoodStepIndex: number | null;
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const rating = typeof body.rating === "string" ? body.rating.trim().toLowerCase() : "";
  if (!["ok", "not_ok", "partial"].includes(rating)) {
    return { error: "rating must be one of ok, not_ok, partial", code: "INVALID_FEEDBACK_RATING" };
  }

  const rawLastGoodStepIndex = body.lastGoodStepIndex;
  const lastGoodStepIndex = typeof rawLastGoodStepIndex === "number" && Number.isInteger(rawLastGoodStepIndex)
    ? rawLastGoodStepIndex
    : null;
  if (rating === "partial" && lastGoodStepIndex === null) {
    return { error: "lastGoodStepIndex is required for partial feedback", code: "FEEDBACK_LAST_GOOD_STEP_REQUIRED" };
  }
  if (lastGoodStepIndex !== null && lastGoodStepIndex < 0) {
    return { error: "lastGoodStepIndex must be non-negative", code: "INVALID_LAST_GOOD_STEP_INDEX" };
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) {
    return { error: "note must be 1000 characters or fewer", code: "FEEDBACK_NOTE_TOO_LONG" };
  }

  return {
    rating: rating as WorkflowRunFeedbackRating,
    lastGoodStepIndex: rating === "partial" ? lastGoodStepIndex : null,
    note: note.length > 0 ? note : null,
  };
}

type StepCandidateReviewAction = "keep_review" | "reject";

function parseStepCandidateReview(input: unknown): {
  action: StepCandidateReviewAction;
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!["keep_review", "reject"].includes(action)) {
    return { error: "action must be one of keep_review, reject", code: "INVALID_STEP_CANDIDATE_REVIEW_ACTION" };
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) {
    return { error: "note must be 1000 characters or fewer", code: "STEP_CANDIDATE_REVIEW_NOTE_TOO_LONG" };
  }

  return {
    action: action as StepCandidateReviewAction,
    note: note.length > 0 ? note : null,
  };
}

function nonEmptyStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function parseStepCandidateValidation(input: unknown): {
  contract: Record<string, unknown>;
  evidence: Record<string, unknown>;
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const contract = normalizeJsonObject(body.contract);
  const evidence = normalizeJsonObject(body.evidence);
  const preconditions = nonEmptyStringArray(contract.preconditions);
  const postconditions = nonEmptyStringArray(contract.postconditions);
  if (preconditions.length === 0) {
    return { error: "contract.preconditions must contain at least one item", code: "VALIDATION_PRECONDITIONS_REQUIRED" };
  }
  if (postconditions.length === 0) {
    return { error: "contract.postconditions must contain at least one item", code: "VALIDATION_POSTCONDITIONS_REQUIRED" };
  }
  if (Object.keys(evidence).length === 0) {
    return { error: "evidence is required for validated_step", code: "VALIDATION_EVIDENCE_REQUIRED" };
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) {
    return { error: "note must be 1000 characters or fewer", code: "STEP_CANDIDATE_VALIDATION_NOTE_TOO_LONG" };
  }

  return {
    contract: {
      ...contract,
      preconditions,
      postconditions,
    },
    evidence,
    note: note.length > 0 ? note : null,
  };
}

type StepLibraryPromotionAction = "promote_limited" | "revoke";

type WorkflowDefinitionPromotionAction = "promote_limited" | "revoke";

function parseWorkflowDefinitionPromotion(input: unknown): {
  action: WorkflowDefinitionPromotionAction;
  scope: string | null;
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!["promote_limited", "revoke"].includes(action)) {
    return { error: "action must be one of promote_limited, revoke", code: "INVALID_WORKFLOW_DEFINITION_PROMOTION_ACTION" };
  }

  const rawScope = typeof body.scope === "string" ? body.scope.trim() : "";
  if (action === "promote_limited") {
    if (!rawScope) {
      return { error: "scope is required for limited promotion", code: "WORKFLOW_DEFINITION_PROMOTION_SCOPE_REQUIRED" };
    }
    if (rawScope.length > 160) {
      return { error: "scope must be 160 characters or fewer", code: "WORKFLOW_DEFINITION_PROMOTION_SCOPE_TOO_LONG" };
    }
    const loweredScope = rawScope.toLowerCase();
    if (["global", "all", "compiler", "auto"].some((blocked) => loweredScope === blocked || loweredScope.startsWith(`${blocked}:`))) {
      return { error: "global or compiler scope is not allowed in this phase", code: "WORKFLOW_DEFINITION_GLOBAL_SCOPE_DISABLED" };
    }
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) {
    return { error: "note must be 1000 characters or fewer", code: "WORKFLOW_DEFINITION_PROMOTION_NOTE_TOO_LONG" };
  }

  return {
    action: action as WorkflowDefinitionPromotionAction,
    scope: action === "promote_limited" ? rawScope : null,
    note: note.length > 0 ? note : null,
  };
}

function parseWorkflowDefinitionRollback(input: unknown): {
  targetDefinitionId: string | null;
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const targetDefinitionId = typeof body.targetDefinitionId === "string" ? body.targetDefinitionId.trim() : "";
  if (targetDefinitionId && targetDefinitionId.length > 120) {
    return { error: "targetDefinitionId must be 120 characters or fewer", code: "WORKFLOW_DEFINITION_ROLLBACK_TARGET_TOO_LONG" };
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) {
    return { error: "note must be 1000 characters or fewer", code: "WORKFLOW_DEFINITION_ROLLBACK_NOTE_TOO_LONG" };
  }

  return {
    targetDefinitionId: targetDefinitionId.length > 0 ? targetDefinitionId : null,
    note: note.length > 0 ? note : null,
  };
}

function parseWorkflowDefinitionVersion(input: unknown): {
  note: string | null;
  status: string;
  title: string | null;
  description: string | null | undefined;
  goal: string | null;
  definition: Record<string, unknown> | null;
  successCriteria: unknown[] | null;
  allowedTools: string[] | null;
  requiredCapabilities: string[] | null;
  constraints: string[] | null;
  fallbackRules: string[] | null;
  rollback: Record<string, unknown> | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) return { error: "note must be 1000 characters or fewer", code: "WORKFLOW_DEFINITION_VERSION_NOTE_TOO_LONG" };
  const status = typeof body.status === "string" && body.status.trim().length > 0 ? body.status.trim() : "draft";
  if (!["draft", "active"].includes(status)) return { error: "new version status must be draft or active", code: "WORKFLOW_DEFINITION_VERSION_STATUS_INVALID" };
  const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : null;
  const description = typeof body.description === "string" ? body.description.trim() || null : undefined;
  const goal = typeof body.goal === "string" && body.goal.trim().length > 0 ? body.goal.trim() : null;
  const definition = body.definition && typeof body.definition === "object" && !Array.isArray(body.definition) ? body.definition as Record<string, unknown> : null;
  const successCriteria = Array.isArray(body.successCriteria) ? body.successCriteria : null;
  const allowedTools = Array.isArray(body.allowedTools) ? body.allowedTools.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : null;
  const requiredCapabilities = Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : null;
  const constraints = Array.isArray(body.constraints) ? body.constraints.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : null;
  const fallbackRules = Array.isArray(body.fallbackRules) ? body.fallbackRules.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : null;
  const rollback = body.rollback && typeof body.rollback === "object" && !Array.isArray(body.rollback) ? body.rollback as Record<string, unknown> : null;
  return {
    note: note.length > 0 ? note : null,
    status,
    title,
    description,
    goal,
    definition,
    successCriteria,
    allowedTools,
    requiredCapabilities,
    constraints,
    fallbackRules,
    rollback,
  };
}

function parseWorkflowDefinitionLifecycle(input: unknown): {
  action: "archive" | "deprecate" | "activate" | "draft";
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!["archive", "deprecate", "activate", "draft"].includes(action)) {
    return { error: "action must be one of archive, deprecate, activate, draft", code: "WORKFLOW_DEFINITION_LIFECYCLE_ACTION_INVALID" };
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) return { error: "note must be 1000 characters or fewer", code: "WORKFLOW_DEFINITION_LIFECYCLE_NOTE_TOO_LONG" };
  return { action: action as "archive" | "deprecate" | "activate" | "draft", note: note.length > 0 ? note : null };
}

function parseCompilerPolicyGateUpdate(input: unknown): {
  state: "blocked" | "review_ready" | "enabled";
  note: string | null;
  config: Record<string, unknown>;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!["blocked", "review_ready", "enabled"].includes(state)) {
    return { error: "state must be one of blocked, review_ready, enabled", code: "COMPILER_POLICY_GATE_STATE_INVALID" };
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) return { error: "note must be 1000 characters or fewer", code: "COMPILER_POLICY_GATE_NOTE_TOO_LONG" };
  return {
    state: state as "blocked" | "review_ready" | "enabled",
    note: note.length > 0 ? note : null,
    config: normalizeJsonObject(body.config),
  };
}

function parseStepLibraryPromotion(input: unknown): {
  action: StepLibraryPromotionAction;
  scope: string | null;
  note: string | null;
} | { error: string; code: string } {
  const body = normalizeJsonObject(input);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (!["promote_limited", "revoke"].includes(action)) {
    return { error: "action must be one of promote_limited, revoke", code: "INVALID_STEP_LIBRARY_PROMOTION_ACTION" };
  }

  const rawScope = typeof body.scope === "string" ? body.scope.trim() : "";
  if (action === "promote_limited") {
    if (!rawScope) {
      return { error: "scope is required for limited promotion", code: "STEP_LIBRARY_PROMOTION_SCOPE_REQUIRED" };
    }
    if (rawScope.length > 120) {
      return { error: "scope must be 120 characters or fewer", code: "STEP_LIBRARY_PROMOTION_SCOPE_TOO_LONG" };
    }
    if (["global", "all", "compiler", "auto"].includes(rawScope.toLowerCase())) {
      return { error: "global or compiler scope is not allowed in this phase", code: "STEP_LIBRARY_GLOBAL_SCOPE_DISABLED" };
    }
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 1000) {
    return { error: "note must be 1000 characters or fewer", code: "STEP_LIBRARY_PROMOTION_NOTE_TOO_LONG" };
  }

  return {
    action: action as StepLibraryPromotionAction,
    scope: action === "promote_limited" ? rawScope : null,
    note: note.length > 0 ? note : null,
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeJsonArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function workflowDefinitionScopeDetails(scope: string | null): Record<string, unknown> {
  const normalized = scope?.trim() || null;
  const [scopeType = null, ...scopeParts] = normalized ? normalized.split(":") : [];
  const scopeValue = scopeParts.join(":") || null;
  return {
    scope: normalized,
    scopeType,
    scopeValue,
    limitedReuseOnly: true,
    globalScopeAllowed: false,
    compilerEligible: false,
    wouldUseDefinition: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    allowedScopePrefixes: ["definition", "device", "user", "account", "client", "tenant", "environment"],
    notes: [
      "Promotion scope is metadata for manual review only.",
      "Global compiler reuse is disabled in this phase.",
    ],
  };
}

function workflowDefinitionPromotionMetadata(input: {
  definition: ReturnType<typeof rowToWorkflowDefinition>;
  validationSnapshot: Record<string, unknown>;
  scope: string | null;
}): {
  confidence: number;
  readiness: Record<string, unknown>;
  scopeDetails: Record<string, unknown>;
} {
  const staticValidation = normalizeJsonObject(input.validationSnapshot.staticValidation);
  const dryRun = normalizeJsonObject(input.validationSnapshot.dryRun);
  const decision = normalizeJsonObject(input.validationSnapshot.decision);
  const branchCoverage = normalizeJsonObject(dryRun.branchCoverage);
  const validationScore = Number(decision.validationScore ?? 0);
  const coveragePercent = Number(branchCoverage.coveragePercent ?? 0);
  const staticErrors = Number(staticValidation.errors ?? 0);
  const staticWarnings = Number(staticValidation.warnings ?? 0);
  const confidence = staticErrors > 0
    ? 0
    : Math.max(0, Math.min(0.99, Math.round(((validationScore * 0.7 + coveragePercent * 0.3) / 100) * 100) / 100));
  const readinessState = staticErrors === 0 && validationScore >= 60 && coveragePercent >= 50
    ? "manual_limited_promotion_ready"
    : "blocked";
  return {
    confidence,
    readiness: {
      state: readinessState,
      manualOnly: true,
      validationScore,
      branchCoveragePercent: coveragePercent,
      staticErrors,
      staticWarnings,
      promotionThresholds: {
        validationScore: 60,
        branchCoveragePercent: 50,
        staticErrors: 0,
      },
      linkedPipeline: {
        mode: "workflow_validation_pipeline_v2",
        definitionId: input.definition.id,
        definitionKey: input.definition.key,
        definitionVersion: input.definition.version,
      },
      wouldPromoteDefinitionAutomatically: false,
      wouldUseDefinition: false,
      wouldExecuteWorkflow: false,
      wouldChangePlan: false,
      wouldChangeWorkflowCache: false,
      blockers: readinessState === "blocked"
        ? [
            ...(staticErrors > 0 ? ["static_validation_errors"] : []),
            ...(validationScore < 60 ? ["validation_score_below_threshold"] : []),
            ...(coveragePercent < 50 ? ["branch_coverage_below_threshold"] : []),
          ]
        : [
            "manual_review_required",
            "compiler_auto_use_disabled",
          ],
      nextActions: [
        "review Validation Pipeline evidence",
        "keep promotion scope limited",
        "record rollback target before broader reuse",
      ],
    },
    scopeDetails: workflowDefinitionScopeDetails(input.scope),
  };
}

function workflowDefinitionDiff(left: ReturnType<typeof rowToWorkflowDefinition>, right: ReturnType<typeof rowToWorkflowDefinition>): Record<string, unknown> {
  const fields: Array<[string, unknown, unknown]> = [
    ["status", left.status, right.status],
    ["title", left.title, right.title],
    ["description", left.description, right.description],
    ["platform", left.platform, right.platform],
    ["intent", left.intent, right.intent],
    ["goal", left.goal, right.goal],
    ["definition", left.definition, right.definition],
    ["successCriteria", left.successCriteria, right.successCriteria],
    ["allowedTools", left.allowedTools, right.allowedTools],
    ["requiredCapabilities", left.requiredCapabilities, right.requiredCapabilities],
    ["constraints", left.constraints, right.constraints],
    ["fallbackRules", left.fallbackRules, right.fallbackRules],
    ["rollback", left.rollback, right.rollback],
  ];
  const changes = fields
    .filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after))
    .map(([field, before, after]) => ({ field, before, after }));
  return {
    mode: "workflow_definition_version_diff",
    left: { id: left.id, key: left.key, version: left.version, status: left.status },
    right: { id: right.id, key: right.key, version: right.version, status: right.status },
    changes,
    summary: {
      changedFields: changes.length,
      allowedToolDelta: right.allowedTools.filter((tool) => !left.allowedTools.includes(tool)),
      removedTools: left.allowedTools.filter((tool) => !right.allowedTools.includes(tool)),
      capabilityDelta: right.requiredCapabilities.filter((capability) => !left.requiredCapabilities.includes(capability)),
    },
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
  };
}

async function workflowDefinitionImpactPreview(db: ReturnType<typeof getDb>, definition: ReturnType<typeof rowToWorkflowDefinition>): Promise<Record<string, unknown>> {
  const [versions, promotions, validations] = await Promise.all([
    db.query(
      `SELECT id, version, status, promotion_state, promotion_scope, promotion_confidence, updated_at
       FROM agency_workflow_definitions
       WHERE definition_key = $1
       ORDER BY version DESC`,
      [definition.key]
    ),
    db.query(
      `SELECT action, previous_state, next_state, promotion_scope, created_at
       FROM agency_workflow_definition_promotion_events
       WHERE definition_key = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [definition.key]
    ),
    db.query(
      `SELECT summary, decision, created_at
       FROM agency_workflow_validation_events
       WHERE definition_key = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [definition.key]
    ),
  ]);
  return {
    mode: "workflow_definition_impact_preview",
    definition: { id: definition.id, key: definition.key, version: definition.version, status: definition.status },
    versionCount: versions.rows.length,
    versions: versions.rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      promotionState: row.promotion_state,
      promotionScope: row.promotion_scope,
      confidence: Number(row.promotion_confidence ?? 0),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
    })),
    promotionEvents: promotions.rows,
    validationEvents: validations.rows,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    notes: [
      "Impact preview is advisory only.",
      "Version lifecycle changes do not mutate workflow cache or execution paths.",
    ],
  };
}

function workflowDefinitionHardeningPreview(definition: ReturnType<typeof rowToWorkflowDefinition>, scope: string | null): Record<string, unknown> {
  const confidence = Number(definition.promotion.confidence ?? 0);
  const telemetry = normalizeJsonObject(definition.telemetrySummary);
  const attempts = Number(telemetry.attempts ?? 0);
  const failures = Number(telemetry.failures ?? 0);
  const ageDays = definition.promotion.promotedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(definition.promotion.promotedAt).getTime()) / 86_400_000))
    : null;
  const failurePenalty = attempts > 0 ? Math.min(0.4, failures / Math.max(1, attempts)) : 0;
  const agePenalty = ageDays === null ? 0.05 : Math.min(0.25, ageDays * 0.01);
  const decayedConfidence = Math.max(0, Math.round((confidence - failurePenalty - agePenalty) * 100) / 100);
  const scopeDetails = workflowDefinitionScopeDetails(scope ?? definition.promotion.scope);
  const scopeMatched = scope ? scope === definition.promotion.scope : !!definition.promotion.scope;
  const executionEnabled = definition.policy.executionChanging === true && definition.policy.autoUseEnabled === true;
  const blockers = [
    ...(definition.promotion.state !== "limited_reuse" ? ["workflow_definition_not_limited_reuse"] : []),
    ...(definition.status !== "active" ? ["workflow_definition_not_active"] : []),
    ...(!scopeMatched ? ["limited_reuse_scope_mismatch"] : []),
    ...(decayedConfidence < 0.6 ? ["confidence_below_controlled_threshold"] : []),
    ...(!executionEnabled ? ["execution_changing_disabled"] : []),
  ];
  const canAutoUse = blockers.length === 0;
  return {
    mode: "workflow_definition_promotion_hardening",
    definitionId: definition.id,
    definitionKey: definition.key,
    version: definition.version,
    telemetry: {
      attempts,
      failures,
      successRate: attempts > 0 ? Math.round(((attempts - failures) / attempts) * 100) / 100 : null,
      source: "workflow_definition_telemetry_summary",
    },
    confidenceDecay: {
      originalConfidence: confidence,
      decayedConfidence,
      ageDays,
      failurePenalty,
      agePenalty,
      threshold: 0.6,
    },
    scope: scopeDetails,
    scopeMatched,
    autoDemoteRecommendation: blockers.includes("confidence_below_controlled_threshold") ? "quarantine_or_revalidate" : "keep_limited_reuse",
    safeToAutoApply: canAutoUse,
    wouldUseDefinition: canAutoUse,
    wouldExecuteWorkflow: canAutoUse,
    wouldChangeWorkflowCache: canAutoUse,
    blockers,
  };
}

async function workflowDefinitionRollbackPreview(db: ReturnType<typeof getDb>, definition: ReturnType<typeof rowToWorkflowDefinition>): Promise<Record<string, unknown>> {
  const rows = await db.query(
    `SELECT *
     FROM agency_workflow_definitions
     WHERE definition_key = $1
       AND id <> $2
     ORDER BY version DESC, updated_at DESC
     LIMIT 5`,
    [definition.key, definition.id]
  );
  const candidates = (rows?.rows ?? []).map(rowToWorkflowDefinition);
  const target = candidates.find((candidate) => candidate.version < definition.version) ?? candidates[0] ?? null;
  return {
    mode: "workflow_definition_rollback_preview",
    currentDefinition: {
      id: definition.id,
      key: definition.key,
      version: definition.version,
      status: definition.status,
      promotionState: definition.promotion.state,
    },
    candidateTargets: candidates.map((candidate) => ({
      id: candidate.id,
      key: candidate.key,
      version: candidate.version,
      status: candidate.status,
      promotionState: candidate.promotion.state,
      confidence: candidate.promotion.confidence,
    })),
    selectedTarget: target
      ? {
          id: target.id,
          key: target.key,
          version: target.version,
          status: target.status,
          promotionState: target.promotion.state,
        }
      : null,
    available: !!target,
    wouldRollbackNow: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    requiresManualRollback: true,
    notes: target
      ? ["Rollback preview is available, but no rollback is applied by this endpoint."]
      : ["No previous workflow definition version is available for rollback preview."],
  };
}

function stepLabel(step: Record<string, unknown>, fallbackIndex: number): string {
  const action = typeof step.action === "string" ? step.action : null;
  const type = typeof step.type === "string" ? step.type : null;
  const id = typeof step.id === "string" ? step.id : null;
  return action ?? type ?? id ?? `Step ${fallbackIndex + 1}`;
}

function stepStatus(input: {
  runStatus: string | null;
  workflowStatus: string | null;
  currentStep: number | null;
  stepIndex: number;
}): string {
  const terminalStatus = input.workflowStatus ?? input.runStatus;
  const completedCount = input.currentStep ?? 0;
  if (terminalStatus === "completed") return "succeeded";
  if (terminalStatus === "failed") {
    if (input.stepIndex < Math.max(0, completedCount - 1)) return "succeeded";
    if (input.stepIndex === Math.max(0, completedCount - 1)) return "failed";
    return "pending";
  }
  if (terminalStatus === "running") {
    if (input.stepIndex < Math.max(0, completedCount - 1)) return "succeeded";
    if (input.stepIndex === Math.max(0, completedCount - 1)) return "running";
    return "pending";
  }
  return input.stepIndex < completedCount ? "succeeded" : "pending";
}

function buildAgencyWorkflowTimeline(row: Record<string, unknown>): Record<string, unknown>[] {
  const workflow = normalizeJsonObject(row.cached_workflow);
  const compiledPlan = normalizeJsonObject(row.cached_compiled_plan);
  const checkpoint = normalizeJsonObject(row.workflow_checkpoint);
  const checkpointVariables = normalizeJsonObject(checkpoint.variables);
  const steps = normalizeJsonArray(workflow.steps);
  const planSteps = normalizeJsonArray(compiledPlan.steps);
  const sourceSteps = steps.length > 0 ? steps : planSteps;
  const totalSteps = typeof row.workflow_total_steps === "number"
    ? row.workflow_total_steps
    : typeof checkpoint.totalSteps === "number"
      ? checkpoint.totalSteps
      : sourceSteps.length;
  const fallbackSteps: Record<string, unknown>[] = sourceSteps.length > 0
    ? sourceSteps
    : Array.from({ length: Math.max(0, totalSteps) }, (_, index) => ({ id: `step_${index + 1}` }));
  const currentStep = typeof row.workflow_current_step === "number"
    ? row.workflow_current_step
    : typeof checkpoint.stepIndex === "number"
      ? checkpoint.stepIndex
      : null;
  const runStatus = typeof row.status === "string" ? row.status : null;
  const workflowStatus = typeof row.workflow_status === "string" ? row.workflow_status : null;
  const workflowError = typeof row.workflow_error === "string" ? row.workflow_error : typeof row.error === "string" ? row.error : null;

  return fallbackSteps.map((step, index) => {
    const status = stepStatus({ runStatus, workflowStatus, currentStep, stepIndex: index });
    return {
      index,
      id: typeof step.id === "string" ? step.id : `step_${index + 1}`,
      label: stepLabel(step, index),
      action: typeof step.action === "string" ? step.action : null,
      type: typeof step.type === "string" ? step.type : null,
      status,
      durationMs: null,
      error: status === "failed" ? workflowError : null,
      state: status === "failed" ? checkpointVariables.screenState ?? checkpointVariables.currentScreen ?? null : null,
    };
  });
}

function buildStepCandidateEvidence(input: {
  run: Record<string, unknown>;
  lastGoodStepIndex: number;
  step: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    source: "dashboard_partial_feedback",
    feedbackBoundary: {
      lastGoodStepIndex: input.lastGoodStepIndex,
      nominatedStepIndex: input.step.index,
    },
    run: {
      status: input.run.status ?? null,
      workflowStatus: input.run.workflow_status ?? null,
      artifactState: input.run.artifact_state ?? null,
      workflowId: input.run.workflow_id ?? null,
      taskId: input.run.task_id ?? null,
    },
    guardrails: {
      reusable: false,
      requiresReview: true,
      promotion: "manual_contract_validation_required",
    },
  };
}

function cachedWorkflowLlmHappyPathRequests(cached: Record<string, unknown>): number | null {
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const llmBudget = compiledPlan?.llmBudget as Record<string, unknown> | undefined;
  return typeof llmBudget?.happyPathRequests === "number" ? llmBudget.happyPathRequests : null;
}

function cachedWorkflowSafetyClass(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const metadata = compiledPlan?.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as Record<string, unknown> | null;
  return (metadata?.safetyClass ?? workflow?.safetyClass ?? sourceMetadata?.safetyClass ?? null) as string | null;
}

function cachedWorkflowIntent(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const metadata = compiledPlan?.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as Record<string, unknown> | null;
  return (metadata?.intent ?? workflow?.intent ?? sourceMetadata?.intent ?? null) as string | null;
}

function cachedWorkflowPlatform(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  return (cached.platform ?? workflow?.platform ?? null) as string | null;
}

function agencyWorkflowRunSelectSql(where: string): string {
  return `SELECT r.*,
                 COALESCE(t.status, r.status) AS status,
                 a.username AS account_username,
                 a.platform AS account_platform,
                 c.name AS client_name,
                 d.friendly_name AS device_name,
                 w.status AS workflow_status,
                 w.current_step AS workflow_current_step,
                 w.total_steps AS workflow_total_steps,
                 w.checkpoint AS workflow_checkpoint,
                 w.error AS workflow_error,
                 g.artifact_state,
                 g.workflow AS cached_workflow,
                 g.compiled_plan AS cached_compiled_plan
          FROM agency_workflow_runs r
          LEFT JOIN tasks t ON t.id = r.task_id
          LEFT JOIN workflows w ON w.id = r.workflow_id
          LEFT JOIN accounts a ON a.id = r.account_id
          LEFT JOIN clients c ON c.id = r.client_id
          LEFT JOIN devices d ON d.id = r.device_id
          LEFT JOIN LATERAL (
            SELECT artifact_state, workflow, compiled_plan
            FROM generated_workflow_plan_cache cache
            WHERE (r.request_key IS NOT NULL AND cache.request_key = r.request_key)
               OR (r.cache_key IS NOT NULL AND cache.cache_key = r.cache_key)
            ORDER BY cache.updated_at DESC
            LIMIT 1
          ) g ON TRUE
          ${where ? `WHERE ${where.replace(/^WHERE\s+/i, "")}` : ""}`;
}

async function hydrateAgencyWorkflowRun(db: ReturnType<typeof getDb>, runId: string): Promise<Record<string, unknown> | null> {
  const hydrated = await db.query(
    agencyWorkflowRunSelectSql(`r.id = $1`),
    [runId]
  );
  return hydrated.rows[0] ?? null;
}

async function loadStepCandidates(db: Pick<ReturnType<typeof getDb>, "query">, runId: string): Promise<Record<string, unknown>[]> {
  const result = await db.query(
    `SELECT *
     FROM agency_workflow_step_candidates
     WHERE run_id = $1
     ORDER BY step_index ASC`,
    [runId]
  );
  return result.rows;
}

// ─── File upload config ───────────────────────────────────────────────────────

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/data/uploads/materials";

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|txt|md)$/i;
    if (allowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/clients", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const activeOnly = req.query.active === "true";
  const type = req.query.type as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (activeOnly) {
    conditions.push(`active = TRUE`);
  }
  if (type) {
    conditions.push(`type = $${idx++}`);
    values.push(type);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  
  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT * FROM clients ${where} ORDER BY name ASC LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM clients ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/clients/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const result = await db.query("SELECT * FROM clients WHERE id = $1", [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Client not found" });
  }
  res.json({ ok: true, data: result.rows[0] });
});

router.post("/clients", async (req: Request, res: Response) => {
  const db = getDb();
  const { name, strategy = {}, type = 'client' } = req.body as { 
    name: string; 
    strategy?: Record<string, unknown>;
    type?: 'client' | 'farming';
  };

  if (!name?.trim()) {
    return res.status(400).json({ ok: false, error: "name required" });
  }

  if (!['client', 'farming'].includes(type)) {
    return res.status(400).json({ ok: false, error: "type must be 'client' or 'farming'" });
  }

  const result = await db.query(
    `INSERT INTO clients (name, strategy, type) VALUES ($1, $2, $3) RETURNING *`,
    [name.trim(), JSON.stringify(strategy), type]
  );

  res.status(201).json({ ok: true, data: result.rows[0] });
});

router.patch("/clients/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { name, active, strategy } = req.body as {
    name?: string;
    active?: boolean;
    strategy?: Record<string, unknown>;
  };

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (name !== undefined) {
    updates.push(`name = $${idx++}`);
    values.push(name.trim());
  }
  if (active !== undefined) {
    updates.push(`active = $${idx++}`);
    values.push(active);
  }
  if (strategy !== undefined) {
    updates.push(`strategy = $${idx++}`);
    values.push(JSON.stringify(strategy));
  }

  if (updates.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  updates.push(`updated_at = NOW()`);
  values.push(req.params.id);

  const result = await db.query(
    `UPDATE clients SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Client not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MATERIALS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/materials", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const clientId = req.query.clientId as string | undefined;
  const usedFilter = req.query.used as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (clientId) {
    conditions.push(`client_id = $${idx++}`);
    values.push(clientId);
  }
  if (usedFilter === "true" || usedFilter === "false") {
    conditions.push(`used = $${idx++}`);
    values.push(usedFilter === "true");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT m.*, c.name as client_name 
       FROM materials m 
       LEFT JOIN clients c ON m.client_id = c.id 
       ${where} 
       ORDER BY m.uploaded_at DESC 
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM materials ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.post("/materials", upload.single("file"), async (req: Request, res: Response) => {
  const db = getDb();
  const file = req.file;

  if (!file) {
    return res.status(400).json({ ok: false, error: "file required" });
  }

  const { clientId, accountId, description } = req.body as {
    clientId?: string;
    accountId?: string;
    description?: string;
  };

  // Determine type from mimetype
  let type: "image" | "video" | "text" = "text";
  if (file.mimetype.startsWith("image/")) type = "image";
  else if (file.mimetype.startsWith("video/")) type = "video";

  const url = `/uploads/materials/${file.filename}`;

  const result = await db.query(
    `INSERT INTO materials (client_id, account_id, type, url, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [clientId || null, accountId || null, type, url, description || null]
  );

  res.status(201).json({ ok: true, data: result.rows[0] });
});

router.patch("/materials/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { used, description } = req.body as { used?: boolean; description?: string };

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (used !== undefined) {
    updates.push(`used = $${idx++}`);
    values.push(used);
  }
  if (description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(description);
  }

  if (updates.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  values.push(req.params.id);

  const result = await db.query(
    `UPDATE materials SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Material not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

router.delete("/materials/:id", async (req: Request, res: Response) => {
  const db = getDb();

  // Get file path first
  const existing = await db.query("SELECT url FROM materials WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Material not found" });
  }

  // Delete from DB
  await db.query("DELETE FROM materials WHERE id = $1", [req.params.id]);

  // Try to delete file (non-fatal if fails)
  const filePath = path.join(UPLOAD_DIR, path.basename(existing.rows[0].url));
  await fs.unlink(filePath).catch(() => {});

  res.json({ ok: true, data: { deleted: true } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/posts", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const status = req.query.status as string | undefined;
  const accountId = req.query.accountId as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`p.status = $${idx++}`);
    values.push(status);
  }
  if (accountId) {
    conditions.push(`p.account_id = $${idx++}`);
    values.push(accountId);
  }
  if (from) {
    conditions.push(`p.created_at >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`p.created_at <= $${idx++}`);
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT p.*, a.username as account_username, a.platform as account_platform
       FROM posts p
       LEFT JOIN accounts a ON p.account_id = a.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM posts p ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/posts/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const result = await db.query(
    `SELECT p.*, a.username as account_username, a.platform as account_platform
     FROM posts p
     LEFT JOIN accounts a ON p.account_id = a.id
     WHERE p.id = $1`,
    [req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Post not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

router.patch("/posts/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { status, content } = req.body as {
    status?: "pending_approval" | "approved" | "rejected" | "published";
    content?: Record<string, unknown>;
  };

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status !== undefined) {
    updates.push(`status = $${idx++}`);
    values.push(status);

    // Set timestamps based on status
    if (status === "approved") {
      updates.push(`approved_at = NOW()`);
    } else if (status === "published") {
      updates.push(`published_at = NOW()`);
    }
  }

  if (content !== undefined) {
    updates.push(`content = $${idx++}`);
    values.push(JSON.stringify(content));
  }

  if (updates.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  values.push(req.params.id);

  const result = await db.query(
    `UPDATE posts SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Post not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORKFLOW RUNS — Control-plane runs for existing canonical generated workflows
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/reddit/account-health-scans", async (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as {
    clientId?: string;
    accountId?: string;
    deviceId?: string;
    scheduledTime?: string;
    context?: Record<string, unknown>;
  };

  if (!body.accountId || !body.deviceId) {
    return res.status(400).json({ ok: false, error: "accountId and deviceId required" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const accountResult = await client.query<{
      id: string;
      client_id: string | null;
      platform: string;
      username: string | null;
    }>(
      `SELECT id, client_id, platform, username FROM accounts WHERE id = $1`,
      [body.accountId],
    );
    const account = accountResult.rows[0];
    if (!account) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Account not found" });
    }
    if (account.platform !== "reddit") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_PLATFORM_NOT_REDDIT",
        error: "Reddit account health scans require a reddit account",
      });
    }
    if (account.client_id && body.clientId && account.client_id !== body.clientId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_CLIENT_MISMATCH",
        error: "Account is linked to a different client",
      });
    }

    const resolvedClientId = account.client_id ?? body.clientId;
    if (!resolvedClientId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_CLIENT_REQUIRED",
        error: "Account must be linked to a client or clientId must be supplied",
      });
    }

    const cacheResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM generated_workflow_plan_cache
       WHERE platform = 'reddit'
         AND artifact_state = 'promoted'
         AND COALESCE(compiled_plan #>> '{metadata,intent}', workflow ->> 'intent', source_metadata ->> 'intent') = 'reddit_account_health_scan'
         AND COALESCE(compiled_plan #>> '{metadata,safetyClass}', workflow ->> 'safetyClass', source_metadata ->> 'safetyClass') = 'read_only'
         AND COALESCE(compiled_plan #>> '{llmBudget,happyPathRequests}', '') = '0'
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    const cached = cacheResult.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        code: "REDDIT_HEALTH_SCAN_WORKFLOW_NOT_READY",
        error: "No cache-safe reddit_account_health_scan workflow artifact found",
      });
    }

    const runContext = {
      ...(body.context ?? {}),
      source: "agency_reddit_account_health_scan",
      clientId: resolvedClientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: "reddit_account_health_scan",
      accountUsername: account.username,
      requiresScreenshotArtifact: true,
      requiresRealClassifierOutput: true,
    };
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agency_workflow_runs
         (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
          canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context)
       VALUES ($1, $2, $3, 'reddit', 'reddit_account_health_scan', 'read_only', NULL, $4, $5, $6, $7, 'queued', $8)
      RETURNING id`,
      [
        resolvedClientId,
        body.accountId,
        body.deviceId,
        cached.cache_key,
        cached.canonical_workflow_id,
        cached.canonical_workflow_version,
        cached.compiled_plan_hash,
        JSON.stringify(runContext),
      ],
    );
    const runId = runResult.rows[0].id;

    const taskParams = {
      cacheKey: cached.cache_key,
      clientId: resolvedClientId,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: "reddit_account_health_scan",
      source: "agency_reddit_account_health_scan",
    };
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [
        body.accountId,
        body.deviceId,
        JSON.stringify(taskParams),
        body.scheduledTime ?? new Date().toISOString(),
      ],
    );
    const taskId = taskResult.rows[0].id;

    await client.query(
      `UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`,
      [taskId, runId],
    );

    const hydrated = await hydrateAgencyWorkflowRun(client as unknown as ReturnType<typeof getDb>, runId);
    await client.query("COMMIT");
    publishAgencyWorkflowQueued({
      agencyWorkflowRunId: runId,
      taskId,
      clientId: resolvedClientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: "reddit_account_health_scan",
      platform: "reddit",
    });
    res.status(201).json({ ok: true, data: rowToAgencyWorkflowRun(hydrated!) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    client.release();
  }
});

router.post("/workflow-runs", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as {
    clientId?: string;
    accountId?: string;
    deviceId?: string;
    intent?: string;
    requestKey?: string;
    cacheKey?: string;
    scheduledTime?: string;
    context?: Record<string, unknown>;
    workflow?: unknown;
  };

  if (Object.prototype.hasOwnProperty.call(body, "workflow")) {
    return res.status(400).json({
      ok: false,
      code: "WORKFLOW_PAYLOAD_NOT_ALLOWED",
      error: "workflow payload is not allowed for agency workflow runs",
    });
  }
  if (!body.clientId || !body.accountId || !body.deviceId || !body.intent) {
    return res.status(400).json({ ok: false, error: "clientId, accountId, deviceId and intent required" });
  }
  if (!SPRINT_2_READ_ONLY_INTENTS.has(body.intent)) {
    return res.status(400).json({
      ok: false,
      code: "GENERATED_WORKFLOW_INTENT_NOT_ALLOWED",
      error: "Sprint 2 agency workflow runs only accept read_only marketing scan intents",
    });
  }

  const hasRequestKey = typeof body.requestKey === "string" && body.requestKey.length > 0;
  const hasCacheKey = typeof body.cacheKey === "string" && body.cacheKey.length > 0;
  if ((hasRequestKey ? 1 : 0) + (hasCacheKey ? 1 : 0) !== 1) {
    return res.status(400).json({
      ok: false,
      code: "EXACTLY_ONE_CANONICAL_KEY_REQUIRED",
      error: "exactly one of requestKey or cacheKey required",
    });
  }
  if (hasRequestKey && !GENERATED_WORKFLOW_KEY_RE.test(body.requestKey!)) {
    return res.status(400).json({ ok: false, error: "requestKey must be a 24-character lowercase hex string" });
  }
  if (hasCacheKey && !GENERATED_WORKFLOW_KEY_RE.test(body.cacheKey!)) {
    return res.status(400).json({ ok: false, error: "cacheKey must be a 24-character lowercase hex string" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const cacheResult = await client.query<Record<string, unknown>>(
      hasCacheKey
        ? `SELECT * FROM generated_workflow_plan_cache
           WHERE cache_key = $1
             AND artifact_state = 'promoted'`
        : `SELECT * FROM generated_workflow_plan_cache
           WHERE request_key = $1
             AND artifact_state = 'promoted'
           ORDER BY updated_at DESC
           LIMIT 1`,
      [hasCacheKey ? body.cacheKey : body.requestKey]
    );
    const cached = cacheResult.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        code: "GENERATED_WORKFLOW_CACHE_MISS",
        error: "canonical generated workflow artifact not found",
      });
    }

    const safetyClass = cachedWorkflowSafetyClass(cached);
    if (safetyClass !== "read_only") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_NOT_READ_ONLY",
        error: "Sprint 2 agency workflow runs require safetyClass=read_only",
      });
    }

    const artifactIntent = cachedWorkflowIntent(cached);
    if (artifactIntent && artifactIntent !== body.intent) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_INTENT_MISMATCH",
        error: "intent does not match canonical generated workflow artifact",
      });
    }
    if (cachedWorkflowLlmHappyPathRequests(cached) !== 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_LLM_BUDGET_NOT_CACHE_SAFE",
        error: "canonical workflow happy path must avoid LLM calls",
      });
    }
    const platform = cachedWorkflowPlatform(cached);
    if (!platform) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_PLATFORM_MISSING",
        error: "canonical workflow artifact is missing platform metadata",
      });
    }

    const runContext = {
      ...(body.context ?? {}),
      source: "agency_workflow_runs",
      clientId: body.clientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: body.intent,
    };
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agency_workflow_runs
         (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
          canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12)
       RETURNING id`,
      [
        body.clientId,
        body.accountId,
        body.deviceId,
        platform,
        body.intent,
        safetyClass,
        hasRequestKey ? body.requestKey : null,
        hasCacheKey ? body.cacheKey : null,
        cached.canonical_workflow_id,
        cached.canonical_workflow_version,
        cached.compiled_plan_hash,
        JSON.stringify(runContext),
      ]
    );
    const runId = runResult.rows[0].id;

    const taskParams = {
      ...(hasRequestKey ? { requestKey: body.requestKey } : { cacheKey: body.cacheKey }),
      clientId: body.clientId,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: body.intent,
    };
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [
        body.accountId,
        body.deviceId,
        JSON.stringify(taskParams),
        body.scheduledTime ?? new Date().toISOString(),
      ]
    );
    const taskId = taskResult.rows[0].id;

    await client.query(
      `UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`,
      [taskId, runId]
    );

    const hydrated = await client.query(
      agencyWorkflowRunSelectSql(`r.id = $1`),
      [runId]
    );
    await client.query("COMMIT");
    publishAgencyWorkflowQueued({
      agencyWorkflowRunId: runId,
      taskId,
      clientId: body.clientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: body.intent,
      platform,
    });
    res.status(201).json({ ok: true, data: rowToAgencyWorkflowRun(hydrated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    client.release();
  }
});

router.get("/workflow-runs", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const filters = {
    clientId: req.query.clientId as string | undefined,
    accountId: req.query.accountId as string | undefined,
    deviceId: req.query.deviceId as string | undefined,
    intent: req.query.intent as string | undefined,
    status: req.query.status as string | undefined,
    taskId: req.query.taskId as string | undefined,
    requestKey: req.query.requestKey as string | undefined,
    cacheKey: req.query.cacheKey as string | undefined,
  };

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [field, value] of Object.entries(filters)) {
    if (!value) continue;
    const column = ({
      clientId: "r.client_id",
      accountId: "r.account_id",
      deviceId: "r.device_id",
      intent: "r.intent",
      status: "COALESCE(t.status, r.status)",
      taskId: "r.task_id",
      requestKey: "r.request_key",
      cacheKey: "r.cache_key",
    } as Record<string, string>)[field];
    conditions.push(`${column} = $${idx++}`);
    values.push(value);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `${agencyWorkflowRunSelectSql(where)}
       ORDER BY r.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(`SELECT COUNT(*) FROM agency_workflow_runs r LEFT JOIN tasks t ON t.id = r.task_id ${where}`, values.slice(0, -2)),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToAgencyWorkflowRun),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/workflow-step-candidates", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const rawState = typeof req.query.state === "string" ? req.query.state : "step_candidate";
  const state = ["step_candidate", "validated_step", "rejected", "all"].includes(rawState) ? rawState : "step_candidate";
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (state !== "all") {
    conditions.push(`c.candidate_state = $${idx++}`);
    values.push(state);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT c.*,
              r.status AS run_status,
              r.intent AS run_intent,
              d.friendly_name AS device_name
       FROM agency_workflow_step_candidates c
       LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
       LEFT JOIN devices d ON d.id = r.device_id
       ${where}
       ORDER BY c.updated_at DESC, c.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM agency_workflow_step_candidates c ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToStepCandidate),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/step-library", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : null;
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : null;
  const conditions = ["c.candidate_state = 'validated_step'"];
  const values: unknown[] = [];
  let idx = 1;

  if (action) {
    conditions.push(`c.action = $${idx++}`);
    values.push(action);
  }
  if (intent) {
    conditions.push(`r.intent = $${idx++}`);
    values.push(intent);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT c.*,
              r.status AS run_status,
              r.intent AS run_intent,
              d.friendly_name AS device_name
       FROM agency_workflow_step_candidates c
       LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
       LEFT JOIN devices d ON d.id = r.device_id
       ${where}
       ORDER BY c.validated_at DESC NULLS LAST, c.updated_at DESC, c.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM agency_workflow_step_candidates c
       LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
       ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToStepLibraryEntry),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/step-library/promotion-events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const entryId = typeof req.query.entryId === "string" && req.query.entryId.trim().length > 0
    ? req.query.entryId.trim()
    : null;
  const rawAction = typeof req.query.action === "string" ? req.query.action.trim() : "";
  const action = ["promote_limited", "revoke"].includes(rawAction) ? rawAction : null;
  const actor = typeof req.query.actor === "string" && req.query.actor.trim().length > 0
    ? req.query.actor.trim()
    : null;
  const scope = typeof req.query.scope === "string" && req.query.scope.trim().length > 0
    ? req.query.scope.trim()
    : null;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (entryId) {
    conditions.push(`e.step_candidate_id = $${idx++}`);
    values.push(entryId);
  }
  if (action) {
    conditions.push(`e.action = $${idx++}`);
    values.push(action);
  }
  if (actor) {
    conditions.push(`e.actor = $${idx++}`);
    values.push(actor);
  }
  if (scope) {
    conditions.push(`e.promotion_scope = $${idx++}`);
    values.push(scope);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT e.*,
              c.label AS step_name,
              c.action AS step_action,
              r.intent AS run_intent,
              d.friendly_name AS device_name
       FROM agency_workflow_step_library_promotion_events e
       LEFT JOIN agency_workflow_step_candidates c ON c.id = e.step_candidate_id
       LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
       LEFT JOIN devices d ON d.id = r.device_id
       ${where}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_workflow_step_library_promotion_events e
       LEFT JOIN agency_workflow_step_candidates c ON c.id = e.step_candidate_id
       LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
       ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToStepLibraryPromotionEvent),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/tool-catalog", requireAdminAuth, async (req: Request, res: Response) => {
  const category = typeof req.query.category === "string" && req.query.category.trim().length > 0
    ? req.query.category.trim()
    : undefined;
  const risk = typeof req.query.risk === "string" && req.query.risk.trim().length > 0
    ? req.query.risk.trim()
    : undefined;
  const source = typeof req.query.source === "string" && req.query.source.trim().length > 0
    ? req.query.source.trim()
    : undefined;
  const items = listToolCatalog({ category, risk, source });
  res.json({
    ok: true,
    data: {
      items,
      total: items.length,
      policy: {
        compilerVisible: false,
        autoUseEnabled: false,
        mode: "read_only_catalog",
      },
    },
  });
});

router.get("/compiler-knowledge", requireAdminAuth, async (req: Request, res: Response) => {
  const type = typeof req.query.type === "string" && req.query.type.trim().length > 0
    ? req.query.type.trim()
    : undefined;
  const domain = typeof req.query.domain === "string" && req.query.domain.trim().length > 0
    ? req.query.domain.trim()
    : undefined;
  const risk = typeof req.query.risk === "string" && req.query.risk.trim().length > 0
    ? req.query.risk.trim()
    : undefined;
  const source = typeof req.query.source === "string" && req.query.source.trim().length > 0
    ? req.query.source.trim()
    : undefined;
  const items = listCompilerKnowledge({ type, domain, risk, source });
  res.json({
    ok: true,
    data: {
      items,
      total: items.length,
      policy: {
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        mode: "read_only_knowledge_base",
      },
    },
  });
});

router.get("/compiler-policy-gates", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const category = typeof req.query.category === "string" && req.query.category.trim().length > 0
    ? req.query.category.trim()
    : undefined;
  const state = typeof req.query.state === "string" && req.query.state.trim().length > 0
    ? req.query.state.trim()
    : undefined;
  const risk = typeof req.query.risk === "string" && req.query.risk.trim().length > 0
    ? req.query.risk.trim()
    : undefined;
  const owner = typeof req.query.owner === "string" && req.query.owner.trim().length > 0
    ? req.query.owner.trim()
    : undefined;
  const items = await getCompilerPolicyGates(db, { category, state, risk, owner });
  res.json({
    ok: true,
    data: {
      items,
      total: items.length,
      policy: {
        readOnly: true,
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        mode: "read_only_compiler_policy_gates",
      },
    },
  });
});

router.get("/compiler-policy-gates/events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const gateId = typeof req.query.gateId === "string" && req.query.gateId.trim().length > 0
    ? req.query.gateId.trim()
    : null;
  const where = gateId ? "WHERE gate_id = $1" : "";
  const values = gateId ? [gateId, pageSize, offset] : [pageSize, offset];
  const limitIndex = gateId ? 2 : 1;
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_compiler_policy_gate_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_compiler_policy_gate_events
       ${where}`,
      gateId ? [gateId] : []
    ),
  ]);
  res.json({
    ok: true,
    data: {
      items: rows.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        gateId: row.gate_id,
        previousState: row.previous_state ?? null,
        nextState: row.next_state,
        version: row.version,
        note: row.note ?? null,
        actor: row.actor ?? null,
        config: row.config ?? {},
        policy: row.policy ?? {},
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
      })),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.patch("/compiler-policy-gates/:gateId", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const parsed = parseCompilerPolicyGateUpdate(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }
  const gates = await getCompilerPolicyGates(db);
  const gate = gates.find((item) => item.id === req.params.gateId);
  if (!gate) {
    return res.status(404).json({ ok: false, error: "Compiler policy gate not found", code: "COMPILER_POLICY_GATE_NOT_FOUND" });
  }
  if (parsed.state === "enabled" && gate.risk === "high" && parsed.config.explicitApproval !== true) {
    return res.status(400).json({
      ok: false,
      error: "High-risk gates require config.explicitApproval=true",
      code: "COMPILER_POLICY_GATE_EXPLICIT_APPROVAL_REQUIRED",
    });
  }
  const nextVersion = Number(gate.version ?? 1) + 1;
  const policy = {
    manualOnly: true,
    editableGates: true,
    compilerVisible: parsed.state === "enabled" && ["compiler_knowledge_application", "limited_reuse_scope_match", "compiler_auto_use"].includes(gate.id),
    autoUseEnabled: parsed.state === "enabled" && gate.id === "compiler_auto_use",
    executionChanging: false,
    workflowCacheChanging: false,
    wouldExecuteWorkflow: false,
    safeToAutoApply: false,
    mode: "compiler_policy_gate_manual_update",
  };
  const client = await db.connect();
  let updatedRows;
  try {
    await client.query("BEGIN");
    updatedRows = await client.query(
      `INSERT INTO agency_compiler_policy_gate_config (gate_id, state, version, owner, risk, config, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'dashboard', NOW())
       ON CONFLICT (gate_id)
       DO UPDATE SET state = EXCLUDED.state,
                     version = EXCLUDED.version,
                     owner = EXCLUDED.owner,
                     risk = EXCLUDED.risk,
                     config = EXCLUDED.config,
                     updated_by = 'dashboard',
                     updated_at = NOW()
       RETURNING *`,
      [gate.id, parsed.state, nextVersion, gate.owner, gate.risk, JSON.stringify(parsed.config)]
    );
    await client.query(
      `INSERT INTO agency_compiler_policy_gate_events (
         gate_id, previous_state, next_state, version, note, actor, config, policy
       )
       VALUES ($1, $2, $3, $4, $5, 'dashboard', $6, $7)`,
      [gate.id, gate.state, parsed.state, nextVersion, parsed.note, JSON.stringify(parsed.config), JSON.stringify(policy)]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const updated = (await getCompilerPolicyGates(db)).find((item) => item.id === gate.id) ?? gate;
  res.json({
    ok: true,
    data: {
      gate: updated,
      config: updatedRows.rows[0],
      previousState: gate.state,
      nextState: parsed.state,
      policy,
    },
  });
});

router.get("/workflow-definitions/promotion-events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const definitionId = typeof req.query.definitionId === "string" && req.query.definitionId.trim().length > 0
    ? req.query.definitionId.trim()
    : null;
  const key = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : null;
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : null;
  const actor = typeof req.query.actor === "string" && req.query.actor.trim().length > 0
    ? req.query.actor.trim()
    : null;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (definitionId) {
    conditions.push(`definition_id = $${idx++}`);
    values.push(definitionId);
  }
  if (key) {
    conditions.push(`definition_key = $${idx++}`);
    values.push(key);
  }
  if (action) {
    conditions.push(`action = $${idx++}`);
    values.push(action);
  }
  if (actor) {
    conditions.push(`actor = $${idx++}`);
    values.push(actor);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_workflow_definition_promotion_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_workflow_definition_promotion_events
       ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToWorkflowDefinitionPromotionEvent),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
      policy: {
        readOnly: true,
        auditOnly: true,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
        mode: "workflow_definition_promotion_events_read_only",
      },
    },
  });
});

router.get("/workflow-definitions/version-events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const definitionId = typeof req.query.definitionId === "string" && req.query.definitionId.trim().length > 0
    ? req.query.definitionId.trim()
    : null;
  const key = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : null;
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : null;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (definitionId) {
    conditions.push(`definition_id = $${idx++}`);
    values.push(definitionId);
  }
  if (key) {
    conditions.push(`definition_key = $${idx++}`);
    values.push(key);
  }
  if (action) {
    conditions.push(`action = $${idx++}`);
    values.push(action);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_workflow_definition_version_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_workflow_definition_version_events
       ${where}`,
      values.slice(0, -2)
    ),
  ]);
  res.json({
    ok: true,
    data: {
      items: rows.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        definitionId: row.definition_id ?? null,
        definitionKey: row.definition_key,
        definitionVersion: row.definition_version,
        action: row.action,
        previousStatus: row.previous_status ?? null,
        nextStatus: row.next_status ?? null,
        targetDefinitionId: row.target_definition_id ?? null,
        note: row.note ?? null,
        actor: row.actor ?? null,
        diff: row.diff ?? {},
        impactPreview: row.impact_preview ?? {},
        policy: row.policy ?? {},
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
      })),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
      policy: {
        auditOnly: true,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
      },
    },
  });
});

router.get("/workflow-definitions", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const status = typeof req.query.status === "string" && req.query.status.trim().length > 0
    ? req.query.status.trim()
    : undefined;
  const platform = typeof req.query.platform === "string" && req.query.platform.trim().length > 0
    ? req.query.platform.trim()
    : undefined;
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : undefined;
  const key = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }
  if (platform) {
    conditions.push(`platform = $${idx++}`);
    values.push(platform);
  }
  if (intent) {
    conditions.push(`intent = $${idx++}`);
    values.push(intent);
  }
  if (key) {
    conditions.push(`definition_key = $${idx++}`);
    values.push(key);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db.query(
    `SELECT *
     FROM agency_workflow_definitions
     ${where}
     ORDER BY
       CASE status
         WHEN 'active' THEN 1
         WHEN 'draft' THEN 2
         WHEN 'deprecated' THEN 3
         ELSE 4
       END,
       definition_key ASC,
       version DESC`,
    values
  );
  const items = rows.rows.map(rowToWorkflowDefinition);

  res.json({
    ok: true,
    data: {
      items,
      total: items.length,
      policy: workflowDefinitionRegistryPolicy(),
      summary: {
        active: items.filter((item) => item.status === "active").length,
        draft: items.filter((item) => item.status === "draft").length,
        deprecated: items.filter((item) => item.status === "deprecated").length,
        archived: items.filter((item) => item.status === "archived").length,
      },
    },
  });
});

router.get("/workflow-definitions/resolve", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : undefined;
  const platform = typeof req.query.platform === "string" && req.query.platform.trim().length > 0
    ? req.query.platform.trim()
    : undefined;
  const key = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : undefined;
  const requestedScope = typeof req.query.scope === "string" && req.query.scope.trim().length > 0
    ? req.query.scope.trim()
    : undefined;

  const [definitions, gates] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_workflow_definitions
       WHERE status IN ('active', 'draft')
       ORDER BY definition_key ASC, version DESC`
    ),
    getCompilerPolicyGates(db),
  ]);

  const resolution = buildWorkflowDefinitionResolution({
    intent,
    platform,
    key,
    requestedScope,
    definitions: definitions.rows.map(rowToWorkflowDefinition),
    policyGates: gates,
  });

  res.json({ ok: true, data: resolution });
});

router.post("/workflow-definitions/:id/auto-use-run", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const body = normalizeJsonObject(req.body);
  const deviceId = typeof body.deviceId === "string" && body.deviceId.trim().length > 0 ? body.deviceId.trim() : "";
  const accountId = typeof body.accountId === "string" && body.accountId.trim().length > 0 ? body.accountId.trim() : null;
  const clientId = typeof body.clientId === "string" && body.clientId.trim().length > 0 ? body.clientId.trim() : null;
  const requestedScope = typeof body.scope === "string" && body.scope.trim().length > 0 ? body.scope.trim() : undefined;
  const scheduledTime = typeof body.scheduledTime === "string" && body.scheduledTime.trim().length > 0
    ? body.scheduledTime.trim()
    : new Date().toISOString();

  if (!UUID_RE.test(deviceId)) {
    return res.status(400).json({ ok: false, code: "DEVICE_ID_REQUIRED", error: "deviceId must be a UUID" });
  }
  if (accountId !== null && !UUID_RE.test(accountId)) {
    return res.status(400).json({ ok: false, code: "ACCOUNT_ID_INVALID", error: "accountId must be a UUID when provided" });
  }
  if (clientId !== null && !UUID_RE.test(clientId)) {
    return res.status(400).json({ ok: false, code: "CLIENT_ID_INVALID", error: "clientId must be a UUID when provided" });
  }

  const [definitionRows, gates] = await Promise.all([
    db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id]),
    getCompilerPolicyGates(db),
  ]);
  const row = definitionRows.rows[0];
  if (!row) {
    return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  }

  const definition = rowToWorkflowDefinition(row);
  const scope = requestedScope ?? definition.promotion.scope ?? workflowDefinitionScopeFor(definition);
  const resolution = buildWorkflowDefinitionResolution({
    key: definition.key,
    intent: definition.intent,
    platform: definition.platform,
    requestedScope: scope,
    definitions: [definition],
    policyGates: gates,
  }) as Record<string, any>;

  if (resolution.wouldExecuteWorkflow !== true || resolution.safeToAutoApply !== true) {
    return res.status(409).json({
      ok: false,
      code: "WORKFLOW_DEFINITION_AUTO_USE_BLOCKED",
      error: "workflow definition auto-use is blocked by policy, scope, readiness, or confidence",
      data: { resolution },
    });
  }

  const template = workflowDefinitionToExecutableTemplate(definition);
  if (!template) {
    return res.status(409).json({
      ok: false,
      code: "WORKFLOW_DEFINITION_EXECUTABLE_TEMPLATE_UNAVAILABLE",
      error: "this workflow definition does not yet have a deterministic executable template",
      data: {
        definition: { id: definition.id, key: definition.key, version: definition.version },
        resolution,
      },
    });
  }

  const compiledPlan = compileGeneratedWorkflowTemplate(template);
  const requestKey = computeWorkflowDefinitionAutoUseRequestKey({
    definitionId: definition.id,
    definitionVersion: definition.version,
    deviceId,
    accountId,
  });
  await workflowService.saveTemplate(template);
  await workflowService.saveGeneratedPlanCache(template, compiledPlan, requestKey, {
    artifactState: "promoted",
    sourceMetadata: {
      source: "workflow_definition_auto_use",
      definitionId: definition.id,
      definitionKey: definition.key,
      definitionVersion: definition.version,
      promotionScope: scope,
      autoUseEnabled: true,
      safeToAutoApply: true,
    },
  });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cacheRows = await client.query<Record<string, unknown>>(
      `SELECT * FROM generated_workflow_plan_cache
       WHERE cache_key = $1
         AND artifact_state = 'promoted'`,
      [compiledPlan.cacheKey]
    );
    const cached = cacheRows.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        code: "WORKFLOW_DEFINITION_AUTO_USE_CACHE_MISS",
        error: "promoted generated workflow artifact was not found after auto-use compile",
      });
    }

    const runContext = {
      source: "workflow_definition_auto_use",
      clientId,
      accountId,
      deviceId,
      intent: definition.intent,
      definitionId: definition.id,
      definitionKey: definition.key,
      definitionVersion: definition.version,
      promotionScope: scope,
      resolution,
      autoUseEnabled: true,
      safeToAutoApply: true,
    };
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agency_workflow_runs
         (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
          canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, 'queued', $11)
       RETURNING id`,
      [
        clientId,
        accountId,
        deviceId,
        definition.platform,
        definition.intent,
        template.safetyClass ?? "standard",
        cached.cache_key,
        cached.canonical_workflow_id,
        cached.canonical_workflow_version,
        cached.compiled_plan_hash,
        JSON.stringify(runContext),
      ]
    );
    const runId = runResult.rows[0].id;
    const taskParams = {
      cacheKey: cached.cache_key,
      clientId,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: definition.intent,
      source: "workflow_definition_auto_use",
      definitionId: definition.id,
      definitionKey: definition.key,
      definitionVersion: definition.version,
      promotionScope: scope,
    };
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [accountId, deviceId, JSON.stringify(taskParams), scheduledTime]
    );
    const taskId = taskResult.rows[0].id;
    await client.query(`UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`, [taskId, runId]);
    await client.query(
      `INSERT INTO agency_workflow_definition_version_events (
         definition_id, definition_key, definition_version, action, previous_status, next_status,
         note, actor, diff, impact_preview, policy
       )
       VALUES ($1, $2, $3, 'auto_use_execution_queued', $4, $4, $5, 'api', '{}'::jsonb, $6, $7)`,
      [
        definition.id,
        definition.key,
        definition.version,
        definition.status,
        `Queued auto-use run ${runId}`,
        JSON.stringify({ runId, taskId, cacheKey: cached.cache_key, requestKey, scope, resolution }),
        JSON.stringify({
          autoUseEnabled: true,
          executionChanging: true,
          workflowCacheChanging: true,
          safeToAutoApply: true,
          mode: "controlled_auto_use_execution_v1",
        }),
      ]
    );
    const hydrated = await hydrateAgencyWorkflowRun(client as unknown as ReturnType<typeof getDb>, runId);
    await client.query("COMMIT");
    publishAgencyWorkflowQueued({
      agencyWorkflowRunId: runId,
      taskId,
      clientId,
      accountId,
      deviceId,
      intent: definition.intent,
      platform: definition.platform,
    });
    taskRunnerService.pollNow().catch((err) => console.error("[workflow-definition-auto-use] immediate task runner poll failed:", err));
    return res.status(201).json({
      ok: true,
      data: {
        run: rowToAgencyWorkflowRun(hydrated!),
        definition: { id: definition.id, key: definition.key, version: definition.version },
        taskId,
        cacheKey: cached.cache_key,
        requestKey,
        resolution,
        policy: {
          autoUseEnabled: true,
          executionChanging: true,
          workflowCacheChanging: true,
          safeToAutoApply: true,
          mode: "controlled_auto_use_execution_v1",
        },
      },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

router.get("/workflow-definitions/:id/versions", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const row = (await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  const definition = rowToWorkflowDefinition(row);
  const rows = await db.query(
    `SELECT *
     FROM agency_workflow_definitions
     WHERE definition_key = $1
     ORDER BY version DESC`,
    [definition.key]
  );
  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToWorkflowDefinition),
      total: rows.rows.length,
      policy: {
        versioningEnabled: true,
        executionChanging: false,
        workflowCacheChanging: false,
      },
    },
  });
});

router.post("/workflow-definitions/:id/versions", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const parsed = parseWorkflowDefinitionVersion(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }
  const row = (await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  const source = rowToWorkflowDefinition(row);
  const versionRow = await db.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM agency_workflow_definitions
     WHERE definition_key = $1`,
    [source.key]
  );
  const nextVersion = Number(versionRow.rows[0].next_version ?? source.version + 1);
  const client = await db.connect();
  let created;
  let diff: Record<string, unknown> = {};
  let impactPreview: Record<string, unknown> = {};
  const policy = {
    versioningEnabled: true,
    manualOnly: true,
    compilerVisible: false,
    autoUseEnabled: false,
    executionChanging: false,
    workflowCacheChanging: false,
    wouldExecuteWorkflow: false,
    safeToAutoApply: false,
    mode: "workflow_definition_version_create_manual",
  };
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO agency_workflow_definitions (
         definition_key, version, status, title, description, platform, intent, goal, source,
         parent_definition_id, version_note, definition, success_criteria, allowed_tools,
         required_capabilities, constraints, fallback_rules, rollback, policy, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dashboard_version',
               $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'dashboard')
       RETURNING *`,
      [
        source.key,
        nextVersion,
        parsed.status,
        parsed.title ?? source.title,
        parsed.description === undefined ? source.description : parsed.description,
        source.platform,
        source.intent,
        parsed.goal ?? source.goal,
        source.id,
        parsed.note,
        JSON.stringify(parsed.definition ?? source.definition),
        JSON.stringify(parsed.successCriteria ?? source.successCriteria),
        JSON.stringify(parsed.allowedTools ?? source.allowedTools),
        JSON.stringify(parsed.requiredCapabilities ?? source.requiredCapabilities),
        JSON.stringify(parsed.constraints ?? source.constraints),
        JSON.stringify(parsed.fallbackRules ?? source.fallbackRules),
        JSON.stringify(parsed.rollback ?? source.rollback),
        JSON.stringify(source.policy),
      ]
    );
    created = rowToWorkflowDefinition(inserted.rows[0]);
    diff = workflowDefinitionDiff(source, created);
    impactPreview = await workflowDefinitionImpactPreview(db, created);
    await client.query(
      `INSERT INTO agency_workflow_definition_version_events (
         definition_id, definition_key, definition_version, action, previous_status, next_status,
         target_definition_id, note, actor, diff, impact_preview, policy
       )
       VALUES ($1, $2, $3, 'create_version', $4, $5, $6, $7, 'dashboard', $8, $9, $10)`,
      [
        created.id,
        created.key,
        created.version,
        source.status,
        created.status,
        source.id,
        parsed.note,
        JSON.stringify(diff),
        JSON.stringify(impactPreview),
        JSON.stringify(policy),
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json({ ok: true, data: { definition: created, diff, impactPreview, policy } });
});

router.get("/workflow-definitions/:id/diff", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const rows = await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id]);
  const sourceRow = rows.rows[0];
  if (!sourceRow) return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  const source = rowToWorkflowDefinition(sourceRow);
  let targetRow = null;
  if (typeof req.query.targetId === "string" && req.query.targetId.trim().length > 0) {
    targetRow = (await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.query.targetId.trim()])).rows[0] ?? null;
  } else {
    targetRow = (await db.query(
      `SELECT * FROM agency_workflow_definitions WHERE definition_key = $1 AND id <> $2 ORDER BY version DESC LIMIT 1`,
      [source.key, source.id]
    )).rows[0] ?? null;
  }
  if (!targetRow) return res.status(404).json({ ok: false, error: "Workflow definition diff target not found", code: "WORKFLOW_DEFINITION_DIFF_TARGET_NOT_FOUND" });
  const target = rowToWorkflowDefinition(targetRow);
  if (target.key !== source.key) {
    return res.status(400).json({ ok: false, error: "Diff target must use the same definition key", code: "WORKFLOW_DEFINITION_DIFF_KEY_MISMATCH" });
  }
  res.json({ ok: true, data: { ...workflowDefinitionDiff(source, target), policy: { readOnly: true, executionChanging: false, workflowCacheChanging: false } } });
});

router.get("/workflow-definitions/:id/impact-preview", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const row = (await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  const definition = rowToWorkflowDefinition(row);
  res.json({ ok: true, data: await workflowDefinitionImpactPreview(db, definition) });
});

router.get("/workflow-definitions/:id/promotion-hardening", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const row = (await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  const scope = typeof req.query.scope === "string" && req.query.scope.trim().length > 0 ? req.query.scope.trim() : null;
  const definition = rowToWorkflowDefinition(row);
  const hardening = workflowDefinitionHardeningPreview(definition, scope);
  await db.query(
    `INSERT INTO agency_workflow_definition_version_events (
       definition_id, definition_key, definition_version, action, previous_status, next_status,
       note, actor, diff, impact_preview, policy
     )
     VALUES ($1, $2, $3, 'hardening_preview', $4, $4, NULL, 'dashboard', '{}'::jsonb, $5, $6)`,
    [
      definition.id,
      definition.key,
      definition.version,
      definition.status,
      JSON.stringify(hardening),
      JSON.stringify({
        hardeningPreview: true,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
      }),
    ]
  );
  res.json({ ok: true, data: hardening });
});

router.patch("/workflow-definitions/:id/lifecycle", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const parsed = parseWorkflowDefinitionLifecycle(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }
  const row = (await db.query(`SELECT * FROM agency_workflow_definitions WHERE id = $1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  const definition = rowToWorkflowDefinition(row);
  const nextStatus = parsed.action === "archive" ? "archived" : parsed.action === "deprecate" ? "deprecated" : parsed.action === "activate" ? "active" : "draft";
  const impactPreview = await workflowDefinitionImpactPreview(db, definition);
  const policy = {
    lifecycleAction: parsed.action,
    manualOnly: true,
    autoUseEnabled: false,
    executionChanging: false,
    workflowCacheChanging: false,
    wouldExecuteWorkflow: false,
    safeToAutoApply: false,
  };
  const client = await db.connect();
  let updated;
  try {
    await client.query("BEGIN");
    const updatedRows = await client.query(
      `UPDATE agency_workflow_definitions
       SET status = $2, version_note = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [definition.id, nextStatus, parsed.note]
    );
    updated = rowToWorkflowDefinition(updatedRows.rows[0]);
    await client.query(
      `INSERT INTO agency_workflow_definition_version_events (
         definition_id, definition_key, definition_version, action, previous_status, next_status,
         note, actor, diff, impact_preview, policy
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'dashboard', '{}'::jsonb, $8, $9)`,
      [definition.id, definition.key, definition.version, parsed.action, definition.status, nextStatus, parsed.note, JSON.stringify(impactPreview), JSON.stringify(policy)]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, data: { definition: updated, previousStatus: definition.status, nextStatus, impactPreview, policy } });
});

router.get("/workflow-definitions/:id/rollback-preview", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const rows = await db.query(
    `SELECT *
     FROM agency_workflow_definitions
     WHERE id = $1`,
    [req.params.id]
  );
  const row = rows.rows[0];
  if (!row) {
    return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  }
  const definition = rowToWorkflowDefinition(row);
  const preview = await workflowDefinitionRollbackPreview(db, definition);
  res.json({
    ok: true,
    data: {
      ...preview,
      policy: {
        readOnly: true,
        rollbackPreviewOnly: true,
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
        wouldUseDefinition: false,
        wouldExecuteWorkflow: false,
        mode: "workflow_definition_rollback_preview_read_only",
      },
    },
  });
});

router.patch("/workflow-definitions/:id/promotion", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const parsed = parseWorkflowDefinitionPromotion(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const [definitionRows, gates] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_workflow_definitions
       WHERE id = $1`,
      [req.params.id]
    ),
    getCompilerPolicyGates(db),
  ]);

  const currentRow = definitionRows.rows[0];
  if (!currentRow) {
    return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  }

  const definition = rowToWorkflowDefinition(currentRow);
  const pipeline = buildWorkflowValidationPipeline({
    definitions: [definition],
    policyGates: gates,
    intent: definition.intent,
    platform: definition.platform,
    key: definition.key,
  }) as Record<string, any>;
  const item = Array.isArray(pipeline.items) ? pipeline.items[0] as Record<string, any> | undefined : undefined;
  const staticValidation = (item?.staticValidation ?? {}) as Record<string, any>;
  const dryRun = (item?.dryRun ?? {}) as Record<string, any>;
  const decision = (item?.decision ?? {}) as Record<string, any>;
  const validationScore = Number(decision.validationScore ?? 0);
  const staticErrors = Number(staticValidation.errors ?? 0);
  const branchCoverage = Number(((dryRun.branchCoverage ?? {}) as Record<string, any>).coveragePercent ?? 0);

  if (parsed.action === "promote_limited") {
    if (!["active", "draft"].includes(definition.status)) {
      return res.status(400).json({
        ok: false,
        error: "Only active or draft workflow definitions can enter limited promotion review",
        code: "WORKFLOW_DEFINITION_STATUS_NOT_PROMOTABLE",
      });
    }
    if (definition.promotion.state === "limited_reuse") {
      return res.status(400).json({
        ok: false,
        error: "Workflow definition is already promoted for limited reuse",
        code: "WORKFLOW_DEFINITION_ALREADY_PROMOTED",
      });
    }
    if (staticErrors > 0) {
      return res.status(400).json({
        ok: false,
        error: "Workflow definition has static validation errors",
        code: "WORKFLOW_DEFINITION_STATIC_ERRORS_BLOCK_PROMOTION",
      });
    }
    if (validationScore < 60 || branchCoverage < 50) {
      return res.status(400).json({
        ok: false,
        error: "Workflow definition validation score or branch coverage is below the limited-promotion threshold",
        code: "WORKFLOW_DEFINITION_READINESS_BLOCKS_PROMOTION",
        data: { validationScore, branchCoverage, threshold: { validationScore: 60, branchCoverage: 50 } },
      });
    }
  }

  const nextState = parsed.action === "promote_limited" ? "limited_reuse" : "revoked";
  const updateSql = parsed.action === "promote_limited"
    ? `UPDATE agency_workflow_definitions
       SET promotion_state = 'limited_reuse',
           promotion_scope = $2,
           promotion_note = $3,
           promotion_confidence = $4,
           promotion_readiness = $5,
           promotion_scope_details = $6,
           rollback_preview = $7,
           promoted_by = 'dashboard',
           promoted_at = NOW(),
           revoked_by = NULL,
           revoked_at = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`
    : `UPDATE agency_workflow_definitions
       SET promotion_state = 'revoked',
           promotion_scope = NULL,
           promotion_note = $2,
           promotion_confidence = 0,
           promotion_readiness = $3,
           promotion_scope_details = $4,
           rollback_preview = $5,
           revoked_by = 'dashboard',
           revoked_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`;
  const validationSnapshot = {
    staticValidation,
    dryRun: {
      mode: dryRun.mode,
      branchCoverage: dryRun.branchCoverage,
      wouldUseDefinition: dryRun.wouldUseDefinition,
      wouldChangePlan: dryRun.wouldChangePlan,
      wouldChangeWorkflowCache: dryRun.wouldChangeWorkflowCache,
      wouldExecuteWorkflow: dryRun.wouldExecuteWorkflow,
    },
    decision: {
      outcome: decision.outcome,
      validationScore,
      promotionReadiness: decision.promotionReadiness,
      wouldPromoteDefinition: false,
      wouldUseDefinition: false,
      wouldExecuteWorkflow: false,
      wouldChangePlan: false,
      wouldChangeWorkflowCache: false,
      safeToAutoApply: false,
      blockers: decision.blockers ?? [],
    },
  };
  const promotionMetadata = workflowDefinitionPromotionMetadata({
    definition,
    validationSnapshot,
    scope: parsed.scope,
  });
  const rollbackPreview = await workflowDefinitionRollbackPreview(db, definition);
  const revokedReadiness = {
    ...promotionMetadata.readiness,
    state: "revoked",
    blockers: [
      "workflow_definition_revoked",
      "manual_review_required_before_repromotion",
    ],
  };
  const revokedScopeDetails = workflowDefinitionScopeDetails(null);
  const updateValues = parsed.action === "promote_limited"
    ? [
        definition.id,
        parsed.scope,
        parsed.note,
        promotionMetadata.confidence,
        JSON.stringify(promotionMetadata.readiness),
        JSON.stringify(promotionMetadata.scopeDetails),
        JSON.stringify(rollbackPreview),
      ]
    : [
        definition.id,
        parsed.note,
        JSON.stringify(revokedReadiness),
        JSON.stringify(revokedScopeDetails),
        JSON.stringify(rollbackPreview),
      ];

  const promotionPolicy = {
    manualOnly: true,
    readinessLinkedToValidationPipeline: true,
    confidenceRequired: true,
    rollbackPreviewRequired: true,
    compilerVisible: false,
    autoUseEnabled: false,
    executionChanging: false,
    workflowCacheChanging: false,
    wouldUseDefinition: false,
    wouldExecuteWorkflow: false,
    safeToAutoApply: false,
    mode: "workflow_definition_controlled_promotion_manual_only",
  };
  const client = await db.connect();
  let updatedDefinition;
  try {
    await client.query("BEGIN");
    const updated = await client.query(updateSql, updateValues);
    updatedDefinition = rowToWorkflowDefinition(updated.rows[0]);

    await client.query(
      `INSERT INTO agency_workflow_definition_promotion_events (
         definition_id,
         definition_key,
         definition_version,
         action,
         previous_state,
         next_state,
         promotion_scope,
         note,
         actor,
         policy,
         validation_snapshot,
         promotion_confidence,
         promotion_readiness,
         promotion_scope_details,
         rollback_preview
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dashboard', $9, $10, $11, $12, $13, $14)`,
      [
        definition.id,
        definition.key,
        definition.version,
        parsed.action,
        definition.promotion.state,
        nextState,
        parsed.scope,
        parsed.note,
        JSON.stringify(promotionPolicy),
        JSON.stringify(validationSnapshot),
        parsed.action === "promote_limited" ? promotionMetadata.confidence : 0,
        JSON.stringify(parsed.action === "promote_limited" ? promotionMetadata.readiness : revokedReadiness),
        JSON.stringify(parsed.action === "promote_limited" ? promotionMetadata.scopeDetails : revokedScopeDetails),
        JSON.stringify(rollbackPreview),
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({
    ok: true,
    data: {
      definition: updatedDefinition,
      action: parsed.action,
      previousState: definition.promotion.state,
      nextState,
      validationSnapshot,
      promotionConfidence: parsed.action === "promote_limited" ? promotionMetadata.confidence : 0,
      promotionReadiness: parsed.action === "promote_limited" ? promotionMetadata.readiness : revokedReadiness,
      promotionScopeDetails: parsed.action === "promote_limited" ? promotionMetadata.scopeDetails : revokedScopeDetails,
      rollbackPreview,
      policy: {
        ...promotionPolicy,
        wouldUseDefinition: false,
        wouldChangePlan: false,
        wouldChangeWorkflowCache: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      },
    },
  });
});

router.post("/workflow-definitions/:id/rollback", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const parsed = parseWorkflowDefinitionRollback(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const rows = await db.query(
    `SELECT *
     FROM agency_workflow_definitions
     WHERE id = $1`,
    [req.params.id]
  );
  const currentRow = rows.rows[0];
  if (!currentRow) {
    return res.status(404).json({ ok: false, error: "Workflow definition not found", code: "WORKFLOW_DEFINITION_NOT_FOUND" });
  }

  const definition = rowToWorkflowDefinition(currentRow);
  const preview = await workflowDefinitionRollbackPreview(db, definition);
  const previewTarget = normalizeJsonObject(preview.selectedTarget);
  const targetId = parsed.targetDefinitionId ?? (typeof previewTarget.id === "string" ? previewTarget.id : null);
  if (!targetId) {
    return res.status(400).json({
      ok: false,
      error: "No previous workflow definition version is available for rollback",
      code: "WORKFLOW_DEFINITION_ROLLBACK_TARGET_UNAVAILABLE",
      data: { rollbackPreview: preview },
    });
  }

  const targetRows = await db.query(
    `SELECT *
     FROM agency_workflow_definitions
     WHERE id = $1`,
    [targetId]
  );
  const targetRow = targetRows.rows[0];
  if (!targetRow) {
    return res.status(404).json({ ok: false, error: "Rollback target workflow definition not found", code: "WORKFLOW_DEFINITION_ROLLBACK_TARGET_NOT_FOUND" });
  }
  const targetDefinition = rowToWorkflowDefinition(targetRow);
  if (targetDefinition.key !== definition.key) {
    return res.status(400).json({
      ok: false,
      error: "Rollback target must use the same workflow definition key",
      code: "WORKFLOW_DEFINITION_ROLLBACK_KEY_MISMATCH",
    });
  }
  if (targetDefinition.version >= definition.version) {
    return res.status(400).json({
      ok: false,
      error: "Rollback target must be an older workflow definition version",
      code: "WORKFLOW_DEFINITION_ROLLBACK_TARGET_NOT_OLDER",
    });
  }

  const rollbackScope = definition.promotion.scope ?? `definition:${definition.key}:v${targetDefinition.version}`;
  const rollbackScopeDetails = workflowDefinitionScopeDetails(rollbackScope);
  const rollbackReadiness = {
    state: "manual_rollback_applied",
    manualOnly: true,
    sourceDefinitionId: definition.id,
    sourceVersion: definition.version,
    targetDefinitionId: targetDefinition.id,
    targetVersion: targetDefinition.version,
    linkedPreview: preview,
    blockers: [
      "compiler_auto_use_disabled",
      "manual_review_required_before_repromotion",
    ],
    wouldUseDefinition: false,
    wouldExecuteWorkflow: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    safeToAutoApply: false,
  };
  const rollbackPolicy = {
    manualOnly: true,
    rollbackAction: true,
    rollbackPreviewRequired: true,
    compilerVisible: false,
    autoUseEnabled: false,
    executionChanging: false,
    workflowCacheChanging: false,
    wouldUseDefinition: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    safeToAutoApply: false,
    mode: "workflow_definition_manual_rollback_audited",
  };
  const rollbackSnapshot = {
    source: {
      id: definition.id,
      key: definition.key,
      version: definition.version,
      previousState: definition.promotion.state,
    },
    target: {
      id: targetDefinition.id,
      key: targetDefinition.key,
      version: targetDefinition.version,
      previousState: targetDefinition.promotion.state,
    },
    preview,
    decision: {
      outcome: "manual_rollback_applied",
      wouldUseDefinition: false,
      wouldExecuteWorkflow: false,
      wouldChangePlan: false,
      wouldChangeWorkflowCache: false,
      safeToAutoApply: false,
    },
  };

  const client = await db.connect();
  let updatedSource;
  let updatedTarget;
  try {
    await client.query("BEGIN");
    const sourceUpdate = await client.query(
      `UPDATE agency_workflow_definitions
       SET promotion_state = 'revoked',
           promotion_scope = NULL,
           promotion_note = $2,
           promotion_confidence = 0,
           promotion_readiness = $3,
           promotion_scope_details = $4,
           rollback_definition_id = $5,
           rollback_preview = $6,
           revoked_by = 'dashboard',
           revoked_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        definition.id,
        parsed.note,
        JSON.stringify({
          ...rollbackReadiness,
          state: "rolled_back_from",
          targetDefinitionId: targetDefinition.id,
          targetVersion: targetDefinition.version,
        }),
        JSON.stringify(workflowDefinitionScopeDetails(null)),
        targetDefinition.id,
        JSON.stringify(preview),
      ]
    );
    const targetUpdate = await client.query(
      `UPDATE agency_workflow_definitions
       SET promotion_state = 'limited_reuse',
           promotion_scope = $2,
           promotion_note = $3,
           promotion_confidence = $4,
           promotion_readiness = $5,
           promotion_scope_details = $6,
           rollback_definition_id = NULL,
           rollback_preview = $7,
           promoted_by = 'dashboard',
           promoted_at = NOW(),
           revoked_by = NULL,
           revoked_at = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        targetDefinition.id,
        rollbackScope,
        parsed.note,
        Math.max(0, Math.min(0.99, targetDefinition.promotion.confidence || definition.promotion.confidence || 0)),
        JSON.stringify(rollbackReadiness),
        JSON.stringify(rollbackScopeDetails),
        JSON.stringify(preview),
      ]
    );
    updatedSource = rowToWorkflowDefinition(sourceUpdate.rows[0]);
    updatedTarget = rowToWorkflowDefinition(targetUpdate.rows[0]);

    await client.query(
      `INSERT INTO agency_workflow_definition_promotion_events (
         definition_id,
         definition_key,
         definition_version,
         action,
         previous_state,
         next_state,
         promotion_scope,
         note,
         actor,
         policy,
         validation_snapshot,
         promotion_confidence,
         promotion_readiness,
         promotion_scope_details,
         rollback_preview
       )
       VALUES ($1, $2, $3, 'rollback', $4, 'limited_reuse', $5, $6, 'dashboard', $7, $8, $9, $10, $11, $12)`,
      [
        definition.id,
        definition.key,
        definition.version,
        definition.promotion.state,
        rollbackScope,
        parsed.note,
        JSON.stringify(rollbackPolicy),
        JSON.stringify(rollbackSnapshot),
        updatedTarget.promotion.confidence,
        JSON.stringify(rollbackReadiness),
        JSON.stringify(rollbackScopeDetails),
        JSON.stringify(preview),
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({
    ok: true,
    data: {
      action: "rollback",
      previousState: definition.promotion.state,
      nextState: "limited_reuse",
      sourceDefinition: updatedSource,
      targetDefinition: updatedTarget,
      rollbackTarget: {
        id: targetDefinition.id,
        key: targetDefinition.key,
        version: targetDefinition.version,
      },
      validationSnapshot: rollbackSnapshot,
      promotionConfidence: updatedTarget.promotion.confidence,
      promotionReadiness: rollbackReadiness,
      promotionScopeDetails: rollbackScopeDetails,
      rollbackPreview: preview,
      policy: rollbackPolicy,
    },
  });
});

router.get("/workflow-validation-pipeline/events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : null;
  const platform = typeof req.query.platform === "string" && req.query.platform.trim().length > 0
    ? req.query.platform.trim()
    : null;
  const key = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : null;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (intent) {
    conditions.push(`intent ILIKE $${idx++}`);
    values.push(`%${intent}%`);
  }
  if (platform) {
    conditions.push(`platform = $${idx++}`);
    values.push(platform);
  }
  if (key) {
    conditions.push(`definition_key = $${idx++}`);
    values.push(key);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_workflow_validation_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_workflow_validation_events
       ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToWorkflowValidationEvent),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
      policy: workflowValidationPipelinePolicy(),
    },
  });
});

router.get("/workflow-validation-pipeline", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : undefined;
  const platform = typeof req.query.platform === "string" && req.query.platform.trim().length > 0
    ? req.query.platform.trim()
    : undefined;
  const key = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : undefined;

  const conditions = ["status IN ('active', 'draft')"];
  const values: unknown[] = [];
  let idx = 1;

  if (intent) {
    conditions.push(`intent = $${idx++}`);
    values.push(intent);
  }
  if (platform) {
    conditions.push(`platform = $${idx++}`);
    values.push(platform);
  }
  if (key) {
    conditions.push(`definition_key = $${idx++}`);
    values.push(key);
  }

  const [definitions, gates] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_workflow_definitions
       WHERE ${conditions.join(" AND ")}
       ORDER BY
         CASE status
           WHEN 'active' THEN 1
           WHEN 'draft' THEN 2
           ELSE 3
         END,
         definition_key ASC,
         version DESC
       LIMIT 50`,
      values
    ),
    getCompilerPolicyGates(db),
  ]);

  const pipeline = buildWorkflowValidationPipeline({
    intent,
    platform,
    key,
    definitions: definitions.rows.map(rowToWorkflowDefinition),
    policyGates: gates,
  });
  const data = pipeline as Record<string, any>;
  const firstItem = Array.isArray(data.items) ? data.items[0] as Record<string, any> | undefined : undefined;
  const firstDefinition = firstItem?.definition as Record<string, unknown> | undefined;

  await db.query(
    `INSERT INTO agency_workflow_validation_events (
       definition_id,
       definition_key,
       definition_version,
       intent,
       platform,
       summary,
       policy,
       static_validation,
       dry_run,
       smoke_readiness,
       canary_readiness,
       regression_readiness,
       decision,
       actor,
       source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'dashboard', 'dashboard')`,
    [
      firstDefinition?.id ?? null,
      firstDefinition?.key ?? key ?? null,
      firstDefinition?.version ?? null,
      intent ?? firstDefinition?.intent ?? null,
      platform ?? firstDefinition?.platform ?? null,
      JSON.stringify(data.summary ?? {}),
      JSON.stringify(data.policy ?? {}),
      JSON.stringify(firstItem?.staticValidation ?? {}),
      JSON.stringify(firstItem?.dryRun ?? {}),
      JSON.stringify(firstItem?.smokeReadiness ?? {}),
      JSON.stringify(firstItem?.canaryReadiness ?? {}),
      JSON.stringify(firstItem?.regressionReadiness ?? {}),
      JSON.stringify(firstItem?.decision ?? {}),
    ]
  );

  res.json({ ok: true, data: pipeline });
});

router.get("/compiler-control-plane/events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : null;
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : null;
  const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId.trim().length > 0
    ? req.query.deviceId.trim()
    : null;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (intent) {
    conditions.push(`intent ILIKE $${idx++}`);
    values.push(`%${intent}%`);
  }
  if (action) {
    conditions.push(`action = $${idx++}`);
    values.push(action);
  }
  if (deviceId) {
    conditions.push(`device_id = $${idx++}`);
    values.push(deviceId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_compiler_control_plane_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_compiler_control_plane_events
       ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToCompilerControlPlaneEvent),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
      policy: {
        readOnly: true,
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        mode: "compiler_control_plane_events_read_only",
      },
    },
  });
});

router.get("/compiler-control-plane", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : undefined;
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : undefined;
  const deviceId = typeof req.query.deviceId === "string" && req.query.deviceId.trim().length > 0
    ? req.query.deviceId.trim()
    : undefined;
  const requestedScope = typeof req.query.scope === "string" && req.query.scope.trim().length > 0
    ? req.query.scope.trim()
    : undefined;

  const values: unknown[] = [];
  const conditions = ["c.candidate_state = 'validated_step'"];
  let idx = 1;
  if (action) {
    conditions.push(`c.action = $${idx++}`);
    values.push(action);
  }

  const [steps, gates, device] = await Promise.all([
    db.query(
      `SELECT c.*,
              r.intent AS run_intent,
              d.friendly_name AS device_name
       FROM agency_workflow_step_candidates c
       LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
       LEFT JOIN devices d ON d.id = r.device_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.validated_at DESC NULLS LAST, c.updated_at DESC, c.created_at DESC
       LIMIT 50`,
      values
    ),
    getCompilerPolicyGates(db),
    deviceId
      ? db.query(
          `SELECT id, friendly_name, model, android_version, agent_version, status, last_seen_at
           FROM devices
           WHERE id = $1`,
          [deviceId]
        )
      : db.query(
          `SELECT id, friendly_name, model, android_version, agent_version, status, last_seen_at
           FROM devices
           WHERE status IN ('online', 'approved')
           ORDER BY last_seen_at DESC NULLS LAST
           LIMIT 1`
        ),
  ]);

  const awareness = buildCompilerAwareness({ intent, action, steps: steps.rows });
  const controlPlane = buildCompilerControlPlane({
    intent,
    action,
    requestedScope,
    device: device.rows[0] ?? null,
    awareness,
    policyGates: gates,
  });
  const data = controlPlane as Record<string, any>;
  await db.query(
    `INSERT INTO agency_compiler_control_plane_events (
       intent,
       action,
       device_id,
       requested_scope,
       summary,
       policy,
       dry_run,
       capability_manifest,
       limited_reuse_plan,
       actor,
       source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'dashboard', 'dashboard')`,
    [
      intent ?? null,
      action ?? null,
      data.capabilityManifest?.deviceId ?? null,
      requestedScope ?? null,
      JSON.stringify({
        policyGates: data.policyGates?.summary ?? {},
        awareness: data.awareness?.summary ?? {},
        dryRun: data.dryRun?.candidateCounts ?? {},
        limitedReuse: data.limitedReusePlan?.summary ?? {},
      }),
      JSON.stringify(data.policy ?? {}),
      JSON.stringify(data.dryRun ?? {}),
      JSON.stringify(data.capabilityManifest ?? {}),
      JSON.stringify(data.limitedReusePlan ?? {}),
    ]
  );

  res.json({ ok: true, data: controlPlane });
});

router.get("/compiler-awareness/events", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : null;
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : null;
  const source = typeof req.query.source === "string" && req.query.source.trim().length > 0
    ? req.query.source.trim()
    : null;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (intent) {
    conditions.push(`intent ILIKE $${idx++}`);
    values.push(`%${intent}%`);
  }
  if (action) {
    conditions.push(`action = $${idx++}`);
    values.push(action);
  }
  if (source) {
    conditions.push(`source = $${idx++}`);
    values.push(source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT *
       FROM agency_compiler_awareness_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*)
       FROM agency_compiler_awareness_events
       ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToCompilerAwarenessEvent),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
      policy: {
        readOnly: true,
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        mode: "read_only_compiler_awareness_events",
      },
    },
  });
});

router.get("/compiler-awareness", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const intent = typeof req.query.intent === "string" && req.query.intent.trim().length > 0
    ? req.query.intent.trim()
    : undefined;
  const action = typeof req.query.action === "string" && req.query.action.trim().length > 0
    ? req.query.action.trim()
    : undefined;

  const values: unknown[] = [];
  const conditions = ["c.candidate_state = 'validated_step'"];
  let idx = 1;
  if (action) {
    conditions.push(`c.action = $${idx++}`);
    values.push(action);
  }

  const steps = await db.query(
    `SELECT c.*,
            r.intent AS run_intent,
            d.friendly_name AS device_name
     FROM agency_workflow_step_candidates c
     LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
     LEFT JOIN devices d ON d.id = r.device_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.validated_at DESC NULLS LAST, c.updated_at DESC, c.created_at DESC
     LIMIT 50`,
    values
  );

  const awareness = buildCompilerAwareness({
    intent,
    action,
    steps: steps.rows,
  });
  const data = awareness as {
    terms?: unknown[];
    summary?: Record<string, unknown>;
    policy?: Record<string, unknown>;
    candidates?: {
      tools?: Array<{ id?: unknown; wouldUse?: unknown; reason?: unknown; eligibility?: unknown }>;
      steps?: Array<{ id?: unknown; action?: unknown; libraryState?: unknown; compilerEligible?: unknown; wouldUse?: unknown; reason?: unknown; eligibility?: unknown }>;
      knowledge?: Array<{ id?: unknown; wouldApply?: unknown; reason?: unknown; eligibility?: unknown }>;
    };
    decision?: Record<string, unknown>;
  };
  await db.query(
    `INSERT INTO agency_compiler_awareness_events (
       intent,
       action,
       terms,
       summary,
       policy,
       candidates,
       decision,
       actor,
       source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'dashboard', 'dashboard')`,
    [
      intent ?? null,
      action ?? null,
      Array.isArray(data.terms) ? data.terms.filter((term): term is string => typeof term === "string") : [],
      JSON.stringify(data.summary ?? {}),
      JSON.stringify(data.policy ?? {}),
      JSON.stringify({
        tools: (data.candidates?.tools ?? []).slice(0, 6).map((tool) => ({
          id: tool.id ?? null,
          wouldUse: tool.wouldUse ?? false,
          reason: tool.reason ?? null,
          eligibility: tool.eligibility ?? null,
        })),
        steps: (data.candidates?.steps ?? []).slice(0, 6).map((step) => ({
          id: step.id ?? null,
          action: step.action ?? null,
          libraryState: step.libraryState ?? null,
          compilerEligible: step.compilerEligible ?? false,
          wouldUse: step.wouldUse ?? false,
          reason: step.reason ?? null,
          eligibility: step.eligibility ?? null,
        })),
        knowledge: (data.candidates?.knowledge ?? []).slice(0, 6).map((entry) => ({
          id: entry.id ?? null,
          wouldApply: entry.wouldApply ?? false,
          reason: entry.reason ?? null,
          eligibility: entry.eligibility ?? null,
        })),
      }),
      JSON.stringify(data.decision ?? {}),
    ]
  );

  res.json({
    ok: true,
    data: awareness,
  });
});

router.patch("/step-library/:id/promotion", requireAdminAuth, async (req: Request, res: Response) => {
  const parsed = parseStepLibraryPromotion(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const db = getDb();
  const existing = await db.query(
    `SELECT c.*,
            r.status AS run_status,
            r.intent AS run_intent,
            d.friendly_name AS device_name
     FROM agency_workflow_step_candidates c
     LEFT JOIN agency_workflow_runs r ON r.id = c.run_id
     LEFT JOIN devices d ON d.id = r.device_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (existing.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Step Library entry not found", code: "STEP_LIBRARY_ENTRY_NOT_FOUND" });
  }
  if (existing.rows[0].candidate_state !== "validated_step") {
    return res.status(409).json({
      ok: false,
      error: "Only validated_step entries can be promoted in Step Library",
      code: "STEP_LIBRARY_ENTRY_NOT_VALIDATED",
    });
  }

  if (parsed.action === "promote_limited") {
    const entry = rowToStepLibraryEntry(existing.rows[0]) as Record<string, any>;
    const readiness = normalizeJsonObject(entry.readiness);
    const readinessScore = typeof readiness.score === "number" ? readiness.score : 0;
    const readinessThreshold = typeof readiness.threshold === "number" ? readiness.threshold : 0.9;
    const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
    const allowedBlockers = new Set(["limited_reuse_not_promoted", "compiler_auto_use_disabled"]);
    const hasUnexpectedBlocker = blockers.some((blocker) => typeof blocker !== "string" || !allowedBlockers.has(blocker));
    if (readinessScore < readinessThreshold || hasUnexpectedBlocker) {
      return res.status(409).json({
        ok: false,
        error: "Step Library entry is not ready for limited-scope promotion",
        code: "STEP_LIBRARY_ENTRY_NOT_READY",
        data: { readiness },
      });
    }
  }

  const updateSql = parsed.action === "promote_limited"
    ? `WITH updated AS (
         UPDATE agency_workflow_step_candidates
         SET library_state = 'limited_reuse',
             promotion_scope = $2,
             promotion_note = $3,
             promoted_by = 'dashboard',
             promoted_at = NOW(),
             revoked_by = NULL,
             revoked_at = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *
       )
       SELECT updated.*,
              r.status AS run_status,
              r.intent AS run_intent,
              d.friendly_name AS device_name
       FROM updated
       LEFT JOIN agency_workflow_runs r ON r.id = updated.run_id
       LEFT JOIN devices d ON d.id = r.device_id`
    : `WITH updated AS (
         UPDATE agency_workflow_step_candidates
         SET library_state = 'revoked',
             promotion_note = $2,
             revoked_by = 'dashboard',
             revoked_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *
       )
       SELECT updated.*,
              r.status AS run_status,
              r.intent AS run_intent,
              d.friendly_name AS device_name
       FROM updated
       LEFT JOIN agency_workflow_runs r ON r.id = updated.run_id
       LEFT JOIN devices d ON d.id = r.device_id`;

  const updateValues = parsed.action === "promote_limited"
    ? [req.params.id, parsed.scope, parsed.note]
    : [req.params.id, parsed.note];
  const updated = await db.query(updateSql, updateValues);
  const updatedRow = updated.rows[0];
  await db.query(
    `INSERT INTO agency_workflow_step_library_promotion_events (
       step_candidate_id,
       action,
       library_state,
       promotion_scope,
       note,
       actor,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, 'dashboard', $6)`,
    [
      req.params.id,
      parsed.action,
      parsed.action === "promote_limited" ? "limited_reuse" : "revoked",
      updatedRow.promotion_scope ?? null,
      parsed.note,
      JSON.stringify({
        source: "dashboard",
        compilerEligible: false,
        autoUseEnabled: false,
      }),
    ]
  );
  return res.json({ ok: true, data: rowToStepLibraryEntry(updatedRow) });
});

router.patch("/workflow-step-candidates/:id/review", requireAdminAuth, async (req: Request, res: Response) => {
  const parsed = parseStepCandidateReview(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const db = getDb();
  const existing = await db.query(
    `SELECT * FROM agency_workflow_step_candidates WHERE id = $1`,
    [req.params.id]
  );
  if (existing.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Step candidate not found", code: "STEP_CANDIDATE_NOT_FOUND" });
  }
  if (existing.rows[0].candidate_state === "validated_step") {
    return res.status(409).json({
      ok: false,
      error: "validated_step candidates require the validation workflow",
      code: "VALIDATED_STEP_REVIEW_LOCKED",
    });
  }

  const nextState = parsed.action === "reject" ? "rejected" : "step_candidate";
  const updated = await db.query(
    `UPDATE agency_workflow_step_candidates
     SET candidate_state = $2,
         review_note = $3,
         reviewed_by = 'dashboard',
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [req.params.id, nextState, parsed.note]
  );

  return res.json({ ok: true, data: rowToStepCandidate(updated.rows[0]) });
});

router.patch("/workflow-step-candidates/:id/validate", requireAdminAuth, async (req: Request, res: Response) => {
  const parsed = parseStepCandidateValidation(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const db = getDb();
  const existing = await db.query(
    `SELECT * FROM agency_workflow_step_candidates WHERE id = $1`,
    [req.params.id]
  );
  if (existing.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Step candidate not found", code: "STEP_CANDIDATE_NOT_FOUND" });
  }
  if (existing.rows[0].candidate_state !== "step_candidate") {
    return res.status(409).json({
      ok: false,
      error: "Only step_candidate entries can be validated",
      code: "STEP_CANDIDATE_NOT_IN_REVIEW",
    });
  }

  const updated = await db.query(
    `UPDATE agency_workflow_step_candidates
     SET candidate_state = 'validated_step',
         validation_contract = $2,
         validation_evidence = $3,
         review_note = $4,
         reviewed_by = 'dashboard',
         reviewed_at = NOW(),
         validated_by = 'dashboard',
         validated_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [req.params.id, parsed.contract, parsed.evidence, parsed.note]
  );

  return res.json({ ok: true, data: rowToStepCandidate(updated.rows[0]) });
});

router.post("/workflow-runs/purge-failed", requireAdminAuth, async (req: Request, res: Response) => {
  const confirm = req.body?.confirm === true;
  const db = getDb();

  if (!confirm) {
    const [runs, compileJobs, cacheArtifacts] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS count
         FROM agency_workflow_runs r
         LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'failed'
            OR t.status = 'failed'`
      ),
      db.query(
        `SELECT COUNT(*)::int AS count
         FROM human_workflow_compile_jobs
         WHERE status IN ('failed', 'cancelled')`
      ),
      db.query(
        `WITH failed_handles AS (
           SELECT request_key, cache_key
           FROM human_workflow_compile_jobs
           WHERE status IN ('failed', 'cancelled')

           UNION

           SELECT r.request_key, r.cache_key
           FROM agency_workflow_runs r
           LEFT JOIN tasks t ON t.id = r.task_id
           WHERE r.status = 'failed'
              OR t.status = 'failed'
         )
         SELECT COUNT(DISTINCT c.cache_key)::int AS count
         FROM generated_workflow_plan_cache c
         LEFT JOIN failed_handles h
           ON (h.request_key IS NOT NULL AND c.request_key = h.request_key)
           OR (h.cache_key IS NOT NULL AND c.cache_key = h.cache_key)
         WHERE c.artifact_state IN ('failed', 'quarantined')
            OR h.request_key IS NOT NULL
            OR h.cache_key IS NOT NULL`
      ),
    ]);

    return res.json({
      ok: true,
      data: {
        dryRun: true,
        failedWorkflowRuns: runs.rows[0]?.count ?? 0,
        failedCompileJobs: compileJobs.rows[0]?.count ?? 0,
        generatedCacheArtifacts: cacheArtifacts.rows[0]?.count ?? 0,
      },
    });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const cacheArtifacts = await client.query(
      `WITH failed_handles AS (
         SELECT request_key, cache_key
         FROM human_workflow_compile_jobs
         WHERE status IN ('failed', 'cancelled')

         UNION

         SELECT r.request_key, r.cache_key
         FROM agency_workflow_runs r
         LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'failed'
            OR t.status = 'failed'
       ),
       deleted AS (
         DELETE FROM generated_workflow_plan_cache c
         USING failed_handles h
         WHERE (h.request_key IS NOT NULL AND c.request_key = h.request_key)
            OR (h.cache_key IS NOT NULL AND c.cache_key = h.cache_key)
         RETURNING c.cache_key
       ),
       state_deleted AS (
         DELETE FROM generated_workflow_plan_cache c
         WHERE c.artifact_state IN ('failed', 'quarantined')
           AND NOT EXISTS (SELECT 1 FROM deleted d WHERE d.cache_key = c.cache_key)
         RETURNING c.cache_key
       )
       SELECT
         (SELECT COUNT(*)::int FROM deleted) +
         (SELECT COUNT(*)::int FROM state_deleted) AS count`
    );

    const compileJobs = await client.query(
      `DELETE FROM human_workflow_compile_jobs
       WHERE status IN ('failed', 'cancelled')
       RETURNING id`
    );

    const workflowRuns = await client.query(
      `DELETE FROM agency_workflow_runs r
       WHERE r.status = 'failed'
          OR EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = r.task_id
              AND t.status = 'failed'
          )
       RETURNING id`
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      data: {
        dryRun: false,
        failedWorkflowRuns: workflowRuns.rowCount ?? 0,
        failedCompileJobs: compileJobs.rowCount ?? 0,
        generatedCacheArtifacts: cacheArtifacts.rows[0]?.count ?? 0,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      ok: false,
      error: (err as Error).message,
    });
  } finally {
    client.release();
  }
});

router.post("/workflow-runs/:id/feedback", requireAdminAuth, async (req: Request, res: Response) => {
  const parsed = parseWorkflowRunFeedback(req.body);
  if ("error" in parsed) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const db = getDb();
  const existing = await db.query(agencyWorkflowRunSelectSql(`r.id = $1`), [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Workflow run not found", code: "WORKFLOW_RUN_NOT_FOUND" });
  }

  const existingRun = rowToAgencyWorkflowRun({ ...existing.rows[0], include_timeline: true });
  const timeline = Array.isArray(existingRun.timeline) ? existingRun.timeline : [];
  if (parsed.rating === "partial") {
    if (timeline.length > 0 && parsed.lastGoodStepIndex !== null && parsed.lastGoodStepIndex >= timeline.length) {
      return res.status(400).json({
        ok: false,
        error: "lastGoodStepIndex is outside the run timeline",
        code: "FEEDBACK_LAST_GOOD_STEP_OUT_OF_RANGE",
      });
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE agency_workflow_runs
       SET feedback_rating = $2,
           feedback_last_good_step_index = $3,
           feedback_note = $4,
           feedback_source = 'dashboard',
           feedback_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [req.params.id, parsed.rating, parsed.lastGoodStepIndex, parsed.note]
    );

    if (parsed.rating === "partial" && parsed.lastGoodStepIndex !== null) {
      const nominatedSteps = timeline
        .filter((step): step is Record<string, unknown> => normalizeJsonObject(step).index !== undefined)
        .filter((step) => typeof step.index === "number" && step.index <= parsed.lastGoodStepIndex!);

      for (const step of nominatedSteps) {
        await client.query(
          `INSERT INTO agency_workflow_step_candidates
             (run_id, step_index, step_id, label, action, type, step_status,
              candidate_state, request_key, cache_key, canonical_workflow_id,
              canonical_workflow_version, last_good_step_index, step_snapshot, evidence, note)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7,
              'step_candidate', $8, $9, $10,
              $11, $12, $13, $14, $15)
           ON CONFLICT (run_id, step_index) DO UPDATE
             SET label = EXCLUDED.label,
                 action = EXCLUDED.action,
                 type = EXCLUDED.type,
                 step_status = EXCLUDED.step_status,
                 candidate_state = 'step_candidate',
                 last_good_step_index = EXCLUDED.last_good_step_index,
                 step_snapshot = EXCLUDED.step_snapshot,
                 evidence = EXCLUDED.evidence,
                 note = EXCLUDED.note,
                 updated_at = NOW()
           WHERE agency_workflow_step_candidates.candidate_state = 'step_candidate'`,
          [
            req.params.id,
            step.index,
            step.id ?? null,
            step.label ?? `Step ${Number(step.index) + 1}`,
            step.action ?? null,
            step.type ?? null,
            step.status ?? null,
            existing.rows[0].request_key ?? null,
            existing.rows[0].cache_key ?? null,
            existing.rows[0].canonical_workflow_id ?? null,
            existing.rows[0].canonical_workflow_version ?? null,
            parsed.lastGoodStepIndex,
            step,
            buildStepCandidateEvidence({ run: existing.rows[0], lastGoodStepIndex: parsed.lastGoodStepIndex, step }),
            parsed.note,
          ]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    client.release();
  }

  const [updated, stepCandidates] = await Promise.all([
    db.query(agencyWorkflowRunSelectSql(`r.id = $1`), [req.params.id]),
    loadStepCandidates(db, req.params.id),
  ]);
  return res.json({
    ok: true,
    data: rowToAgencyWorkflowRun({ ...updated.rows[0], include_timeline: true, step_candidates: stepCandidates }),
  });
});

router.get("/workflow-runs/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const [result, stepCandidates] = await Promise.all([
    db.query(agencyWorkflowRunSelectSql(`r.id = $1`), [req.params.id]),
    loadStepCandidates(db, req.params.id),
  ]);
  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Workflow run not found" });
  }
  res.json({ ok: true, data: rowToAgencyWorkflowRun({ ...result.rows[0], include_timeline: true, step_candidates: stepCandidates }) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/tasks", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const status = req.query.status as string | undefined;
  const deviceId = req.query.deviceId as string | undefined;
  const accountId = req.query.accountId as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`t.status = $${idx++}`);
    values.push(status);
  }
  if (deviceId) {
    conditions.push(`t.device_id = $${idx++}`);
    values.push(deviceId);
  }
  if (accountId) {
    conditions.push(`t.account_id = $${idx++}`);
    values.push(accountId);
  }
  if (from) {
    conditions.push(`t.scheduled_time >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`t.scheduled_time <= $${idx++}`);
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT t.*, 
              a.username as account_username, 
              a.platform as account_platform,
              d.friendly_name as device_name
       FROM tasks t
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN devices d ON t.device_id = d.id
       ${where}
       ORDER BY t.scheduled_time DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM tasks t ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.patch("/tasks/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { status } = req.body as { status: "paused" | "queued" };

  if (!["paused", "queued"].includes(status)) {
    return res.status(400).json({ ok: false, error: "status must be 'paused' or 'queued'" });
  }

  const result = await db.query(
    `UPDATE tasks SET status = $1 WHERE id = $2 AND status IN ('queued', 'paused') RETURNING *`,
    [status, req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Task not found or not modifiable" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/reports", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const type = req.query.type as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (type) {
    conditions.push(`type = $${idx++}`);
    values.push(type);
  }
  if (from) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`created_at <= $${idx++}`);
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM reports ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

// Aggregated stats for dashboard
router.get("/reports/stats", async (_req: Request, res: Response) => {
  const db = getDb();

  const [clients, posts, tasks, materials] = await Promise.all([
    db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE active) as active FROM clients"),
    db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending_approval') as pending,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'published') as published,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected
      FROM posts
    `),
    db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'queued') as queued,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM tasks
    `),
    db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE used) as used,
        COUNT(*) FILTER (WHERE NOT used) as unused
      FROM materials
    `),
  ]);

  res.json({
    ok: true,
    data: {
      clients: clients.rows[0],
      posts: posts.rows[0],
      tasks: tasks.rows[0],
      materials: materials.rows[0],
    },
  });
});

// ─── Creative Workflow E2E ───
import { createCreativeWorkflowRun } from "../modules/creative-workflows/creative-workflow.service";

router.post("/creative-workflows", async (req, res) => {
  const { clientId, accountId, deviceId, objective, dryRun } = req.body || {};
  const result = await createCreativeWorkflowRun({ clientId, accountId, deviceId, objective, dryRun: dryRun ?? false });
  const status = result.status === "queued"
    ? 201
    : result.code === "CREATIVE_WORKFLOW_MISSING_FIELDS"
      ? 400
      : result.status === "not_ready"
        ? 409
        : 200;
  res.status(status).json({ ok: result.status !== "not_ready", code: result.code, data: result });
});

export default router;
