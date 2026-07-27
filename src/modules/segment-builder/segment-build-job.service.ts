import crypto from "crypto";
import type { PoolClient } from "pg";
import { getDb } from "../../db/client";
import { workflowSegmentControlPlaneService } from "../workflow-segments/control-plane.service";
import { transitionWorkflowExecutionBinding } from "../workflow-segments/execution-lifecycle.service";
import type {
  SegmentInputResolver,
  SegmentInputSchema,
  WorkflowCompositionExecutionPolicy,
  WorkflowCompositionNodeRecord,
} from "../workflow-segments/types";
import type { WorkflowTemplate } from "../workflows/types";
import { transitionTask } from "../task-lifecycle/task-lifecycle.service";
import { transitionWorkflow } from "../workflows/workflow-lifecycle.service";
import { transitionAgencyWorkflowRun } from "../workflows/agency-workflow-run-lifecycle.service";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";

export type SegmentBuildReason =
  | "capability_missing"
  | "composition_missing"
  | "segment_missing";

export const SEGMENT_BUILDER_AGENT_ID = "segment-builder";
const SEGMENT_BUILDER_SWEEP_LIMIT = 25;
const OFFLINE_QUEUED_CANARY_TIMEOUT_MS = 5 * 60_000;
const RECOVERY_REDISPATCH_GUARD_MS = 10 * 60_000;

