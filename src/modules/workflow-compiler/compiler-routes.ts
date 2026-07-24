import { Router } from "express";
import { requireAdminAuth } from "../../api/auth.middleware";

const router = Router();

router.use(requireAdminAuth);
router.use((_req, res) => {
  res.status(410).json({
    ok: false,
    code: "LEGACY_WORKFLOW_COMPILER_RETIRED",
    error: "Legacy workflow compilation is retired. Use /api/workflows/human/compile and PostgreSQL workflow compositions.",
  });
});

export default router;
