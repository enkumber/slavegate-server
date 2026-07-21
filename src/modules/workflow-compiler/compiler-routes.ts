/**
 * workflow-compiler/compiler-routes.ts
 * API endpoints for the Workflow Compiler + Runner with AI Fallback.
 *
 * Routes:
 *   POST /hydra/workflow/compile-and-run  — compile NL instruction + execute
 *   POST /hydra/workflow/compile          — compile only (no execution)
 *   POST /hydra/workflow/run-compiled     — run an existing compiled workflow
 *   GET  /hydra/workflow/compiled/:id     — get compilation status & data
 *
 * Story: US-WORKFLOW-COMPILER, Task T7
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getDb } from "../../db/client";
import { isDeviceOnline } from "../../transport/transport";
import {
  compileInstruction,
  getCompiledWorkflow,
} from "./planner.service";
import type {
  CompiledWorkflow as PlannerWorkflow,
  CompileResult,
} from "./types";

const router = Router();
const COMPILED_WORKFLOW_ROUTINE = "compiled_workflow";

async function enqueueCompiledWorkflow(input: {
  deviceId: string;
  workflow: PlannerWorkflow;
  compileLlmCalls: number;
  source: "compile_and_run" | "run_compiled";
}): Promise<string> {
  const result = await getDb().query<{ id: string }>(
    `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
     VALUES (NULL, $1, $2, $3, NOW(), 'queued')
     RETURNING id`,
    [
      input.deviceId,
      COMPILED_WORKFLOW_ROUTINE,
      JSON.stringify({
        compiledWorkflow: input.workflow,
        compileLlmCalls: input.compileLlmCalls,
        disableTaskRetry: true,
        source: input.source,
      }),
    ],
  );
  return result.rows[0].id;
}

// ─── Auth middleware (same pattern as routes.ts / device-tokens.routes.ts) ────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.API_KEY) return next();

  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
      const parts = token.split(".");
      if (parts.length !== 3) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
      const sig = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
      if (sig !== parts[2]) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        res.status(401).json({ ok: false, error: "Token expired" }); return;
      }
      return next();
    } catch {
      res.status(401).json({ ok: false, error: "Unauthorized" }); return;
    }
  }

  res.status(401).json({ ok: false, error: "Unauthorized" });
}

router.use(requireAuth);

// ═══════════════════════════════════════════════════════════════════════════════
// POST /compile-and-run — Compile NL instruction + execute on device
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/compile-and-run", async (req: Request, res: Response) => {
  const { deviceId, appId, instruction, options } = req.body as {
    deviceId?: string;
    appId?: string;
    instruction?: string;
    options?: {
      maxRecoveryAttempts?: number;
      recoveryModel?: string;
      dryRun?: boolean;
      forceRecompile?: boolean;
    };
  };

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!appId || !instruction) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: appId, instruction",
    });
  }

  if (instruction.length > 2000) {
    return res.status(400).json({
      ok: false,
      error: "Instruction too long (max 2000 characters)",
    });
  }

  if (!deviceId) {
    return res.status(400).json({
      ok: false,
      error: "Missing deviceId",
    });
  }

  // ── Compile ───────────────────────────────────────────────────────────────
  const compileResult: CompileResult = await compileInstruction({
    appId,
    instruction,
    options: {
      maxRecoveryAttempts: options?.maxRecoveryAttempts,
      recoveryModel: options?.recoveryModel,
    },
  });

  if (!compileResult.ok || !compileResult.compiledWorkflow) {
    return res.status(422).json({
      ok: false,
      error: compileResult.error || "Compilation failed",
    });
  }

  const workflow = compileResult.compiledWorkflow;

  // ── Dry run? Return compiled only ─────────────────────────────────────────
  if (options?.dryRun) {
    return res.json({
      ok: true,
      workflowId: compileResult.workflowId,
      compiledWorkflow: workflow,
      status: "compiled",
      fromCache: compileResult.fromCache ?? false,
    });
  }

  // ── Check device ──────────────────────────────────────────────────────────
  if (!isDeviceOnline(deviceId)) {
    return res.status(503).json({
      ok: false,
      error: `Device ${deviceId} is offline`,
    });
  }

  // Device execution always enters the canonical task queue. This serializes
  // compile-and-run with cron and agency work on the same device.
  try {
    const taskId = await enqueueCompiledWorkflow({
      deviceId,
      workflow,
      compileLlmCalls: compileResult.fromCache ? 0 : 1,
      source: "compile_and_run",
    });

    return res.status(202).json({
      ok: true,
      taskId,
      jobId: taskId,
      workflowId: workflow.id,
      compiledWorkflow: workflow,
      status: "queued",
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Compiled workflow enqueue failed";
    console.error(`[workflow-compiler] compile-and-run enqueue failed for workflow=${workflow.id}: ${error}`);
    return res.status(500).json({
      ok: false,
      code: "COMPILE_AND_RUN_ENQUEUE_FAILED",
      status: "failed",
      error,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /compile — Compile NL instruction only (no execution)
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/compile", async (req: Request, res: Response) => {
  const { appId, instruction, options } = req.body as {
    appId?: string;
    instruction?: string;
    options?: {
      maxRecoveryAttempts?: number;
      recoveryModel?: string;
    };
  };

  if (!appId || !instruction) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: appId, instruction",
    });
  }

  if (instruction.length > 2000) {
    return res.status(400).json({
      ok: false,
      error: "Instruction too long (max 2000 characters)",
    });
  }

  const result: CompileResult = await compileInstruction({
    appId,
    instruction,
    options: {
      maxRecoveryAttempts: options?.maxRecoveryAttempts,
      recoveryModel: options?.recoveryModel,
    },
  });

  if (!result.ok) {
    return res.status(422).json({
      ok: false,
      error: result.error || "Compilation failed",
    });
  }

  res.json({
    ok: true,
    compiledWorkflow: result.compiledWorkflow,
    fromCache: result.fromCache ?? false,
    workflowId: result.workflowId,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /run-compiled — Run an existing compiled workflow
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/run-compiled", async (req: Request, res: Response) => {
  const { deviceId, compiledWorkflow, workflowId } = req.body as {
    deviceId?: string;
    compiledWorkflow?: PlannerWorkflow;
    workflowId?: string;
  };

  if (!deviceId) {
    return res.status(400).json({
      ok: false,
      error: "Missing deviceId",
    });
  }

  if (!compiledWorkflow && !workflowId) {
    return res.status(400).json({
      ok: false,
      error: "Missing compiledWorkflow or workflowId",
    });
  }

  // ── Check device ──────────────────────────────────────────────────────────
  if (!isDeviceOnline(deviceId)) {
    return res.status(503).json({
      ok: false,
      error: `Device ${deviceId} is offline`,
    });
  }

  // ── Resolve workflow ──────────────────────────────────────────────────────
  let workflow: PlannerWorkflow | undefined = compiledWorkflow;

  if (!workflow && workflowId) {
    const lookup = await getCompiledWorkflow(workflowId);
    if (!lookup.ok || !lookup.compiledWorkflow) {
      return res.status(404).json({
        ok: false,
        error: lookup.error || `Compiled workflow not found: ${workflowId}`,
      });
    }
    workflow = lookup.compiledWorkflow;
  }

  if (!workflow) {
    return res.status(400).json({
      ok: false,
      error: "Could not resolve compiled workflow",
    });
  }

  // Compiled workflows use the same task queue and per-device lock as cron and
  // agency runs. The HTTP request only persists admission and never dispatches
  // a child job directly to the phone.
  try {
    const taskId = await enqueueCompiledWorkflow({
      deviceId,
      workflow,
      compileLlmCalls: 0,
      source: "run_compiled",
    });

    return res.status(202).json({
      ok: true,
      taskId,
      jobId: taskId,
      workflowId: workflow.id,
      status: "queued",
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Compiled workflow enqueue failed";
    console.error(`[workflow-compiler] run-compiled enqueue failed for workflow=${workflow.id}: ${error}`);
    return res.status(500).json({
      ok: false,
      code: "RUN_COMPILED_ENQUEUE_FAILED",
      status: "failed",
      error,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /compiled/:workflowId — Get compilation status & data
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/compiled/:workflowId", async (req: Request, res: Response) => {
  const { workflowId } = req.params;

  if (!workflowId) {
    return res.status(400).json({
      ok: false,
      error: "Missing workflowId",
    });
  }

  const result = await getCompiledWorkflow(workflowId);

  if (!result.ok) {
    return res.status(404).json({
      ok: false,
      error: result.error || `Compiled workflow not found: ${workflowId}`,
    });
  }

  // Extract runtime metadata that was attached by getCompiledWorkflow
  const raw = result.compiledWorkflow as unknown as Record<string, unknown>;
  const meta = raw?._meta as
    | { status?: string; stepsCompleted?: number; recoveryCount?: number }
    | undefined;
  // Clone and strip internal _meta
  const responseWorkflow = { ...raw };
  delete responseWorkflow._meta;

  res.json({
    ok: true,
    compiledWorkflow: responseWorkflow,
    status: meta?.status || "compiled",
    stepsCompleted: meta?.stepsCompleted ?? 0,
    recoveryCount: meta?.recoveryCount ?? 0,
  });
});

export default router;