export interface SegmentBuildJob {
  id: string;
  requestKey: string;
  idempotencyKey: string;
  deviceId: string;
  accountId: string | null;
  intent: string;
  platform: string;
  capabilityKey: string | null;
  reason: SegmentBuildReason;
  status: string;
  assignedAgent: string;
  agentSessionKey: string | null;
  dispatchAttempts: number;
  lastDispatchError: string | null;
  claimExpiresAt: string | null;
  candidate: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SegmentCandidate {
  segmentKey: string;
  version: string;
  platform: string;
  description?: string;
  template: WorkflowTemplate;
  inputSchema: SegmentInputSchema;
  outputSchema?: WorkflowTemplate["outputSchema"];
  postconditionContract?: WorkflowTemplate["postconditionContract"];
  compatibility?: Record<string, unknown>;
}

interface CompositionCandidate {
  compositionName: string;
  version: string;
  capabilityKey: string;
  platform: string;
  inputSchema: SegmentInputSchema;
  outputSchema: NonNullable<WorkflowTemplate["outputSchema"]>;
  inputResolver: SegmentInputResolver;
  postconditionContract: NonNullable<WorkflowTemplate["postconditionContract"]>;
  executionPolicy: WorkflowCompositionExecutionPolicy;
  compatibility?: Record<string, unknown>;
  nodes: WorkflowCompositionNodeRecord[];
}

interface AgentCandidate {
  capability: {
    capabilityKey: string;
    platform: string;
    description?: string;
    aliases?: string[];
    requiredTerms?: string[];
    forbiddenTerms?: string[];
    safetyClass: string;
    portabilityScope?: string;
    metadata?: Record<string, unknown>;
  };
  segments: SegmentCandidate[];
  composition: CompositionCandidate;
  evidencePlan?: Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertAgentCandidate(value: Record<string, unknown>): AgentCandidate {
  const capability = objectValue(value.capability);
  const composition = objectValue(value.composition);
  if (
    typeof capability.capabilityKey !== "string"
    || typeof capability.platform !== "string"
    || !["read_only", "navigation"].includes(String(capability.safetyClass))
    || !Array.isArray(value.segments)
    || typeof composition.compositionName !== "string"
    || typeof composition.version !== "string"
    || typeof composition.capabilityKey !== "string"
    || composition.capabilityKey !== capability.capabilityKey
  ) {
    throw Object.assign(new Error("segment-builder candidate contract is invalid"), {
      status: 422,
      code: "SEGMENT_BUILDER_CANDIDATE_INVALID",
    });
  }
  return value as unknown as AgentCandidate;
}

function dbTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToJob(row: Record<string, unknown>): SegmentBuildJob {
  return {
    id: row.id as string,
    requestKey: row.request_key as string,
    idempotencyKey: row.idempotency_key as string,
    deviceId: row.device_id as string,
    accountId: (row.account_id as string | null) ?? null,
    intent: row.intent as string,
    platform: row.platform as string,
    capabilityKey: (row.capability_key as string | null) ?? null,
    reason: row.reason as SegmentBuildReason,
    status: String(row.status),
    assignedAgent: row.assigned_agent as string,
    agentSessionKey: (row.agent_session_key as string | null) ?? null,
    dispatchAttempts: Number(row.dispatch_attempts ?? 0),
    lastDispatchError: (row.last_dispatch_error as string | null) ?? null,
    claimExpiresAt: dbTimestamp(row.claim_expires_at),
    candidate: (row.candidate as Record<string, unknown> | null) ?? null,
    evidence: (row.evidence as Record<string, unknown> | null) ?? {},
    result: (row.result as Record<string, unknown> | null) ?? {},
    error: (row.error as string | null) ?? null,
    createdAt: dbTimestamp(row.created_at) ?? "",
    updatedAt: dbTimestamp(row.updated_at) ?? "",
  };
}

async function event(jobId: string, eventType: string, actor: string, payload: Record<string, unknown> = {}): Promise<void> {
  await getDb().query(
    `INSERT INTO segment_build_job_events(job_id, event_type, actor, payload)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [jobId, eventType, actor, JSON.stringify(payload)],
  );
}

async function resourceVersionIsSuccessful(
  table: string,
  keyColumn: string,
  key: string,
  version: string,
): Promise<boolean> {
  const result = await getDb().query(
    `SELECT definition.terminal
            AND NOT definition.retryable
            AND NOT definition.administrative AS successful
       FROM ${table} resource
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table = to_regclass($3)
        AND binding.lifecycle_key = resource.lifecycle_key
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = resource.lifecycle_key
        AND definition.status = resource.lifecycle_status
      WHERE resource.${keyColumn} = $1
        AND resource.version = $2`,
    [key, version, table],
  );
  return result.rows[0]?.successful === true;
}

async function activateCapability(capabilityKey: string): Promise<void> {
  const selector = serializeLifecycleTransitionSelector({
    targetDispatchable: true,
    targetAdministrative: false,
    transitionAutomatic: true,
  });
  const predicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  await getDb().query(
    `WITH selected AS (
       SELECT capability.capability_key, current.dispatchable AS current_dispatchable,
              transition.to_status
         FROM workflow_capabilities capability
         JOIN lifecycle_state_definitions current
           ON current.lifecycle_key = capability.lifecycle_key
          AND current.status = capability.status
         LEFT JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = capability.lifecycle_key
          AND transition.from_status = capability.status
         LEFT JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
          AND ${predicate}
        WHERE capability.capability_key = $1
        ORDER BY transition.action_key
        LIMIT 1
        FOR UPDATE OF capability
     )
     UPDATE workflow_capabilities capability
        SET status = CASE
              WHEN selected.current_dispatchable THEN capability.status
              ELSE selected.to_status
            END,
            metadata = (capability.metadata - 'buildJobId')
              || jsonb_build_object('managedBy', 'segment-builder'),
            updated_at = NOW()
       FROM selected
      WHERE capability.capability_key = selected.capability_key
        AND (selected.current_dispatchable OR selected.to_status IS NOT NULL)`,
    [capabilityKey, selector],
  );
}

interface SegmentBuildTransitionPatch {
  assignedAgent?: string;
  agentSessionKey?: string;
  incrementDispatchAttempts?: boolean;
  lastDispatchError?: string | null;
  refreshLease?: boolean;
  candidate?: Record<string, unknown>;
  resultPatch?: Record<string, unknown>;
  evidencePatch?: Record<string, unknown>;
  error?: string | null;
}

async function transitionSegmentBuildJob(
  id: string,
  selector: LifecycleTransitionSelector,
  patch: SegmentBuildTransitionPatch = {},
  extraPredicate = "TRUE",
  extraParams: unknown[] = [],
  client?: PoolClient,
): Promise<SegmentBuildJob | null> {
  const patchIndex = extraParams.length + 2;
  const selectorIndex = extraParams.length + 3;
  const selectorPredicate = lifecycleTransitionSelectorPredicate(
    "transition",
    "target",
    `$${selectorIndex}`,
  );
  const result = await (client ?? getDb()).query(
    `WITH locked AS (
       SELECT job.*
         FROM segment_build_jobs job
        WHERE job.id = $1
          AND (${extraPredicate})
        FOR UPDATE
     ),
     candidates AS (
       SELECT DISTINCT job.id, transition.to_status, transition.mark_started,
              transition.mark_completed, transition.clear_completed,
              transition.clear_failure, transition.reset_retry
         FROM locked job
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = job.lifecycle_key
          AND transition.from_status = job.status
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
        WHERE ${selectorPredicate}
     ),
     selected AS (
       SELECT ranked.*
         FROM (
           SELECT candidates.*, COUNT(*) OVER (PARTITION BY id) AS candidate_count
             FROM candidates
         ) ranked
        WHERE ranked.candidate_count = 1
     )
     UPDATE segment_build_jobs job
        SET status = selected.to_status,
            assigned_agent = CASE
              WHEN $${patchIndex}::jsonb ? 'assignedAgent'
                THEN $${patchIndex}::jsonb->>'assignedAgent'
              ELSE job.assigned_agent
            END,
            agent_session_key = CASE
              WHEN $${patchIndex}::jsonb ? 'agentSessionKey'
                THEN $${patchIndex}::jsonb->>'agentSessionKey'
              ELSE job.agent_session_key
            END,
            dispatch_attempts = CASE
              WHEN COALESCE(($${patchIndex}::jsonb->>'incrementDispatchAttempts')::boolean, false)
                THEN job.dispatch_attempts + 1
              WHEN selected.reset_retry THEN 0
              ELSE job.dispatch_attempts
            END,
            last_dispatch_error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $${patchIndex}::jsonb ? 'lastDispatchError'
                THEN $${patchIndex}::jsonb->>'lastDispatchError'
              ELSE job.last_dispatch_error
            END,
            dispatched_at = CASE
              WHEN COALESCE(($${patchIndex}::jsonb->>'incrementDispatchAttempts')::boolean, false)
                THEN NOW()
              ELSE job.dispatched_at
            END,
            claimed_at = CASE
              WHEN selected.mark_started THEN COALESCE(job.claimed_at, NOW())
              ELSE job.claimed_at
            END,
            claim_expires_at = CASE
              WHEN COALESCE(($${patchIndex}::jsonb->>'refreshLease')::boolean, false)
                THEN NOW() + INTERVAL '10 minutes'
              WHEN selected.mark_completed THEN NULL
              ELSE job.claim_expires_at
            END,
            candidate = CASE
              WHEN $${patchIndex}::jsonb ? 'candidate'
                THEN $${patchIndex}::jsonb->'candidate'
              ELSE job.candidate
            END,
            result = CASE
              WHEN $${patchIndex}::jsonb ? 'resultPatch'
                THEN job.result || $${patchIndex}::jsonb->'resultPatch'
              ELSE job.result
            END,
            evidence = CASE
              WHEN $${patchIndex}::jsonb ? 'evidencePatch'
                THEN job.evidence || $${patchIndex}::jsonb->'evidencePatch'
              ELSE job.evidence
            END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $${patchIndex}::jsonb ? 'error' THEN $${patchIndex}::jsonb->>'error'
              ELSE job.error
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE job.completed_at
            END,
            updated_at = NOW()
       FROM selected
      WHERE job.id = selected.id
      RETURNING job.*`,
    [
      id,
      ...extraParams,
      JSON.stringify(patch),
      serializeLifecycleTransitionSelector(selector),
    ],
  );
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

function hookToken(): string {
  const configuredToken = process.env.OPENCLAW_SEGMENT_BUILDER_HOOK_TOKEN?.trim();
  const apiKey = process.env.API_KEY?.trim();
  const token = configuredToken || (apiKey
    ? crypto.createHmac("sha256", apiKey).update("openclaw-segment-builder-hook-v1").digest("hex")
    : "");
  if (!token) {
    throw Object.assign(new Error("OpenClaw segment-builder hook is not configured"), {
      code: "SEGMENT_BUILDER_HOOK_NOT_CONFIGURED",
    });
  }
  return token;
}

export function segmentBuilderAgentToken(): string {
  const apiKey = process.env.API_KEY?.trim();
  if (!apiKey) {
    throw new Error("API_KEY is required for the segment-builder agent token");
  }
  return crypto
    .createHmac("sha256", apiKey)
    .update("phone-network-openclaw-agent-v1")
    .digest("hex");
}

export async function ensureSegmentBuilderAgentToken(): Promise<void> {
  const tokenHash = crypto.createHash("sha256").update(segmentBuilderAgentToken()).digest("hex");
  await getDb().query(
    `INSERT INTO api_tokens (token_hash, purpose, expires_at)
     VALUES ($1, 'openclaw_agent', NOW() + INTERVAL '10 years')
     ON CONFLICT (token_hash) DO UPDATE SET
       purpose = 'openclaw_agent',
       expires_at = NOW() + INTERVAL '10 years',
       revoked_at = NULL`,
    [tokenHash],
  );
}

export class SegmentBuildJobService {
  async context(id: string): Promise<Record<string, unknown> | null> {
    const job = await this.get(id);
    if (!job) return null;
    const db = getDb();
    const [device, capabilities, segments, compositions, semantics, lifecycleDefinitions] = await Promise.all([
      db.query(
        `SELECT id, friendly_name AS name, model, android_version, agent_version, status
         FROM devices WHERE id = $1`,
        [job.deviceId],
      ),
      db.query(
        `SELECT capability.capability_key, capability.platform, capability.description,
                capability.aliases, capability.required_terms, capability.forbidden_terms,
                capability.safety_class, capability.portability_scope,
                capability.status, capability.metadata
         FROM workflow_capabilities capability
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('workflow_capabilities')
          AND binding.lifecycle_key = capability.lifecycle_key
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = capability.lifecycle_key
          AND definition.status = capability.status
         WHERE definition.dispatchable
           AND (LOWER(capability.platform) = LOWER($1) OR capability.platform = '*')
         ORDER BY capability.updated_at DESC
         LIMIT 100`,
        [job.platform],
      ),
      db.query(
        `SELECT segment.segment_key, segment.version, segment.platform,
                segment.lifecycle_status, segment.template, segment.input_schema,
                segment.output_schema, segment.postcondition_contract,
                segment.compatibility
         FROM workflow_segment_versions segment
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('workflow_segment_versions')
          AND binding.lifecycle_key = segment.lifecycle_key
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = segment.lifecycle_key
          AND definition.status = segment.lifecycle_status
         WHERE definition.dispatchable
           AND (LOWER(segment.platform) = LOWER($1) OR segment.platform = '*')
         ORDER BY segment.segment_key, segment.updated_at DESC
         LIMIT 200`,
        [job.platform],
      ),
      db.query(
        `SELECT c.composition_name, c.version, c.composition_key, c.capability_key,
                c.platform, c.lifecycle_status, c.input_schema, c.output_schema,
                c.input_resolver, c.postcondition_contract, c.execution_policy,
                COALESCE(jsonb_agg(
                  jsonb_build_object(
                    'nodeKey', n.node_key,
                    'ordinal', n.ordinal,
                    'segmentKey', n.segment_key,
                    'segmentVersion', n.segment_version,
                    'inputBindings', n.input_bindings,
                    'outputBindings', n.output_bindings,
                    'dependsOn', n.depends_on
                  ) ORDER BY n.ordinal
                ) FILTER (WHERE n.node_key IS NOT NULL), '[]'::jsonb) AS nodes
         FROM workflow_compositions c
         LEFT JOIN workflow_composition_nodes n
           ON n.composition_name = c.composition_name
          AND n.composition_version = c.version
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('workflow_compositions')
          AND binding.lifecycle_key = c.lifecycle_key
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = c.lifecycle_key
          AND definition.status = c.lifecycle_status
         WHERE definition.dispatchable
           AND (LOWER(c.platform) = LOWER($1) OR c.platform = '*')
         GROUP BY c.composition_name, c.version
         ORDER BY c.updated_at DESC
         LIMIT 100`,
        [job.platform],
      ),
      db.query(
        `SELECT semantic.namespace, semantic.entry_key, semantic.platform,
                semantic.priority, semantic.payload
         FROM runtime_semantic_entries semantic
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('runtime_semantic_entries')
          AND binding.lifecycle_key = semantic.lifecycle_key
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = semantic.lifecycle_key
          AND definition.status = semantic.status
         WHERE definition.dispatchable
           AND (LOWER(semantic.platform) = LOWER($1) OR semantic.platform = '*')
         ORDER BY semantic.namespace, semantic.priority DESC, semantic.entry_key
         LIMIT 300`,
        [job.platform],
      ),
      db.query(
        `SELECT binding.resource_table::text AS resource_table,
                definition.status, definition.initial, definition.terminal,
                definition.retryable, definition.administrative,
                definition.dispatchable, definition.manual, definition.metadata
           FROM lifecycle_resource_bindings binding
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = binding.lifecycle_key
          WHERE binding.resource_table = ANY(ARRAY[
            to_regclass('workflow_capabilities'),
            to_regclass('workflow_segment_versions'),
            to_regclass('workflow_compositions'),
            to_regclass('runtime_semantic_entries')
          ])
          ORDER BY binding.resource_table::text, definition.sort_order, definition.status`,
      ),
    ]);
    return {
      job,
      device: device.rows[0] ?? null,
      capabilities: capabilities.rows,
      segments: segments.rows,
      compositions: compositions.rows,
      semantics: semantics.rows,
      lifecycleDefinitions: lifecycleDefinitions.rows,
    };
  }

  async registerDispatcher(input: {
    id: string;
    callbackUrl: string;
    registeredIp: string;
  }): Promise<{ id: string; callbackUrl: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const result = await getDb().query(
      `INSERT INTO segment_builder_dispatchers
         (id, callback_url, registered_ip, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         callback_url = EXCLUDED.callback_url,
         registered_ip = EXCLUDED.registered_ip,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()
       RETURNING id, callback_url, expires_at`,
      [input.id, input.callbackUrl, input.registeredIp, expiresAt.toISOString()],
    );
    const row = result.rows[0];
    return {
      id: row.id as string,
      callbackUrl: row.callback_url as string,
      expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    };
  }

  private async dispatcherUrl(): Promise<string> {
    const result = await getDb().query(
      `SELECT callback_url
       FROM segment_builder_dispatchers
       WHERE id = 'openclaw-segment-builder'
         AND expires_at > NOW()
       LIMIT 1`,
    );
    const registered = result.rows[0]?.callback_url;
    if (typeof registered === "string" && registered.length > 0) return registered;

    const configured = process.env.OPENCLAW_SEGMENT_BUILDER_HOOK_URL?.trim();
    if (configured) return configured;
    throw Object.assign(new Error("No fresh OpenClaw segment-builder dispatcher is registered"), {
      code: "SEGMENT_BUILDER_DISPATCHER_UNAVAILABLE",
    });
  }

  async createOrGet(input: {
    requestKey: string;
    deviceId: string;
    accountId: string | null;
    intent: string;
    platform: string;
    capabilityKey?: string | null;
    reason: SegmentBuildReason;
  }): Promise<SegmentBuildJob> {
    const idempotencyKey = `segment-build:${input.requestKey}`;
    const result = await getDb().query(
      `INSERT INTO segment_build_jobs
         (request_key, idempotency_key, device_id, account_id, intent, platform, capability_key, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [
        input.requestKey,
        idempotencyKey,
        input.deviceId,
        input.accountId,
        input.intent,
        input.platform,
        input.capabilityKey ?? null,
        input.reason,
      ],
    );
    const job = rowToJob(result.rows[0]);
    await event(job.id, "created_or_reused", "phone-network", { reason: job.reason });
    return job;
  }

  async get(id: string): Promise<SegmentBuildJob | null> {
    const result = await getDb().query("SELECT * FROM segment_build_jobs WHERE id = $1", [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async isSuccessful(job: Pick<SegmentBuildJob, "id">): Promise<boolean> {
    const result = await getDb().query(
      `SELECT definition.terminal, definition.retryable, definition.administrative
         FROM segment_build_jobs build_job
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = build_job.lifecycle_key
          AND definition.status = build_job.status
        WHERE build_job.id = $1`,
      [job.id],
    );
    const state = result.rows[0];
    return state?.terminal === true
      && state.retryable === false
      && state.administrative === false;
  }

  async dispatch(job: SegmentBuildJob): Promise<SegmentBuildJob> {
    const state = await getDb().query(
      `SELECT definition.initial, definition.terminal, definition.retryable,
              definition.dispatchable
         FROM segment_build_jobs job
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = job.lifecycle_key
          AND definition.status = job.status
        WHERE job.id = $1`,
      [job.id],
    );
    const definition = state.rows[0] as Record<string, unknown> | undefined;
    const normalDispatch = definition?.dispatchable === true
      && (definition.initial === true || definition.retryable === true);
    const expiredLeaseRecovery = definition?.terminal === false
      && typeof job.claimExpiresAt === "string"
      && Date.parse(job.claimExpiresAt) < Date.now();
    if (!normalDispatch && !expiredLeaseRecovery) return job;
    const url = await this.dispatcherUrl();
    const token = hookToken();
    const sessionKey = `hook:phone-network:${job.id}`;
    const reserved = expiredLeaseRecovery
      ? await getDb().query(
        `UPDATE segment_build_jobs job
         SET agent_session_key = $2,
             dispatch_attempts = dispatch_attempts + 1,
             last_dispatch_error = NULL,
             dispatched_at = NOW(),
             updated_at = NOW()
         FROM lifecycle_state_definitions definition
         WHERE job.id = $1
           AND definition.lifecycle_key = job.lifecycle_key
           AND definition.status = job.status
           AND NOT definition.terminal
           AND claim_expires_at < NOW()
           AND (
             dispatched_at IS NULL
             OR dispatched_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
           )
         RETURNING *`,
        [job.id, sessionKey, RECOVERY_REDISPATCH_GUARD_MS],
      )
      : null;
    const transitioned = expiredLeaseRecovery
      ? (reserved?.rows[0] ? rowToJob(reserved.rows[0]) : null)
      : await transitionSegmentBuildJob(job.id, {
        targetTerminal: false,
        transitionAutomatic: true,
        transitionClearFailure: true,
      }, {
        agentSessionKey: sessionKey,
        incrementDispatchAttempts: true,
      });
    if (!transitioned) return (await this.get(job.id)) ?? job;
    await event(
      job.id,
      expiredLeaseRecovery ? "recovery_dispatch_started" : "dispatch_started",
      "phone-network",
      { sessionKey, previousStatus: job.status },
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobId: job.id,
          deviceId: job.deviceId,
          missingSegment: job.capabilityKey,
          reason: job.reason,
          idempotencyKey: job.idempotencyKey,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`OpenClaw hook returned HTTP ${response.status}`);
      }
      await event(
        job.id,
        expiredLeaseRecovery ? "recovery_dispatched" : "dispatched",
        "phone-network",
        { sessionKey, previousStatus: job.status },
      );
      return (await this.get(job.id)) ?? transitioned;
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await transitionSegmentBuildJob(job.id, {
        targetInitial: true,
        transitionAutomatic: true,
      }, {
        lastDispatchError: message,
      });
      await event(job.id, "dispatch_failed", "phone-network", { error: message });
      throw Object.assign(new Error(message), { code: "SEGMENT_BUILDER_DISPATCH_FAILED" });
    }
  }

  dispatchInBackground(job: SegmentBuildJob): void {
    setImmediate(() => {
      this.dispatch(job).catch((error) => {
        console.error(`[segment-builder] dispatch ${job.id} failed: ${(error as Error).message}`);
      });
    });
  }

  async sweepExpiredAgentLeases(limit = SEGMENT_BUILDER_SWEEP_LIMIT): Promise<number> {
    const result = await getDb().query(
      `SELECT *
       FROM segment_build_jobs job
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = job.lifecycle_key
        AND definition.status = job.status
       WHERE NOT definition.terminal
         AND claim_expires_at < NOW()
       ORDER BY claim_expires_at ASC
       LIMIT $1`,
      [Math.max(1, Math.min(limit, SEGMENT_BUILDER_SWEEP_LIMIT))],
    );
    let redispatched = 0;
    for (const row of result.rows) {
      const before = rowToJob(row);
      const after = await this.dispatch(before);
      if (after.dispatchAttempts > before.dispatchAttempts) redispatched += 1;
    }
    return redispatched;
  }

  async expireOfflineQueuedCanaries(
    timeoutMs = OFFLINE_QUEUED_CANARY_TIMEOUT_MS,
    limit = SEGMENT_BUILDER_SWEEP_LIMIT,
  ): Promise<number> {
    const candidates = await getDb().query(
      `SELECT j.id
       FROM segment_build_jobs j
       JOIN lifecycle_state_definitions j_state
         ON j_state.lifecycle_key = j.lifecycle_key
        AND j_state.status = j.status
       JOIN agency_workflow_runs r
         ON r.id::text = j.result ->> 'canaryRunId'
       JOIN lifecycle_state_definitions r_state
         ON r_state.lifecycle_key = r.lifecycle_key
        AND r_state.status = r.status
       JOIN devices d ON d.id = j.device_id
       JOIN lifecycle_resource_bindings d_binding
         ON d_binding.resource_table = to_regclass('devices')
       JOIN lifecycle_state_definitions d_state
         ON d_state.lifecycle_key = d_binding.lifecycle_key
        AND d_state.status = d.status
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN lifecycle_state_definitions t_state
         ON t_state.lifecycle_key = t.lifecycle_key
        AND t_state.status = t.status
       WHERE NOT j_state.terminal
         AND r_state.initial
         AND r.created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
         AND NOT d_state.dispatchable
         AND (t.id IS NULL OR t_state.initial)
       ORDER BY r.created_at ASC
       LIMIT $2`,
      [
        Math.max(1_000, timeoutMs),
        Math.max(1, Math.min(limit, SEGMENT_BUILDER_SWEEP_LIMIT)),
      ],
    );
    let expired = 0;
    for (const candidate of candidates.rows) {
      const db = getDb();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          `SELECT
             j.id,
             j.device_id,
             j.result ->> 'executionKey' AS execution_key,
             execution_binding.request_key AS execution_request_key,
             r.id AS run_id,
             r.task_id,
             r.workflow_id,
             d.status AS device_status,
             r_state.initial AS run_initial,
             d_state.dispatchable AS device_dispatchable
           FROM segment_build_jobs j
           JOIN lifecycle_state_definitions j_state
             ON j_state.lifecycle_key = j.lifecycle_key
            AND j_state.status = j.status
           JOIN agency_workflow_runs r
             ON r.id::text = j.result ->> 'canaryRunId'
           JOIN lifecycle_state_definitions r_state
             ON r_state.lifecycle_key = r.lifecycle_key
            AND r_state.status = r.status
           JOIN devices d ON d.id = j.device_id
           LEFT JOIN workflow_execution_bindings execution_binding
             ON execution_binding.execution_key = j.result ->> 'executionKey'
           JOIN lifecycle_resource_bindings d_binding
             ON d_binding.resource_table = to_regclass('devices')
           JOIN lifecycle_state_definitions d_state
             ON d_state.lifecycle_key = d_binding.lifecycle_key
            AND d_state.status = d.status
           WHERE j.id = $1
             AND NOT j_state.terminal
           FOR UPDATE OF j, r`,
          [candidate.id],
        );
        const row = locked.rows[0] as Record<string, unknown> | undefined;
        if (
          !row
          || row.run_initial !== true
          || row.device_dispatchable === true
        ) {
          await client.query("ROLLBACK");
          continue;
        }
        const taskId = typeof row.task_id === "string" ? row.task_id : null;
        if (taskId) {
          const task = await client.query(
            `SELECT definition.initial
               FROM tasks task
               JOIN lifecycle_state_definitions definition
                 ON definition.lifecycle_key = task.lifecycle_key
                AND definition.status = task.status
              WHERE task.id = $1
              FOR UPDATE OF task`,
            [taskId],
          );
          if (task.rows[0]?.initial !== true) {
            await client.query("ROLLBACK");
            continue;
          }
        }
        const runId = String(row.run_id);
        const executionKey = typeof row.execution_key === "string" ? row.execution_key : null;
        const reason = `Segment Builder canary expired while device ${String(row.device_status)} before execution`;
        if (taskId) {
          await transitionTask(taskId, {
            targetTerminal: true,
            targetRetryable: true,
            targetAdministrative: false,
            transitionMarkCompleted: true,
            transitionClearFailure: false,
          }, { error: reason }, client);
        }
        const workflowId = typeof row.workflow_id === "string" ? row.workflow_id : null;
        if (workflowId) {
          await transitionWorkflow(workflowId, {
            targetTerminal: true,
            targetRetryable: true,
            targetAdministrative: false,
            transitionMarkCompleted: true,
            transitionClearFailure: false,
          }, { error: reason }, client);
        }
        await transitionAgencyWorkflowRun(runId, {
          targetTerminal: true,
          targetRetryable: true,
          targetAdministrative: false,
          transitionMarkCompleted: true,
          transitionClearFailure: false,
        }, { error: reason }, client);
        if (executionKey) {
          const executionRequestKey = typeof row.execution_request_key === "string"
            ? row.execution_request_key
            : null;
          if (executionRequestKey) {
          await transitionWorkflowExecutionBinding(
            executionRequestKey,
            {
              targetTerminal: true,
              targetRetryable: true,
              targetAdministrative: false,
              transitionAutomatic: true,
            },
            {
              postconditionVerified: false,
              resultEvidence: {
                failureCode: "SEGMENT_BUILD_CANARY_DEVICE_OFFLINE_TIMEOUT",
                runId,
                deviceStatus: String(row.device_status),
              },
            },
            client,
          );
          }
        }
        const build = await transitionSegmentBuildJob(
          String(candidate.id),
          {
            targetTerminal: true,
            targetRetryable: true,
            targetAdministrative: false,
            transitionAutomatic: true,
            transitionMarkCompleted: true,
          },
          {
            error: reason,
            evidencePatch: {
              offlineCanaryTimeout: {
                runId,
                taskId,
                deviceStatus: String(row.device_status),
              },
            },
          },
          "TRUE",
          [],
          client,
        );
        if (!build) {
          await client.query("ROLLBACK");
          continue;
        }
        await client.query(
          `INSERT INTO segment_build_job_events(job_id, event_type, actor, payload)
           VALUES ($1, 'canary_expired_offline', 'phone-network-kernel', $2::jsonb)`,
          [
            candidate.id,
            JSON.stringify({
              runId,
              taskId,
              executionKey,
              deviceStatus: row.device_status,
            }),
          ],
        );
        await client.query("COMMIT");
        expired += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(
          `[segment-builder] offline canary expiry ${String(candidate.id)} failed: ${(error as Error).message}`,
        );
      } finally {
        client.release();
      }
    }
    return expired;
  }

  async sweepRecovery(): Promise<{ expiredCanaries: number; redispatchedLeases: number }> {
    const expiredCanaries = await this.expireOfflineQueuedCanaries();
    const redispatchedLeases = await this.sweepExpiredAgentLeases();
    return { expiredCanaries, redispatchedLeases };
  }

  async claim(id: string, agentId: string): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    let job = await transitionSegmentBuildJob(id, {
      targetTerminal: false,
      transitionExternalAllowed: true,
      transitionMarkStarted: true,
    }, {
      assignedAgent: agentId,
      refreshLease: true,
    });
    if (!job) {
      const recovered = await getDb().query(
        `UPDATE segment_build_jobs job
            SET assigned_agent = $2,
                claimed_at = COALESCE(claimed_at, NOW()),
                claim_expires_at = NOW() + INTERVAL '10 minutes',
                updated_at = NOW()
           FROM lifecycle_state_definitions definition
          WHERE job.id = $1
            AND definition.lifecycle_key = job.lifecycle_key
            AND definition.status = job.status
            AND NOT definition.terminal
            AND job.claim_expires_at < NOW()
          RETURNING job.*`,
        [id, agentId],
      );
      job = recovered.rows[0] ? rowToJob(recovered.rows[0]) : null;
    }
    if (!job) return null;
    await event(id, "claimed", agentId);
    return job;
  }

