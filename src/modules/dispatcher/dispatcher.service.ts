/**
 * modules/dispatcher/dispatcher.service.ts
 * Job queuing via BullMQ — per-device queues, retry, timeout handling.
 *
 * Security: only whitelisted JobTypes are accepted.
 * All dispatched jobs are audit-logged.
 */

import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "../../redis/client";
import { getDb } from "../../db/client";
import { isKillSwitchActive } from "../../api/routes";
import { deviceExecutionArbiter } from "../device-execution";
import { isDeviceExecutionEnforced } from "../device-execution/device-execution-authority";
import { pnqV2RuntimeService, runPnqV2ShadowSideEffect } from "../device-execution/pnq-v2-runtime.service";
import { isPnqV2ShadowRuntimeEnabled } from "../device-execution/pnq-v2-runtime-config";
// NOTE: wsServer is intentionally NOT imported here — would create circular dependency.
// Job dispatch to device WebSocket is handled by routes.ts (after calling dispatcher.dispatch()).
// dispatcher only manages the DB + queue layer.
import type { JobType, JobParams, JobDispatchPayload } from "../../../shared/protocol/messages";
import type { Job, DispatchJobRequest } from "../../../shared/protocol/api-types";
import { v4 as uuidv4 } from "uuid";
import { recordJobExecutionEventDetached } from "../observability/job-execution-events";
import {
  expireStaleJobs,
  transitionJob,
  transitionJobByConfiguredStalePolicy,
} from "./job-lifecycle.service";

// ─── Whitelist ─────────────────────────────────────────────────────────────────
// DO NOT add generic shell commands here. Extend only with explicit approval.
// pm_install is NOT in this list — APK install exclusively through ota_update (signed)
const ALLOWED_JOB_TYPES = new Set<JobType>([
  "tap",
  "swipe",
  "long_press",
  "type_text",
  "scroll",
  "screenshot",
  "screenshot_for_vlm",  // VLM-optimized screenshot (540x1200, JPEG 85%)
  "screen_record",
  "open_app",
  "open_app_fresh",  // force-stop + am start --activity-clear-task (bypasses singleTask restore)
  "close_app",
  "ui_tree_dump",
  "press_key",       // navigation buttons: back, home, recents
  "screen_wake",
  "screen_off",
  "unlock",
  "get_screen_state",
  "get_clipboard",
  "set_clipboard",
  "wait_for_idle",
  "file_push",
  "file_delete",
  "pm_uninstall",    // requires confirmRoot=true
  "reboot",          // requires confirmRoot=true
  "ota_update",      // signed APK — routes through full audit pipeline
  "workflow_execute" as unknown as JobType, // server-side workflow engine
  // Skill system
  "skill_tap",       // tap at normalized coords from skill
  "a11y_find_tap",   // find element via A11y and tap
  "cascade_tap" as unknown as JobType,    // VLM-guided tap: screenshot → VLM coords → tap
  "ocr_find_tap",    // find text via ML Kit OCR and tap (cascade Level 3)
  // Screen Detection Cascade (US-SCREEN-CASCADE)
  "ocr_full", // Full-screen ML Kit OCR → all text blocks (implemented by SPARK S-SD-01)
  // Extended job types (not in shared protocol type but supported by device agent)
  "intent_send" as unknown as JobType,  // send explicit intent (am start with specific activity)
]);

