import { Router } from "express";
import { createWorkflowRun } from "../modules/workflow-runs";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const result = await createWorkflowRun(req.body ?? {});
    res.status(result.httpStatus).json({
      ok: result.ok,
      code: result.code,
      data: result.data,
      error: result.error,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
