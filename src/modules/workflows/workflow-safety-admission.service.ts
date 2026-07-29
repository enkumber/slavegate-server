import { createHash } from "node:crypto";
import { getDb } from "../../db/client";
import type { WorkflowStep, WorkflowTemplate } from "./types";

const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const TEMPLATE_TOKEN_RE = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;

interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface SafetyLimit {
  windowMs: number;
  maxRuns?: number;
  maxUnits?: number;
}

export interface WorkflowSafetyPolicy {
  version: string;
  requiresAdmissionLedger: boolean;
  requireExplicitEffects: boolean;
  scopeTemplate: string;
  unitCost: number;
  allowedEffects: string[];
  requiredGoalStages: string[];
  requirePostcondition: boolean;
  approval: {
    required: boolean;
    granted: boolean;
    grantId?: string;
    expiresAt?: string;
  };
  limits: SafetyLimit[];
}

export interface WorkflowSafetyAdmissionContext {
  clientId?: string | null;
  accountId?: string | null;
  deviceId?: string | null;
  campaignId?: string | null;
  intent?: string | null;
  source?: string | null;
}

export interface WorkflowSafetyAdmission {
  id: string | null;
  safetyClass: string;
  policyVersion: string;
  scopeKey: string;
  idempotencyKey: string;
  consumedUnits: number;
  replayed: boolean;
}

function failure(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !IDENTIFIER_RE.test(item))) {
    return null;
  }
  return value as string[];
}

function parsePolicy(payload: unknown): WorkflowSafetyPolicy {
  if (!isRecord(payload)) {
    throw failure("WORKFLOW_SAFETY_POLICY_INVALID", "workflow safety policy payload is invalid", 503);
  }
  const approval = payload.approval;
  const allowedEffects = stringArray(payload.allowedEffects);
  const requiredGoalStages = stringArray(payload.requiredGoalStages);
  const limits = payload.limits;
  if (
    typeof payload.version !== "string"
    || !IDENTIFIER_RE.test(payload.version)
    || typeof payload.requiresAdmissionLedger !== "boolean"
    || typeof payload.requireExplicitEffects !== "boolean"
    || typeof payload.scopeTemplate !== "string"
    || !payload.scopeTemplate.trim()
    || !positiveNumber(payload.unitCost)
    || !allowedEffects
    || !requiredGoalStages
    || typeof payload.requirePostcondition !== "boolean"
    || !isRecord(approval)
    || typeof approval.required !== "boolean"
    || typeof approval.granted !== "boolean"
    || !Array.isArray(limits)
  ) {
    throw failure("WORKFLOW_SAFETY_POLICY_INVALID", "workflow safety policy contract is invalid", 503);
  }
  const parsedLimits = limits.map((raw) => {
    if (!isRecord(raw) || !positiveInteger(raw.windowMs)) {
      throw failure("WORKFLOW_SAFETY_POLICY_INVALID", "workflow safety limit window is invalid", 503);
    }
    const maxRuns = raw.maxRuns;
    const maxUnits = raw.maxUnits;
    if (
      (maxRuns !== undefined && !positiveInteger(maxRuns))
      || (maxUnits !== undefined && !positiveNumber(maxUnits))
      || (maxRuns === undefined && maxUnits === undefined)
    ) {
      throw failure("WORKFLOW_SAFETY_POLICY_INVALID", "workflow safety limit is invalid", 503);
    }
    return {
      windowMs: raw.windowMs,
      ...(maxRuns !== undefined ? { maxRuns } : {}),
      ...(maxUnits !== undefined ? { maxUnits } : {}),
    } as SafetyLimit;
  });
  const expiresAt = approval.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))) {
    throw failure("WORKFLOW_SAFETY_POLICY_INVALID", "workflow safety approval expiry is invalid", 503);
  }
  if (
    approval.grantId !== undefined
    && (typeof approval.grantId !== "string" || !IDENTIFIER_RE.test(approval.grantId))
  ) {
    throw failure("WORKFLOW_SAFETY_POLICY_INVALID", "workflow safety approval grant id is invalid", 503);
  }
  return {
    version: payload.version,
    requiresAdmissionLedger: payload.requiresAdmissionLedger,
    requireExplicitEffects: payload.requireExplicitEffects,
    scopeTemplate: payload.scopeTemplate,
    unitCost: payload.unitCost,
    allowedEffects,
    requiredGoalStages,
    requirePostcondition: payload.requirePostcondition,
    approval: {
      required: approval.required,
      granted: approval.granted,
      ...(typeof approval.grantId === "string" ? { grantId: approval.grantId } : {}),
      ...(typeof expiresAt === "string" ? { expiresAt } : {}),
    },
    limits: parsedLimits,
  };
}