const ROOT_COMMANDS = new Set<JobType>(["pm_uninstall", "reboot", "ota_update"]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

export function workflowChildTimeoutDisposition(
  ownership: { root_state: string; operation_state: string } | undefined,
  observedDispatch: boolean,
): "wait_queued" | "arm_execution" | "timeout" {
  if (ownership?.root_state === "queued" && ownership.operation_state === "registered") {
    return "wait_queued";
  }
  if (
    !observedDispatch &&
    ownership &&
    ["dispatching", "dispatched"].includes(ownership.operation_state)
  ) {
    return "arm_execution";
  }
  return "timeout";
}

export function shouldBlockRootForTimedOutJob(workflowId?: string): boolean {
  return !workflowId;
}

interface DispatchCoreOptions {
  legacyCompatibilityLane?: boolean;
}

export class DispatcherService {
  private queues = new Map<string, Queue>();

  private getQueue(deviceId: string): Queue {
    if (!this.queues.has(deviceId)) {
      // Use plain connection options — BullMQ has its own bundled ioredis
      // and passing our IORedis instance causes type conflicts between versions.
      const queue = new Queue(`device_${deviceId}`, {
        connection: getRedisConnectionOptions(),
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      });
      this.queues.set(deviceId, queue);
    }
    return this.queues.get(deviceId)!;
  }

  async dispatch(req: DispatchJobRequest): Promise<{ jobId: string; timeoutMs: number }> {
    return this.dispatchCore(req, {});
  }

  async dispatchLegacyGeneratedWorkflow(req: DispatchJobRequest): Promise<{ jobId: string; timeoutMs: number }> {
    return this.dispatchCore(req, { legacyCompatibilityLane: true });
  }

  private async dispatchCore(
    req: DispatchJobRequest,
    { legacyCompatibilityLane = false }: DispatchCoreOptions,
  ): Promise<{ jobId: string; timeoutMs: number }> {

    // 0. Kill switch — block all dispatches when active (B4 fix)
    if (await isKillSwitchActive()) {
      throw new Error("Kill switch active — job dispatch blocked");
    }

    // 1. Whitelist check
    if (!ALLOWED_JOB_TYPES.has(req.type)) {
      throw new Error(`Job type '${req.type}' is not allowed.`);
    }

    // 2. Root commands require explicit confirmation
    if (ROOT_COMMANDS.has(req.type) && !req.confirmRoot) {
      throw new Error(
        `Job type '${req.type}' is a root command and requires confirmRoot=true.`
      );
    }

    // 3. Calculate timeout (dynamic for type_text based on text length)
    let calculatedTimeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let skipMaxClamp = false;
    
    if (req.type === "type_text") {
      const params = req.params as Record<string, unknown>;
      const text = params?.text;
      if (typeof text === "string" && text.length > 0) {
        // Calculate realistic timeout:
        // Observed: ~660ms per character in practice (includes all delays, typos, pauses)
        // Using 700ms per char as safe estimate + 15s buffer
        const textLength = text.length;
        const estimatedMs = textLength * 700 + 15000;
        calculatedTimeout = estimatedMs;
        skipMaxClamp = true; // type_text gets exact calculated timeout
        console.log(`[dispatcher] type_text: ${textLength} chars → timeout ${calculatedTimeout}ms (${Math.round(estimatedMs/1000)}s)`);
      }
    }
    
    const timeoutMs = skipMaxClamp ? calculatedTimeout : Math.min(calculatedTimeout, MAX_TIMEOUT_MS);

    // 4. Persist job to DB
    const db = getDb();
    const jobId = uuidv4();
    await db.query(
      `INSERT INTO jobs (id, device_id, job_type, params, timeout_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, req.deviceId, req.type, JSON.stringify(req.params), timeoutMs]
    );
    recordJobExecutionEventDetached({
      jobId,
      deviceId: req.deviceId,
      workflowId: req.workflowId ?? null,
      source: "dispatcher",
      eventType: "job_created",
      details: {
        jobType: req.type,
        timeoutMs,
        stepIndex: req.stepIndex ?? null,
        legacyCompatibilityLane,
      },
    });

    if (!legacyCompatibilityLane) {
      await deviceExecutionArbiter.observeAdmission({
        deviceId: req.deviceId,
        rootKind: req.workflowId ? "server_workflow" : "job",
        externalId: req.workflowId ?? jobId,
        requestKey: req.workflowId ?? jobId,
        actor: "dispatcher",
        metadata: {
          jobType: req.type,
          workflowId: req.workflowId ?? null,
          canonicalRoot: Boolean(req.workflowId),
          stepIndex: req.stepIndex ?? null,
          observeSource: "dispatcher.dispatch",
        },
      });
    }

    // 5. Audit log (dispatch record — result_status updated when JOB_RESULT arrives)
    // Skip if workflowId present — workflow executor writes its own audit log entry
    if (!req.workflowId) {
      await db.query(
        `INSERT INTO command_log (device_id, job_id, command_type, command_raw, command_params)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.deviceId, jobId, req.type, `${req.type} → ${req.deviceId}`, JSON.stringify(req.params)]
      );
    }

    // 6. Enqueue to BullMQ
    // Note: BullMQ v5 removed the `timeout` option from JobsOptions.
    // Timeout enforcement is handled server-side via setTimeout above.
    const queue = this.getQueue(req.deviceId);
    await queue.add(
      "job",
      { jobId, deviceId: req.deviceId, type: req.type, params: req.params, timeoutMs },
      { jobId }
    );

    if (!legacyCompatibilityLane) {
      if (isPnqV2ShadowRuntimeEnabled()) {
        // Create the observation promise synchronously so prepareShadowDispatch()
        // can always see and await this job's mapping in shadow mode.
        const shadowEnqueueObservation = pnqV2RuntimeService.enqueueShadowJob({
          deviceId: req.deviceId,
          legacyJobId: jobId,
          payload: { type: req.type, params: req.params, workflowId: req.workflowId ?? null },
          timeoutMs,
        });
        runPnqV2ShadowSideEffect("enqueue", () => shadowEnqueueObservation);
      }
    }

    // Server-side timeout enforcement:
    // If device executes job but never sends JOB_RESULT (crash, connection loss),
    // job would stay 'running' forever without this.
    let observedWorkflowChildDispatch = false;
    const enforceTimeout = async () => {
      try {
        const job = await this.getJob(jobId);
        if (job) {
          const db = getDb();

          // A server-workflow child can remain durably queued behind another
          // PNQ root for longer than its execution timeout.  Its execution
          // clock must not start until PNQ actually advances the operation to
          // the wire.  Otherwise a perfectly valid queued child is timed out
          // locally and the whole workflow root is marked ambiguous before it
          // ever reaches the phone.
          if (!legacyCompatibilityLane && !shouldBlockRootForTimedOutJob(req.workflowId)) {
            const ownership = await db.query<{
              root_state: string;
              operation_state: string;
            }>(
              `SELECT roots.state AS root_state, operations.state AS operation_state
               FROM device_execution_operations operations
               JOIN device_execution_roots roots ON roots.id = operations.root_id
               WHERE operations.operation_kind = 'job'
                 AND operations.operation_id = $1
               LIMIT 1`,
              [jobId],
            );
            const current = ownership.rows[0];
            const disposition = workflowChildTimeoutDisposition(current, observedWorkflowChildDispatch);
            if (disposition === "wait_queued") {
              const retry = setTimeout(enforceTimeout, 1_000);
              retry.unref?.();
              return;
            }
            if (disposition === "arm_execution") {
              observedWorkflowChildDispatch = true;
              const executionTimer = setTimeout(enforceTimeout, timeoutMs + 5_000);
              executionTimer.unref?.();
              return;
            }
          }

          const expired = await transitionJobByConfiguredStalePolicy(jobId, db);
          if (!expired) return;
          await db.query(
            "UPDATE command_log SET result_status = $1 WHERE job_id = $2",
            [expired.status, jobId]
          );
          recordJobExecutionEventDetached({
            jobId,
            deviceId: req.deviceId,
            workflowId: req.workflowId ?? null,
            source: "dispatcher",
            eventType: "dispatcher_timeout",
            details: { jobType: req.type, timeoutMs },
          });
          if (req.workflowId) {
            // The server workflow owns the device root and decides whether a
            // timed-out child is retried or the workflow is failed. Blocking
            // the whole root here races the workflow executor and prevents the
            // next idempotent readiness child (notably unlock) from dispatching.
            return;
          }
          if (!legacyCompatibilityLane) {
            await deviceExecutionArbiter.markAmbiguous({
              deviceId: req.deviceId,
              rootKind: "job",
              externalId: jobId,
              reason: "job_timeout",
              actor: "dispatcher_timeout",
              state: "blocked",
              metadata: { timeoutMs, jobType: req.type },
            });
          }
        }
      } catch (err) {
        console.error(`[dispatcher] Timeout handler error for job ${jobId}:`, (err as Error).message);
      }
    };
    const timeoutHandle = setTimeout(enforceTimeout, timeoutMs + 5_000); // +5s grace period for network latency
    timeoutHandle.unref?.();

    return { jobId, timeoutMs };
  }

  /**
   * Called by WebSocket layer when a JOB_RESULT arrives from the device.
   */
  async handleJobResult(payload: {
    jobId: string;
    deviceId: string;
    success: boolean;
    output?: unknown;
    error?: string;
    durationMs: number;
    authority?: "legacy_generated_workflow";
  }): Promise<void> {
    const db = getDb();
    const completedAt = new Date();

    // Compute started_at in TypeScript to avoid using $4 twice in the same query
    // (PostgreSQL throws "inconsistent types deduced for parameter $4" on dual-cast usage).
    const startedAt = payload.durationMs > 0
      ? new Date(completedAt.getTime() - payload.durationMs)
      : null;

    const transitioned = await transitionJob(payload.jobId, {
      targetTerminal: true,
      targetRetryable: !payload.success,
      targetAdministrative: false,
      transitionExternalAllowed: true,
    }, {
      output: payload.output ?? null,
      error: payload.error ?? null,
      durationMs: payload.durationMs,
      startedAt,
    }, db, payload.deviceId);
    if (!transitioned) {
      throw new Error("DB lifecycle rejected external job result transition");
    }

    // Update audit log with final result status.
    // command_log is append-mostly — this single UPDATE per job (dispatch → completion)
    // is intentional and documented. If strict immutability is required, use
    // a second INSERT with event_type='result' instead.
    await db.query(
      "UPDATE command_log SET result_status = $1 WHERE job_id = $2",
      [transitioned.status, payload.jobId]
    );
    recordJobExecutionEventDetached({
      jobId: payload.jobId,
      deviceId: payload.deviceId,
      source: "dispatcher",
      eventType: "job_result_persisted",
      details: {
        status: transitioned.status,
        durationMs: payload.durationMs,
        error: payload.error ?? null,
        authority: payload.authority ?? null,
      },
    });

    if (payload.authority === "legacy_generated_workflow") return;

    const terminalObservation = {
      deviceId: payload.deviceId,
      rootKind: "job" as const,
      externalId: payload.jobId,
      terminalSelector: {
        targetTerminal: true,
        targetRetryable: !payload.success,
        targetAdministrative: false,
        transitionExternalAllowed: true,
      },
      actor: "dispatcher_result",
      reason: payload.error ?? transitioned.status,
      metadata: {
        outputPresent: payload.output !== undefined,
        durationMs: payload.durationMs,
      },
    };
    if (isDeviceExecutionEnforced()) {
      await deviceExecutionArbiter.observeTerminal(terminalObservation);
    } else {
      void deviceExecutionArbiter.observeTerminal(terminalObservation);
    }
  }

  async getJob(jobId: string): Promise<Job | null> {
    const db = getDb();
    const result = await db.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0]);
  }

  async listJobs(
    deviceId?: string,
    page = 1,
    pageSize = 50
  ): Promise<{ items: Job[]; total: number; page: number; pageSize: number }> {
    const db = getDb();
    const offset = (page - 1) * pageSize;
    const rowsWhere = deviceId ? "WHERE device_id = $3" : "";
    const countWhere = deviceId ? "WHERE device_id = $1" : "";
    const values = deviceId
      ? [pageSize, offset, deviceId]
      : [pageSize, offset];

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT * FROM jobs ${rowsWhere} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        values
      ),
      db.query(`SELECT COUNT(*) FROM jobs ${countWhere}`, deviceId ? [deviceId] : []),
    ]);

    return {
      items: rows.rows.map(rowToJob),
      total: parseInt(countRow.rows[0].count, 10),
      page,
      pageSize,
    };
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const row = await transitionJob(jobId, {
      targetTerminal: true,
      targetAdministrative: true,
      transitionManualAllowed: true,
    });
    if (!row) return false;
    await deviceExecutionArbiter.observeTerminal({
      deviceId: row.device_id,
      rootKind: "job",
      externalId: row.id,
      status: "cancelled",
      actor: "dispatcher_cancel",
      reason: "queued_job_cancelled",
    });
    return true;
  }

  async sweepStaleJobs(): Promise<{ expiredCount: number; jobIds: string[] }> {
    const expired = await expireStaleJobs();
    for (const row of expired) {
      await getDb().query(
        "UPDATE command_log SET result_status = $1 WHERE job_id = $2",
        [row.status, row.id],
      );
      recordJobExecutionEventDetached({
        jobId: row.id,
        deviceId: row.device_id,
        source: "dispatcher",
        eventType: "dispatcher_timeout",
        details: { authority: "db_lifecycle_stale_policy" },
      });
    }
    return { expiredCount: expired.length, jobIds: expired.map((row) => row.id) };
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    deviceId: row.device_id as string,
    type: row.job_type as JobType,
    params: row.params as JobParams,
    status: row.status as Job["status"],
    output: row.output ?? undefined,
    error: (row.error as string) ?? undefined,
    durationMs: (row.duration_ms as number) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
  };
}

export const dispatcherService = new DispatcherService();