  async heartbeat(id: string, agentId: string): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const progressed = await transitionSegmentBuildJob(id, {
      targetTerminal: false,
      targetHasAutomaticNonterminalExit: false,
      transitionExternalAllowed: true,
      transitionMarkStarted: false,
    }, {
      refreshLease: true,
    }, "job.assigned_agent = $2", [agentId]);
    if (progressed) return progressed;
    const result = await getDb().query(
      `UPDATE segment_build_jobs job
          SET claim_expires_at = NOW() + INTERVAL '10 minutes',
              updated_at = NOW()
         FROM lifecycle_state_definitions definition
        WHERE job.id = $1
          AND job.assigned_agent = $2
          AND definition.lifecycle_key = job.lifecycle_key
          AND definition.status = job.status
          AND NOT definition.terminal
        RETURNING job.*`,
      [id, agentId],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async submitCandidate(id: string, agentId: string, candidate: Record<string, unknown>): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const parsed = assertAgentCandidate(candidate);
    const canonical = JSON.stringify(candidate);
    const candidateHash = crypto.createHash("sha256").update(canonical).digest("hex");
    const current = await this.get(id);
    if (!current || current.assignedAgent !== agentId) {
      return null;
    }
    const currentDefinition = await getDb().query(
      `SELECT definition.terminal
         FROM segment_build_jobs job
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = job.lifecycle_key
          AND definition.status = job.status
        WHERE job.id = $1`,
      [id],
    );
    if (currentDefinition.rows[0]?.terminal !== false) {
      return null;
    }
    if (parsed.composition.platform.toLowerCase() !== current.platform.toLowerCase()) {
      throw Object.assign(new Error("candidate platform does not match the build job"), {
        status: 422,
        code: "SEGMENT_BUILDER_PLATFORM_MISMATCH",
      });
    }
    if (parsed.capability.platform.toLowerCase() !== current.platform.toLowerCase()) {
      throw Object.assign(new Error("candidate capability platform does not match the build job"), {
        status: 422,
        code: "SEGMENT_BUILDER_PLATFORM_MISMATCH",
      });
    }
    if (
      current.capabilityKey
      && parsed.capability.capabilityKey !== current.capabilityKey
    ) {
      throw Object.assign(new Error("candidate capability does not match the build job"), {
        status: 422,
        code: "SEGMENT_BUILDER_CAPABILITY_MISMATCH",
      });
    }
    for (const segment of parsed.segments) {
      if (
        segment.platform !== "*"
        && segment.platform.toLowerCase() !== current.platform.toLowerCase()
      ) {
        throw Object.assign(new Error("candidate segment platform does not match the build job"), {
          status: 422,
          code: "SEGMENT_BUILDER_PLATFORM_MISMATCH",
        });
      }
    }

    const existingCapability = await getDb().query(
      `SELECT capability_key, status, metadata
       FROM workflow_capabilities
       WHERE capability_key = $1`,
      [parsed.capability.capabilityKey],
    );
    if (current.capabilityKey) {
      if (!existingCapability.rows[0]) {
        throw Object.assign(new Error("build job capability no longer exists"), {
          status: 409,
          code: "SEGMENT_BUILDER_CAPABILITY_MISSING",
        });
      }
    } else if (!existingCapability.rows[0]) {
      await getDb().query(
        `INSERT INTO workflow_capabilities (
           capability_key, platform, description, aliases, required_terms,
           forbidden_terms, safety_class, portability_scope, status, metadata
         ) VALUES ($1,$2,$3,$4::text[],$5::text[],$6::text[],$7,$8,'quarantined',$9::jsonb)`,
        [
          parsed.capability.capabilityKey,
          parsed.capability.platform,
          parsed.capability.description ?? null,
          parsed.capability.aliases ?? [],
          parsed.capability.requiredTerms ?? [],
          parsed.capability.forbiddenTerms ?? [],
          parsed.capability.safetyClass,
          parsed.capability.portabilityScope ?? "global",
          JSON.stringify({
            ...(parsed.capability.metadata ?? {}),
            compositionEnabled: true,
            managedBy: "segment-builder",
            buildJobId: id,
          }),
        ],
      );
    } else {
      const owner = objectValue(existingCapability.rows[0].metadata).buildJobId;
      if (owner !== id) {
        throw Object.assign(new Error("candidate capability key is already owned"), {
          status: 409,
          code: "SEGMENT_BUILDER_CAPABILITY_CONFLICT",
        });
      }
    }

    const segmentRefs: Array<{ segmentKey: string; segmentVersion: string }> = [];
    for (const segment of parsed.segments) {
      await workflowSegmentControlPlaneService.createSegmentVersion({
        ...segment,
        actor: agentId,
      });
      await workflowSegmentControlPlaneService.validate("segment", segment.segmentKey, segment.version, agentId);
      segmentRefs.push({ segmentKey: segment.segmentKey, segmentVersion: segment.version });
    }
    const composition = await workflowSegmentControlPlaneService.createCompositionVersion({
      ...parsed.composition,
      actor: agentId,
    });
    await workflowSegmentControlPlaneService.validate(
      "composition",
      parsed.composition.compositionName,
      parsed.composition.version,
      agentId,
    );

    const transitioned = await transitionSegmentBuildJob(id, {
      targetTerminal: false,
      targetHasAutomaticNonterminalExit: true,
      transitionExternalAllowed: true,
    }, {
      candidate,
      refreshLease: true,
      resultPatch: {
        candidateHash,
        capabilityKey: parsed.capability.capabilityKey,
        compositionName: parsed.composition.compositionName,
        compositionVersion: parsed.composition.version,
        compositionKey: composition.compositionKey,
        segmentRefs,
      },
    }, "job.assigned_agent = $2", [agentId]);
    if (!transitioned) return null;
    await event(id, "candidate_submitted", agentId, { candidateHash });
    return transitioned;
  }

