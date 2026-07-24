import { Router } from "express";
import { requireAdminAuth } from "./auth.middleware";

const router = Router();

router.use(requireAdminAuth);
router.use((_req, res) => {
  res.status(410).json({
    ok: false,
    code: "LEGACY_WORKFLOW_RUN_RETIRED",
    error: "Legacy workflow runs are retired. Use /api/workflows/human/compile and /api/workflows/human/run.",
  });
});

export default router;
