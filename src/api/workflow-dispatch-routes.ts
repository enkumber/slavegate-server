/**
 * workflow-dispatch-routes.ts
 * New workflow dispatch endpoints — separated from hydra-routes.ts (2200 lines).
 *
 * Routes:
 *   POST   /hydra/workflow/dispatch          — dynamic workflow dispatch
 *   DELETE /hydra/workflow/:jobId             — cancel a running workflow
 *   POST   /hydra/workflow/decide             — generic decide endpoint
 */

import { Router, Request, Response } from "express";
import {
  validateWorkflowDispatch,
} from "../modules/workflows/workflow-validator";
import {
  dispatchWorkflow,
  cancelWorkflow,
  decide,
} from "../modules/workflows/workflow-dispatch.service";

const router = Router();

// ── POST /dispatch — Dynamic workflow dispatch ──────────────────────────────
router.post("/dispatch", async (req: Request, res: Response) => {
  const reqId = Math.random().toString(36).slice(2, 8);

  try {
    // Validate (including body size check) — single parse, data returned
    const bodySizeBytes = JSON.stringify(req.body).length;
    const validation = validateWorkflowDispatch(req.body, bodySizeBytes);
    if (!validation.ok) {
      console.warn(`[workflow-dispatch:${reqId}] Validation failed: ${validation.errors!.join(", ")}`);
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        errors: validation.errors,
      });
    }

    const { deviceId, workflow, timeoutMs } = validation.data!;
    const result = await dispatchWorkflow({ deviceId, workflow, timeoutMs });

    console.log(`[workflow-dispatch:${reqId}] OK — jobId=${result.jobId}`);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const code = err.code ?? "INTERNAL_ERROR";
    const status =
      code === "RATE_LIMITED" ? 429 :
      code === "DEVICE_OFFLINE" ? 503 :
      500;

    console.error(`[workflow-dispatch:${reqId}] Error (${code}): ${err.message}`);
    res.status(status).json({ ok: false, code, error: err.message });
  }
});

// ── DELETE /:jobId — Cancel a running workflow ──────────────────────────────
router.delete("/:jobId", async (req: Request, res: Response) => {
  const reqId = Math.random().toString(36).slice(2, 8);

  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ ok: false, code: "MISSING_JOB_ID", error: "jobId is required" });
    }

    const result = await cancelWorkflow(jobId);
    console.log(`[workflow-cancel:${reqId}] OK — jobId=${jobId}`);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const code = err.code ?? "INTERNAL_ERROR";
    const status =
      code === "NOT_FOUND" ? 404 :
      code === "ALREADY_CANCELLED" ? 409 :
      500;

    console.error(`[workflow-cancel:${reqId}] Error (${code}): ${err.message}`);
    res.status(status).json({ ok: false, code, error: err.message });
  }
});

// ── POST /decide — Generic decision endpoint (enhanced) ─────────────────────
router.post("/decide", async (req: Request, res: Response) => {
  try {
    const { workflowName, stepName, context } = req.body as {
      workflowName?: string;
      stepName?: string;
      context?: Record<string, any>;
    };

    // Basic validation
    if (!stepName) {
      return res.status(400).json({ ok: false, code: "MISSING_STEP_NAME", error: "stepName is required" });
    }

    console.log(`[workflow-decide] ${workflowName ?? "dynamic"}/${stepName}`);
    const result = decide(workflowName, stepName, context);
    console.log(`[workflow-decide] → action=${result.action}`);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[workflow-decide] Error:", err);
    res.status(500).json({ ok: false, code: "INTERNAL_ERROR", error: err.message });
  }
});

export default router;