export async function loadWorkflowSafetyPolicy(
  safetyClass: string,
  db: Queryable = getDb(),
): Promise<WorkflowSafetyPolicy> {
  if (!IDENTIFIER_RE.test(safetyClass)) {
    throw failure("WORKFLOW_SAFETY_CLASS_INVALID", "workflow safety class is invalid");
  }
  const result = await db.query<{ payload: unknown }>(
    `SELECT entry.payload
       FROM runtime_semantic_entries entry
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table = to_regclass('runtime_semantic_entries')
        AND binding.lifecycle_key = entry.lifecycle_key
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE entry.namespace = 'workflow_safety_policy'
        AND entry.entry_key = $1
        AND definition.dispatchable
      ORDER BY entry.priority DESC
      LIMIT 1`,
    [safetyClass],
  );
  if (!result.rows[0]) {
    throw failure(
      "WORKFLOW_SAFETY_POLICY_REQUIRED",
      "workflow safety class has no active PostgreSQL policy",
      503,
    );
  }
  return parsePolicy(result.rows[0].payload);
}

function collectActions(steps: WorkflowStep[]): Array<Extract<WorkflowStep, { type: "action" }>> {
  const actions: Array<Extract<WorkflowStep, { type: "action" }>> = [];
  const visit = (items: WorkflowStep[]): void => {
    for (const step of items) {
      if (step.type === "action") {
        actions.push(step);
        if (Array.isArray(step.onFailureSteps)) visit(step.onFailureSteps);
      } else if (step.type === "condition") {
        visit(step.if_true);
        if (step.if_false) visit(step.if_false);
      } else if (step.type === "loop") {
        visit(step.steps);
      }
    }
  };
  visit(steps);
  return actions;
}

export function assertWorkflowMatchesSafetyPolicy(
  workflow: WorkflowTemplate,
  policy: WorkflowSafetyPolicy,
): void {
  const actions = collectActions(workflow.steps);
  const effects = new Set(actions.map((action) => action.effect).filter((effect): effect is string => !!effect));
  if (policy.requireExplicitEffects && actions.some((action) => !action.effect)) {
    throw failure("WORKFLOW_SAFETY_EFFECT_REQUIRED", "every workflow action must declare an effect");
  }
  for (const effect of effects) {
    if (!policy.allowedEffects.includes(effect)) {
      throw failure("WORKFLOW_SAFETY_EFFECT_DENIED", `workflow effect "${effect}" is not allowed`);
    }
  }
  const stages = new Set(workflow.goalContract?.stages.map((stage) => stage.id) ?? []);
  for (const required of policy.requiredGoalStages) {
    if (!stages.has(required)) {
      throw failure("WORKFLOW_SAFETY_STAGE_REQUIRED", `workflow safety stage "${required}" is missing`);
    }
  }
  if (policy.requirePostcondition && !workflow.postconditionContract) {
    throw failure("WORKFLOW_SAFETY_POSTCONDITION_REQUIRED", "workflow safety policy requires a postcondition");
  }
}

function contextValue(context: WorkflowSafetyAdmissionContext, path: string): string {
  const value = path.split(".").reduce<unknown>((current, key) => (
    isRecord(current) ? current[key] : undefined
  ), context as unknown);
  if (typeof value !== "string" || !value.trim()) {
    throw failure("WORKFLOW_SAFETY_SCOPE_UNBOUND", `workflow safety scope token "${path}" is unbound`);
  }
  return value;
}

function renderScope(template: string, context: WorkflowSafetyAdmissionContext): string {
  const used = new Set<string>();
  const rendered = template.replace(TEMPLATE_TOKEN_RE, (_match, path: string) => {
    used.add(path);
    return contextValue(context, path);
  });
  if (used.size === 0 || rendered.includes("{{") || !rendered.trim()) {
    throw failure("WORKFLOW_SAFETY_SCOPE_INVALID", "workflow safety scope template is invalid", 503);
  }
  return rendered;
}

function workflowFingerprint(workflow: WorkflowTemplate): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

function assertApproval(policy: WorkflowSafetyPolicy): void {
  if (!policy.approval.required) return;
  if (!policy.approval.granted || !policy.approval.grantId) {
    throw failure("WORKFLOW_SAFETY_APPROVAL_REQUIRED", "workflow safety policy has no active approval grant");
  }
  if (policy.approval.expiresAt && Date.parse(policy.approval.expiresAt) <= Date.now()) {
    throw failure("WORKFLOW_SAFETY_APPROVAL_EXPIRED", "workflow safety approval grant has expired");
  }
}

