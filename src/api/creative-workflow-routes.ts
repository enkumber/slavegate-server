import { Router } from "express";
import { createCreativeWorkflowRun } from "../modules/creative-workflows/creative-workflow.service";

const router = Router();

function responseStatus(result: Awaited<ReturnType<typeof createCreativeWorkflowRun>>): number {
  if (result.status === "queued") return 201;
  if (result.code === "CREATIVE_WORKFLOW_MISSING_FIELDS") return 400;
  if (result.code === "ACCOUNT_NOT_FOUND") return 404;
  if (result.status === "not_ready") return 409;
  return 200;
}

router.post("/", async (req, res) => {
  try {
    const { clientId, accountId, deviceId, objective, dryRun } = req.body || {};
    const result = await createCreativeWorkflowRun({
      clientId,
      accountId,
      deviceId,
      objective,
      dryRun: dryRun ?? false,
    });
    const status = responseStatus(result);
    res.status(status).json({
      ok: result.status !== "not_ready",
      code: result.code,
      data: result,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
