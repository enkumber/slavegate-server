import { Router } from "express";
import { requireAdminAuth } from "./auth.middleware";

const router = Router();

router.post("/", requireAdminAuth, (_req, res) => {
  res.status(410).json({
    ok: false,
    code: "WORKFLOW_RUNS_ENDPOINT_DISABLED",
    error: "POST /api/workflow-runs is disabled because it bypasses the per-device workflow queue.",
    replacement: "/api/workflows/human/run",
  });
});

export default router;
