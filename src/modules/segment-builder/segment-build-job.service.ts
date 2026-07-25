import crypto from "crypto";
import { getDb } from "../../db/client";
import { workflowSegmentControlPlaneService } from "../workflow-segments/control-plane.service";
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

export type SegmentBuildReason =
  | "capability_missing"
  | "composition_missing"
  | "segment_missing";

export const SEGMENT_BUILDER_AGENT_ID = "segment-builder";
const SEGMENT_BUILDER_SWEEP_LIMIT = 25;
const OFFLINE_QUEUED_CANARY_TIMEOUT_MS = 5 * 60_000;
const RECOVERY_REDISPATCH_GUARD_MS = 10 * 60_000;

export type SegmentBuildStatus =
  | "pending_agent"
  | "dispatched"
  | "claimed"
  | "building"
  | "candidate_ready"
  | "canary_running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

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
  status: SegmentBuildStatus;
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
    safetyClass: "read_only" | "navigation";
    portabilityScope?: "global" | "contextual" | "device" | "account";
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
    status: row.status as SegmentBuildStatus,
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
    const [device, capabilities, segments, compositions, semantics] = await Promise.all([
      db.query(
        `SELECT id, friendly_name AS name, model, android_version, agent_version, status
         FROM devices WHERE id = $1`,
        [job.deviceId],
      ),
      db.query(
        `SELECT capability_key, platform, description, aliases, required_terms,
                forbidden_terms, safety_class, portability_scope, status, metadata
         FROM workflow_capabilities
         WHERE status IN ('active','degraded')
           AND (LOWER(platform) = LOWER($1) OR platform = '*')
         ORDER BY updated_at DESC
         LIMIT 100`,
        [job.platform],
      ),
      db.query(
        `SELECT segment_key, version, platform, lifecycle_status, template,
                input_schema, output_schema, postcondition_contract, compatibility
         FROM workflow_segment_versions
         WHERE lifecycle_status IN ('promoted','candidate')
           AND (LOWER(platform) = LOWER($1) OR platform = '*')
         ORDER BY segment_key, updated_at DESC
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
         WHERE c.lifecycle_status IN ('promoted','candidate')
           AND (LOWER(c.platform) = LOWER($1) OR c.platform = '*')
         GROUP BY c.composition_name, c.version
         ORDER BY c.updated_at DESC
         LIMIT 100`,
        [job.platform],
      ),
      db.query(
        `SELECT namespace, entry_key, platform, priority, payload
         FROM runtime_semantic_entries
         WHERE status = 'active'
           AND (LOWER(platform) = LOWER($1) OR platform = '*')
         ORDER BY namespace, priority DESC, entry_key
         LIMIT 300`,
        [job.platform],
      ),
    ]);
    return {
      job,
      device: device.rows[0] ?? null,
      capabilities: capabilities.rows,
      segments: segments.rows,
      compositions: compositions.rows,
      semantics: semantics.rows,
      constraints: {
        autonomousSafetyClasses: ["read_only", "navigation"],
        candidateLifecycle: ["draft", "candidate", "canary", "promoted"],
        runtimeContract: "edge-workflow/v2",
        concreteRuntimeValuesForbiddenInReusableTemplates: true,
      },
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

  async dispatch(job: SegmentBuildJob): Promise<SegmentBuildJob> {
    const normalDispatch = ["pending_agent", "failed"].includes(job.status);
    const expiredLeaseRecovery = [
      "claimed",
      "building",
      "candidate_ready",
      "canary_running",
    ].includes(job.status)
      && typeof job.claimExpiresAt === "string"
      && Date.parse(job.claimExpiresAt) < Date.now();
    if (!normalDispatch && !expiredLeaseRecovery) return job;
    const url = await this.dispatcherUrl();
    const token = hookToken();
    const sessionKey = `hook:phone-network:${job.id}`;
    const reserved = expiredLeaseRecovery
      ? await getDb().query(
        `UPDATE segment_build_jobs
         SET agent_session_key = $2,
             dispatch_attempts = dispatch_attempts + 1,
             last_dispatch_error = NULL,
             dispatched_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('claimed','building','candidate_ready','canary_running')
           AND claim_expires_at < NOW()
           AND (
             dispatched_at IS NULL
             OR dispatched_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
           )
         RETURNING *`,
        [job.id, sessionKey, RECOVERY_REDISPATCH_GUARD_MS],
      )
      : await getDb().query(
        `UPDATE segment_build_jobs
         SET status = 'dispatched',
             agent_session_key = $2,
             dispatch_attempts = dispatch_attempts + 1,
             last_dispatch_error = NULL,
             dispatched_at = NOW(),
             completed_at = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('pending_agent','failed')
         RETURNING *`,
        [job.id, sessionKey],
      );
    if (!reserved.rows[0]) return (await this.get(job.id)) ?? job;
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
      return (await this.get(job.id)) ?? rowToJob(reserved.rows[0]);
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      const updated = await getDb().query(
        `UPDATE segment_build_jobs
         SET status = CASE WHEN status = 'dispatched' THEN 'pending_agent' ELSE status END,
             last_dispatch_error = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [job.id, message],
      );
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
       FROM segment_build_jobs
       WHERE status IN ('claimed','building','candidate_ready','canary_running')
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
       JOIN agency_workflow_runs r
         ON r.id::text = j.result ->> 'canaryRunId'
       JOIN devices d ON d.id = j.device_id
       LEFT JOIN tasks t ON t.id = r.task_id
       WHERE j.status = 'canary_running'
         AND r.status = 'queued'
         AND r.created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
         AND d.status <> 'online'
         AND (t.id IS NULL OR t.status = 'queued')
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
             r.id AS run_id,
             r.task_id,
             r.workflow_id,
             r.status AS run_status,
             d.status AS device_status
           FROM segment_build_jobs j
           JOIN agency_workflow_runs r
             ON r.id::text = j.result ->> 'canaryRunId'
           JOIN devices d ON d.id = j.device_id
           WHERE j.id = $1
             AND j.status = 'canary_running'
           FOR UPDATE OF j, r`,
          [candidate.id],
        );
        const row = locked.rows[0] as Record<string, unknown> | undefined;
        if (
          !row
          || row.run_status !== "queued"
          || row.device_status === "online"
        ) {
          await client.query("ROLLBACK");
          continue;
        }
        const taskId = typeof row.task_id === "string" ? row.task_id : null;
        if (taskId) {
          const task = await client.query(
            `SELECT status FROM tasks WHERE id = $1 FOR UPDATE`,
            [taskId],
          );
          if (task.rows[0]?.status !== "queued") {
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
          await client.query(
            `UPDATE workflow_execution_bindings
             SET status = 'failed',
                 postcondition_verified = FALSE,
                 result_evidence = result_evidence || jsonb_build_object(
                   'failureCode', 'SEGMENT_BUILD_CANARY_DEVICE_OFFLINE_TIMEOUT',
                   'runId', $2::text,
                   'deviceStatus', $3::text
                 ),
                 updated_at = NOW()
             WHERE execution_key = $1
               AND status IN ('resolved','queued')`,
            [executionKey, runId, String(row.device_status)],
          );
        }
        const build = await client.query(
          `UPDATE segment_build_jobs
           SET status = 'failed',
               error = $2,
               evidence = evidence || jsonb_build_object(
                 'offlineCanaryTimeout', jsonb_build_object(
                   'runId', $3::text,
                   'taskId', $4::text,
                   'deviceStatus', $5::text
                 )
               ),
               claim_expires_at = NULL,
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1 AND status = 'canary_running'
           RETURNING id`,
          [candidate.id, reason, runId, taskId, String(row.device_status)],
        );
        if (build.rows.length === 0) {
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
    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = CASE
             WHEN status IN ('candidate_ready','canary_running') THEN status
             ELSE 'claimed'
           END,
           assigned_agent = $2,
           claimed_at = COALESCE(claimed_at, NOW()),
           claim_expires_at = NOW() + INTERVAL '10 minutes',
           updated_at = NOW()
       WHERE id = $1
         AND (status IN ('pending_agent','dispatched') OR
              (status IN ('claimed','building','candidate_ready','canary_running')
               AND claim_expires_at < NOW()))
       RETURNING *`,
      [id, agentId],
    );
    if (!result.rows[0]) return null;
    await event(id, "claimed", agentId);
    return rowToJob(result.rows[0]);
  }

  async heartbeat(id: string, agentId: string): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = CASE WHEN status = 'claimed' THEN 'building' ELSE status END,
           claim_expires_at = NOW() + INTERVAL '10 minutes',
           updated_at = NOW()
       WHERE id = $1 AND assigned_agent = $2 AND status IN ('claimed','building','candidate_ready','canary_running')
       RETURNING *`,
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
    if (!current || current.assignedAgent !== agentId || !["claimed", "building", "candidate_ready"].includes(current.status)) {
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

    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = 'candidate_ready',
           candidate = $3::jsonb,
           result = result || jsonb_build_object(
             'candidateHash', $4::text,
             'capabilityKey', $5::text,
             'compositionName', $6::text,
             'compositionVersion', $7::text,
             'compositionKey', $8::text,
             'segmentRefs', $9::jsonb
           ),
           claim_expires_at = NOW() + INTERVAL '10 minutes',
           updated_at = NOW()
       WHERE id = $1 AND assigned_agent = $2 AND status IN ('claimed','building','candidate_ready')
       RETURNING *`,
      [
        id,
        agentId,
        canonical,
        candidateHash,
        parsed.capability.capabilityKey,
        parsed.composition.compositionName,
        parsed.composition.version,
        composition.compositionKey,
        JSON.stringify(segmentRefs),
      ],
    );
    if (!result.rows[0]) return null;
    await event(id, "candidate_submitted", agentId, { candidateHash });
    return rowToJob(result.rows[0]);
  }

  async reserveCanary(input: {
    id: string;
    agentId: string;
    executionKey: string;
    requestKey: string;
  }): Promise<SegmentBuildJob | null> {
    if (input.agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = 'canary_running',
           result = result || jsonb_build_object(
             'executionKey', $3::text,
             'canaryRequestKey', $4::text
           ),
           claim_expires_at = NOW() + INTERVAL '10 minutes',
           updated_at = NOW()
       WHERE id = $1
         AND assigned_agent = $2
         AND status = 'candidate_ready'
       RETURNING *`,
      [input.id, input.agentId, input.executionKey, input.requestKey],
    );
    if (!result.rows[0]) return null;
    await event(input.id, "canary_reserved", input.agentId, {
      executionKey: input.executionKey,
    });
    return rowToJob(result.rows[0]);
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
         AND status = 'canary_running'
         AND result ->> 'executionKey' = $3
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
    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = 'building',
           error = $3,
           evidence = evidence || jsonb_build_object('canaryDispatchError', $3::text),
           claim_expires_at = NOW() + INTERVAL '10 minutes',
           updated_at = NOW()
       WHERE id = $1
         AND assigned_agent = $2
         AND status = 'canary_running'
         AND NOT (result ? 'canaryRunId')
       RETURNING *`,
      [id, agentId, message],
    );
    if (!result.rows[0]) return null;
    await event(id, "canary_dispatch_failed", agentId, { error: message });
    return rowToJob(result.rows[0]);
  }

  async reconcileCanary(id: string): Promise<SegmentBuildJob | null> {
    const job = await this.get(id);
    if (!job || job.status !== "canary_running") return job;
    const executionKey = typeof job.result.executionKey === "string" ? job.result.executionKey : "";
    if (!/^[a-f0-9]{24}$/.test(executionKey)) return job;
    const executionResult = await getDb().query(
      `SELECT status, postcondition_verified, result_evidence
       FROM workflow_execution_bindings
       WHERE execution_key = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [executionKey],
    );
    const execution = executionResult.rows[0] as Record<string, unknown> | undefined;
    if (!execution || !["completed", "failed"].includes(String(execution.status))) return job;
    if (execution.status === "failed" || execution.postcondition_verified !== true) {
      const failed = await getDb().query(
        `UPDATE segment_build_jobs
         SET status = 'building',
             error = 'canary failed or postcondition was not verified',
             evidence = evidence || jsonb_build_object(
               'lastCanaryExecutionKey', $2::text,
               'lastCanaryResult', $3::jsonb
             ),
             claim_expires_at = NOW() + INTERVAL '10 minutes',
             updated_at = NOW()
         WHERE id = $1 AND status = 'canary_running'
         RETURNING *`,
        [id, executionKey, JSON.stringify(execution.result_evidence ?? {})],
      );
      if (failed.rows[0]) {
        await event(id, "canary_failed", "phone-network-kernel", { executionKey });
        return rowToJob(failed.rows[0]);
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
      const lifecycle = await getDb().query(
        `SELECT lifecycle_status
         FROM workflow_segment_versions
         WHERE segment_key = $1 AND version = $2`,
        [ref.segmentKey, ref.segmentVersion],
      );
      if (lifecycle.rows[0]?.lifecycle_status === "promoted") continue;
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
    const compositionLifecycle = await getDb().query(
      `SELECT lifecycle_status
       FROM workflow_compositions
       WHERE composition_name = $1 AND version = $2`,
      [compositionName, compositionVersion],
    );
    if (compositionLifecycle.rows[0]?.lifecycle_status !== "promoted") {
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
    await getDb().query(
      `UPDATE workflow_capabilities
       SET status = 'active',
           metadata = (metadata - 'buildJobId') || '{"managedBy":"segment-builder"}'::jsonb,
           updated_at = NOW()
       WHERE capability_key = $1`,
      [capabilityKey],
    );
    const completed = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = 'completed',
           evidence = evidence || jsonb_build_object(
             'canaryExecutionKey', $2::text,
             'postconditionVerified', true
           ),
           error = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'canary_running'
       RETURNING *`,
      [id, executionKey],
    );
    if (!completed.rows[0]) return this.get(id);
    await event(id, "promoted", "phone-network-kernel", {
      executionKey,
      compositionName,
      compositionVersion,
      segmentRefs,
    });
    return rowToJob(completed.rows[0]);
  }

  async fail(id: string, agentId: string, error: string, blocked = false): Promise<SegmentBuildJob | null> {
    if (agentId !== SEGMENT_BUILDER_AGENT_ID) return null;
    const result = await getDb().query(
      `UPDATE segment_build_jobs
       SET status = $3,
           error = $4,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND assigned_agent = $2
         AND status NOT IN ('completed','cancelled')
       RETURNING *`,
      [id, agentId, blocked ? "blocked" : "failed", error.slice(0, 2000)],
    );
    if (!result.rows[0]) return null;
    await event(id, blocked ? "blocked" : "failed", agentId, { error: error.slice(0, 500) });
    return rowToJob(result.rows[0]);
  }
}

export const segmentBuildJobService = new SegmentBuildJobService();
