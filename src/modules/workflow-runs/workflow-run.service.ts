import { getDb } from "../../db/client";
import { loadMap, startRecording } from "../app-mapping/recorder.service";
import { validateAppMapQuality, type AppMap } from "../app-mapping/schema";
import { compileInstruction } from "../workflow-compiler/planner.service";
import { attemptRecovery, resetRecoveryCounts } from "../workflow-compiler/recovery.service";
import { runCompiledWorkflow } from "../workflow-compiler/runner.service";
import { workflowEvents } from "../workflow-events";
import {
  MAX_WORKFLOW_RUN_INSTRUCTION_LENGTH,
  type CreateWorkflowRunRequest,
  type CreateWorkflowRunResult,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "./types";

function validateInput(input: CreateWorkflowRunRequest): { ok: true; instruction: string; appId: string; deviceId: string } | { ok: false; error: string; code: string } {
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";

  if (!instruction || !appId || !deviceId) {
    return {
      ok: false,
      code: "WORKFLOW_RUN_MISSING_FIELDS",
      error: "instruction, appId and deviceId required",
    };
  }
  if (instruction.length > MAX_WORKFLOW_RUN_INSTRUCTION_LENGTH) {
    return {
      ok: false,
      code: "WORKFLOW_RUN_INSTRUCTION_TOO_LONG",
      error: `instruction too long (max ${MAX_WORKFLOW_RUN_INSTRUCTION_LENGTH} characters)`,
    };
  }
  return { ok: true, instruction, appId, deviceId };
}

export function isAppMapCompleteEnough(map: AppMap | null): map is AppMap {
  return validateAppMapQuality(map).usable;
}

function rowToWorkflowRun(row: Record<string, unknown>): WorkflowRunRecord {
  return {
    id: row.id as string,
    instruction: row.instruction as string,
    appId: row.app_id as string,
    deviceId: row.device_id as string,
    status: row.status as WorkflowRunStatus,
    discoveryRan: row.discovery_ran as boolean,
    appMapVersion: row.app_map_version as string | null,
    workflowId: row.compiled_workflow_id as string | null,
    result: (row.result ?? {}) as Record<string, unknown>,
    error: row.error as string | null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at as string,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at as string | null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at as string | null,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at as string | null,
  };
}

async function insertRun(instruction: string, appId: string, deviceId: string): Promise<WorkflowRunRecord> {
  const { rows } = await getDb().query(
    `INSERT INTO workflow_runs (instruction, app_id, device_id, status)
     VALUES ($1, $2, $3, 'accepted')
     RETURNING *`,
    [instruction, appId, deviceId]
  );
  return rowToWorkflowRun(rows[0]);
}

async function updateRun(
  runId: string,
  status: WorkflowRunStatus,
  patch: {
    discoveryRan?: boolean;
    appMapVersion?: string | null;
    workflowId?: string | null;
    result?: Record<string, unknown>;
    error?: string | null;
  } = {}
): Promise<WorkflowRunRecord> {
  const sets = ["status = $2", "updated_at = NOW()"];
  const values: unknown[] = [runId, status];
  let idx = 3;

  if (status === "running") sets.push("started_at = COALESCE(started_at, NOW())");
  if (status === "completed" || status === "failed" || status === "aborted") sets.push("completed_at = NOW()");
  if (patch.discoveryRan !== undefined) {
    sets.push(`discovery_ran = $${idx++}`);
    values.push(patch.discoveryRan);
  }
  if (patch.appMapVersion !== undefined) {
    sets.push(`app_map_version = $${idx++}`);
    values.push(patch.appMapVersion);
  }
  if (patch.workflowId !== undefined) {
    sets.push(`compiled_workflow_id = $${idx++}`);
    values.push(patch.workflowId);
  }
  if (patch.result !== undefined) {
    sets.push(`result = $${idx++}`);
    values.push(JSON.stringify(patch.result));
  }
  if (patch.error !== undefined) {
    sets.push(`error = $${idx++}`);
    values.push(patch.error);
  }

  const { rows } = await getDb().query(
    `UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    values
  );
  return rowToWorkflowRun(rows[0]);
}

async function compiledWorkflowExists(workflowId: string): Promise<boolean> {
  try {
    const { rows } = await getDb().query(
      "SELECT 1 FROM compiled_workflows WHERE id = $1 LIMIT 1",
      [workflowId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

function publishRunEvent(run: WorkflowRunRecord, event: "queued" | "started" | "completed" | "failed", details: Record<string, unknown> = {}): void {
  workflowEvents.publish({
    source: "workflow_runs",
    event,
    workflowId: run.workflowId ?? undefined,
    workflowRunId: run.id,
    deviceId: run.deviceId,
    status: run.status,
    mode: "server",
    details: {
      appId: run.appId,
      discoveryRan: run.discoveryRan,
      ...details,
    },
  });
}

async function loadOrDiscoverAppMap(run: WorkflowRunRecord): Promise<{ appMap: AppMap; discoveryRan: boolean }> {
  const existing = await loadMap(run.appId);
  if (isAppMapCompleteEnough(existing)) {
    return { appMap: existing, discoveryRan: false };
  }

  await updateRun(run.id, "discovering", { discoveryRan: true });
  publishRunEvent({ ...run, status: "discovering", discoveryRan: true }, "started", {
    phase: "app_map_discovery",
    reason: existing ? "incomplete_app_map" : "missing_app_map",
  });

  await startRecording(run.deviceId, run.appId);
  const discovered = await loadMap(run.appId);
  if (!isAppMapCompleteEnough(discovered)) {
    throw new Error(`App map discovery did not produce a complete app map for appId="${run.appId}"`);
  }
  return { appMap: discovered, discoveryRan: true };
}

export async function createWorkflowRun(input: CreateWorkflowRunRequest): Promise<CreateWorkflowRunResult> {
  const validated = validateInput(input);
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.code,
      status: "validation_failed",
      httpStatus: 400,
      error: validated.error,
    };
  }

  let run = await insertRun(validated.instruction, validated.appId, validated.deviceId);
  publishRunEvent(run, "queued", { phase: "accepted" });

  try {
    const { appMap, discoveryRan } = await loadOrDiscoverAppMap(run);
    run = await updateRun(run.id, "compiling", {
      discoveryRan,
      appMapVersion: appMap.version,
    });
    publishRunEvent(run, "started", { phase: "compile", appMapVersion: appMap.version });

    const compileResult = await compileInstruction({
      appId: run.appId,
      instruction: run.instruction,
    });
    if (!compileResult.ok || !compileResult.compiledWorkflow || !compileResult.workflowId) {
      const error = compileResult.error || "Compilation failed";
      run = await updateRun(run.id, "failed", {
        error,
        result: { phase: "compile", error },
      });
      publishRunEvent(run, "failed", { phase: "compile", error });
      return { ok: false, code: "WORKFLOW_COMPILE_FAILED", status: "failed", httpStatus: 422, data: run, error };
    }
    if (!(await compiledWorkflowExists(compileResult.workflowId))) {
      const error = "Compiled workflow was not persisted";
      run = await updateRun(run.id, "failed", {
        error,
        result: { phase: "compile", error, workflowId: compileResult.workflowId },
      });
      publishRunEvent(run, "failed", { phase: "compile", error, workflowId: compileResult.workflowId });
      return { ok: false, code: "WORKFLOW_NOT_PERSISTED", status: "failed", httpStatus: 500, data: run, error };
    }

    run = await updateRun(run.id, "running", {
      workflowId: compileResult.workflowId,
      result: { fromCache: compileResult.fromCache ?? false },
    });
    publishRunEvent(run, "started", {
      phase: "execute",
      workflowId: compileResult.workflowId,
      stepsTotal: compileResult.compiledWorkflow.steps.length,
    });

    resetRecoveryCounts(compileResult.compiledWorkflow.id);
    const execution = await runCompiledWorkflow(
      {
        deviceId: run.deviceId,
        workflow: compileResult.compiledWorkflow,
        compileLlmCalls: compileResult.fromCache ? 0 : 1,
      },
      async (ctx, stepIndex, reason) => attemptRecovery(ctx, stepIndex, reason, compileResult.compiledWorkflow!.recoveryModel)
    );

    const finalStatus: WorkflowRunStatus = execution.status === "completed" ? "completed" : execution.status;
    run = await updateRun(run.id, finalStatus, {
      result: {
        fromCache: compileResult.fromCache ?? false,
        stepsCompleted: execution.stepsCompleted,
        stepsTotal: execution.stepsTotal,
        recoveryCount: execution.recoveryCount,
        counters: execution.counters,
        totalLatencyMs: execution.totalLatencyMs,
      },
      error: execution.error ?? null,
    });
    publishRunEvent(run, execution.ok ? "completed" : "failed", {
      phase: "execute",
      stepsCompleted: execution.stepsCompleted,
      stepsTotal: execution.stepsTotal,
      recoveryCount: execution.recoveryCount,
      error: execution.error,
    });

    return {
      ok: execution.ok,
      status: finalStatus,
      httpStatus: execution.ok ? 201 : 502,
      data: {
        ...run,
        appMap: {
          appId: appMap.appId,
          version: appMap.version,
          pageCount: appMap.pageCount,
          transitionCount: appMap.transitionCount,
        },
        compiledWorkflow: compileResult.compiledWorkflow,
        execution,
        fromCache: compileResult.fromCache ?? false,
      },
      error: execution.error,
    };
  } catch (err) {
    const error = (err as Error).message;
    run = await updateRun(run.id, "failed", {
      error,
      result: { error },
    });
    publishRunEvent(run, "failed", { error });
    return { ok: false, code: "WORKFLOW_RUN_FAILED", status: "failed", httpStatus: 500, data: run, error };
  }
}