export async function reserveWorkflowSafetyAdmission(input: {
  db: Queryable;
  safetyClass: string;
  workflow: WorkflowTemplate;
  context: WorkflowSafetyAdmissionContext;
  idempotencyKey?: string | null;
}): Promise<WorkflowSafetyAdmission> {
  const policy = await loadWorkflowSafetyPolicy(input.safetyClass, input.db);
  assertWorkflowMatchesSafetyPolicy(input.workflow, policy);
  const scopeKey = renderScope(policy.scopeTemplate, input.context);
  const idempotencyKey = input.idempotencyKey ?? "not_applicable";
  if (!policy.requiresAdmissionLedger) {
    return {
      id: null,
      safetyClass: input.safetyClass,
      policyVersion: policy.version,
      scopeKey,
      idempotencyKey,
      consumedUnits: 0,
      replayed: false,
    };
  }
  if (!input.idempotencyKey || !IDENTIFIER_RE.test(input.idempotencyKey)) {
    throw failure("WORKFLOW_IDEMPOTENCY_KEY_REQUIRED", "workflow requires a valid idempotency key", 400);
  }
  assertApproval(policy);
  await input.db.query(
    `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
    [input.safetyClass, scopeKey],
  );
  const replay = await input.db.query<{
    id: string;
    consumed_units: string | number;
  }>(
    `SELECT id, consumed_units
       FROM workflow_safety_admission_ledger
      WHERE safety_class = $1
        AND scope_key = $2
        AND idempotency_key = $3`,
    [input.safetyClass, scopeKey, input.idempotencyKey],
  );
  if (replay.rows[0]) {
    return {
      id: replay.rows[0].id,
      safetyClass: input.safetyClass,
      policyVersion: policy.version,
      scopeKey,
      idempotencyKey: input.idempotencyKey,
      consumedUnits: Number(replay.rows[0].consumed_units),
      replayed: true,
    };
  }
  for (const limit of policy.limits) {
    const usage = await input.db.query<{ runs: string; units: string }>(
      `SELECT COUNT(*)::text AS runs, COALESCE(SUM(consumed_units), 0)::text AS units
         FROM workflow_safety_admission_ledger
        WHERE safety_class = $1
          AND scope_key = $2
          AND created_at >= NOW() - ($3::bigint * INTERVAL '1 millisecond')`,
      [input.safetyClass, scopeKey, limit.windowMs],
    );
    const runs = Number(usage.rows[0]?.runs ?? 0);
    const units = Number(usage.rows[0]?.units ?? 0);
    if (limit.maxRuns !== undefined && runs >= limit.maxRuns) {
      throw failure("WORKFLOW_SAFETY_RATE_LIMITED", "workflow safety run limit is exhausted", 429);
    }
    if (limit.maxUnits !== undefined && units + policy.unitCost > limit.maxUnits) {
      throw failure("WORKFLOW_SAFETY_BUDGET_EXHAUSTED", "workflow safety unit budget is exhausted", 429);
    }
  }
  const inserted = await input.db.query<{ id: string }>(
    `INSERT INTO workflow_safety_admission_ledger
       (safety_class, policy_version, scope_key, idempotency_key, consumed_units, context)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.safetyClass,
      policy.version,
      scopeKey,
      input.idempotencyKey,
      policy.unitCost,
      JSON.stringify({
        ...input.context,
        workflowFingerprint: workflowFingerprint(input.workflow),
      }),
    ],
  );
  return {
    id: inserted.rows[0].id,
    safetyClass: input.safetyClass,
    policyVersion: policy.version,
    scopeKey,
    idempotencyKey: input.idempotencyKey,
    consumedUnits: policy.unitCost,
    replayed: false,
  };
}

export async function assertWorkflowSafetyDispatch(input: {
  workflow: WorkflowTemplate;
  safetyAdmissionId?: string | null;
  context?: WorkflowSafetyAdmissionContext;
}): Promise<void> {
  const safetyClass = input.workflow.safetyClass;
  if (typeof safetyClass !== "string" || !IDENTIFIER_RE.test(safetyClass)) {
    throw failure("WORKFLOW_SAFETY_CLASS_REQUIRED", "workflow has no valid explicit safety class");
  }
  const db = getDb();
  const policy = await loadWorkflowSafetyPolicy(safetyClass, db);
  assertWorkflowMatchesSafetyPolicy(input.workflow, policy);
  if (!policy.requiresAdmissionLedger) return;
  assertApproval(policy);
  if (!input.safetyAdmissionId) {
    throw failure("WORKFLOW_SAFETY_ADMISSION_REQUIRED", "workflow requires a safety admission receipt");
  }
  const receipt = await db.query<{ id: string }>(
    `SELECT id
       FROM workflow_safety_admission_ledger
      WHERE id = $1
        AND safety_class = $2
        AND policy_version = $3
        AND context ->> 'workflowFingerprint' = $4
        AND (context ->> 'deviceId') IS NOT DISTINCT FROM $5
        AND (context ->> 'accountId') IS NOT DISTINCT FROM $6
        AND (context ->> 'clientId') IS NOT DISTINCT FROM $7`,
    [
      input.safetyAdmissionId,
      safetyClass,
      policy.version,
      workflowFingerprint(input.workflow),
      input.context?.deviceId ?? null,
      input.context?.accountId ?? null,
      input.context?.clientId ?? null,
    ],
  );
  if (!receipt.rows[0]) {
    throw failure("WORKFLOW_SAFETY_ADMISSION_INVALID", "workflow safety admission receipt is invalid");
  }
}