  async reserveCanary(input: {
    id: string;
    agentId: string;
    executionKey: string;
    requestKey: string;
  }): Promise<SegmentBuildJob | null> {
    if (input.agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const transitioned = await transitionSegmentBuildJob(input.id, {
      targetTerminal: false,
      transitionAutomatic: true,
    }, {
      refreshLease: true,
      resultPatch: {
        executionKey: input.executionKey,
        canaryRequestKey: input.requestKey,
      },
    }, "job.assigned_agent = $2", [input.agentId]);
    if (!transitioned) return null;
    await event(input.id, "canary_reserved", input.agentId, {
      executionKey: input.executionKey,
    });
    return transitioned;
  }

  async attachCanaryRun(input: {
    id: string;
    agentId: string;
    executionKey: string;
    runId: string;
    taskId: string;
  }): Promise<SegmentBuildJob | null> {
    if (input.agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET result = result || jsonb_build_object(
             'canaryRunId', $4::text,
             'canaryTaskId', $5::text
           ),
           updated_at = NOW()
       WHERE id = $1
         AND assigned_agent = $2
         AND result ->> 'executionKey' = $3
         AND EXISTS (
           SELECT 1
             FROM lifecycle_state_definitions definition
            WHERE definition.lifecycle_key = segment_build_jobs.lifecycle_key
              AND definition.status = segment_build_jobs.status
              AND NOT definition.terminal
         )
       RETURNING *`,
      [input.id, input.agentId, input.executionKey, input.runId, input.taskId],
    );
    if (!result.rows[0]) return null;
    await event(input.id, "canary_started", input.agentId, {
      executionKey: input.executionKey,
      runId: input.runId,
      taskId: input.taskId,
    });
    return rowToJob(result.rows[0]);
  }

  async canaryDispatchFailed(id: string, agentId: string, error: string): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const message = error.slice(0, 1000);
    const transitioned = await transitionSegmentBuildJob(id, {
      targetTerminal: false,
      transitionAutomatic: true,
    }, {
      error: message,
      refreshLease: true,
      evidencePatch: { canaryDispatchError: message },
    }, "job.assigned_agent = $2 AND NOT (job.result ? 'canaryRunId')", [agentId]);
    if (!transitioned) return null;
    await event(id, "canary_dispatch_failed", agentId, { error: message });
    return transitioned;
  }

  async reconcileCanary(id: string): Promise<SegmentBuildJob | null> {
    const job = await this.get(id);
    if (!job) return job;
    const executionKey = typeof job.result.executionKey === "string" ? job.result.executionKey : "";
    if (!/^[a-f0-9]{24}$/.test(executionKey)) return job;
    const canaryRunId = typeof job.result.canaryRunId === "string" ? job.result.canaryRunId : "";
    const executionResult = await getDb().query(
      `SELECT binding.postcondition_verified, binding.result_evidence,
              run_state.terminal AS run_terminal,
              run_state.retryable AS run_retryable
       FROM workflow_execution_bindings binding
       JOIN agency_workflow_runs run ON run.id = $2::uuid
       JOIN lifecycle_state_definitions run_state
         ON run_state.lifecycle_key = run.lifecycle_key
        AND run_state.status = run.status
       WHERE binding.execution_key = $1
       ORDER BY binding.updated_at DESC
       LIMIT 1`,
      [executionKey, canaryRunId || null],
    );
    const execution = executionResult.rows[0] as Record<string, unknown> | undefined;
    if (!execution || execution.run_terminal !== true) return job;
    if (execution.run_retryable === true || execution.postcondition_verified !== true) {
      const failed = await transitionSegmentBuildJob(id, {
        targetTerminal: false,
        transitionAutomatic: true,
      }, {
        error: "canary failed or postcondition was not verified",
        refreshLease: true,
        evidencePatch: {
          lastCanaryExecutionKey: executionKey,
          lastCanaryResult: execution.result_evidence ?? {},
        },
      });
      if (failed) {
        await event(id, "canary_failed", "phone-network-kernel", { executionKey });
        return failed;
      }
      return this.get(id);
    }

    const compositionName = String(job.result.compositionName ?? "");
    const compositionVersion = String(job.result.compositionVersion ?? "");
    const capabilityKey = String(job.result.capabilityKey ?? "");
    const segmentRefs = Array.isArray(job.result.segmentRefs)
      ? job.result.segmentRefs.filter((item): item is { segmentKey: string; segmentVersion: string } => (
        !!item
        && typeof item === "object"
        && typeof (item as Record<string, unknown>).segmentKey === "string"
        && typeof (item as Record<string, unknown>).segmentVersion === "string"
      ))
      : [];
    const evidence = {
      passed: true,
      postconditionVerified: true,
      executionKey,
      runtimeEvidence: execution.result_evidence ?? {},
    };
    for (const ref of segmentRefs) {
      if (await resourceVersionIsSuccessful(
        "workflow_segment_versions",
        "segment_key",
        ref.segmentKey,
        ref.segmentVersion,
      )) continue;
      await workflowSegmentControlPlaneService.recordCanary(
        "segment",
        ref.segmentKey,
        ref.segmentVersion,
        evidence,
        "phone-network-kernel",
      );
      await workflowSegmentControlPlaneService.promote(
        "segment",
        ref.segmentKey,
        ref.segmentVersion,
        "phone-network-kernel",
      );
    }
    if (!await resourceVersionIsSuccessful(
      "workflow_compositions",
      "composition_name",
      compositionName,
      compositionVersion,
    )) {
    await workflowSegmentControlPlaneService.recordCanary(
      "composition",
      compositionName,
      compositionVersion,
      evidence,
      "phone-network-kernel",
    );
    await workflowSegmentControlPlaneService.promote(
      "composition",
      compositionName,
      compositionVersion,
      "phone-network-kernel",
    );
    }
    await activateCapability(capabilityKey);
    const completed = await transitionSegmentBuildJob(id, {
      targetTerminal: true,
      targetRetryable: false,
      targetAdministrative: false,
      transitionAutomatic: true,
      transitionMarkCompleted: true,
      transitionClearFailure: true,
    }, {
      evidencePatch: {
        canaryExecutionKey: executionKey,
        postconditionVerified: true,
      },
      error: null,
    });
    if (!completed) return this.get(id);
    await event(id, "promoted", "phone-network-kernel", {
      executionKey,
      compositionName,
      compositionVersion,
      segmentRefs,
    });
    return completed;
  }

  async fail(id: string, agentId: string, error: string, blocked = false): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const failed = await transitionSegmentBuildJob(
      id,
      blocked
        ? {
            targetTerminal: false,
            targetManual: true,
            transitionAutomatic: true,
          }
        : {
            targetTerminal: true,
            targetRetryable: true,
            targetAdministrative: false,
            transitionAutomatic: true,
          },
      { error: error.slice(0, 2000) },
      "assigned_agent = $2",
      [agentId],
    );
    if (!failed) return null;
    await event(id, blocked ? "blocked" : "failed", agentId, { error: error.slice(0, 500) });
    return failed;
  }
}

export const segmentBuildJobService = new SegmentBuildJobService();
