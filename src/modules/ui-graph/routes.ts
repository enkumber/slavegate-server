import { Router, type Request, type Response } from "express";
import { requireAdminAuth } from "../../api/auth.middleware";
import { getDb } from "../../db/client";
import { getResourceLifecycleState, selectResourceLifecycleTransition } from "../lifecycle/lifecycle.service";
import { describeUiGraphRuntimeFlags } from "./config";
import { uiGraphLearningLoop } from "./learning-loop";
import { uiGraphRepository } from "./repository";
import { evaluateCanaryGate, recordCanaryResult } from "./canary.service";
import { persistStateSnapshot, replaySnapshotCorpus } from "./snapshot-replay.service";

const router = Router();
const SCOPE_TYPES = new Set(["global", "app", "workflow", "device"]);

function actor(req: Request): string {
  const principal = (req as Request & { authPrincipal?: Record<string, unknown> }).authPrincipal;
  return typeof principal?.userId === "string"
    ? principal.userId
    : typeof principal?.tokenId === "string"
      ? principal.tokenId
      : String(principal?.kind ?? "admin");
}

router.get("/status", requireAdminAuth, async (_req: Request, res: Response) => {
  const db = getDb();
  const [events, candidates, flags] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS actions,
         COUNT(*) FILTER (WHERE target_resolution_method IN ('direct','resource_id','content_description','semantic_id','text','structural','coord_cache'))::int AS fast_path_actions,
         COUNT(*) FILTER (WHERE target_resolution_method = 'vlm')::int AS vlm_actions,
         COUNT(*) FILTER (WHERE state_resolution_method = 'unknown')::int AS unknown_state_actions,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM runtime_semantic_entries entry
               JOIN lifecycle_state_definitions definition
                 ON definition.lifecycle_key = entry.lifecycle_key
                AND definition.status = entry.status
              WHERE entry.namespace = 'ui_graph_outcome_policy'
                AND entry.entry_key = ui_graph_action_events.outcome
                AND definition.dispatchable
                AND COALESCE((entry.payload->>'recovered')::boolean, FALSE)
           )
         )::int AS recovered_actions,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms)::double precision AS p50_latency_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::double precision AS p95_latency_ms
       FROM ui_graph_action_events WHERE created_at >= NOW() - INTERVAL '24 hours'`,
    ),
    db.query(`SELECT status, candidate_type, COUNT(*)::int AS count FROM ui_graph_learning_candidates GROUP BY status, candidate_type ORDER BY status, candidate_type`),
    db.query(`SELECT * FROM ui_graph_runtime_flags ORDER BY scope_type, scope_value`),
  ]);
  const stats = events.rows[0] ?? {};
  const total = Number(stats.actions ?? 0);
  res.json({
    ok: true,
    data: {
      startupDefaults: describeUiGraphRuntimeFlags(),
      effective24h: {
        ...stats,
        fastPathRate: total > 0 ? Number(stats.fast_path_actions ?? 0) / total : 0,
        vlmRate: total > 0 ? Number(stats.vlm_actions ?? 0) / total : 0,
        unknownStateRate: total > 0 ? Number(stats.unknown_state_actions ?? 0) / total : 0,
      },
      candidates: candidates.rows,
      flags: flags.rows,
    },
  });
});

router.get("/states", requireAdminAuth, async (req: Request, res: Response) => {
  const appId = typeof req.query.appId === "string" ? req.query.appId.trim() : "";
  if (!appId) return res.status(400).json({ ok: false, error: "appId is required" });
  const states = await uiGraphRepository.loadStates(appId);
  const transitions = await uiGraphRepository.loadTransitions(appId);
  res.json({ ok: true, data: { states, transitions } });
});

router.get("/candidates", requireAdminAuth, async (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const appId = typeof req.query.appId === "string" ? req.query.appId : null;
  if (status) {
    const configured = await getResourceLifecycleState("ui_graph_learning_candidates", status);
    if (!configured) return res.status(400).json({ ok: false, error: "invalid status" });
  }
  const params: unknown[] = [];
  const where: string[] = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (appId) { params.push(appId); where.push(`app_id = $${params.length}`); }
  const result = await getDb().query(
    `SELECT * FROM ui_graph_learning_candidates ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 200`,
    params,
  );
  res.json({ ok: true, data: result.rows });
});

router.get("/events", requireAdminAuth, async (req: Request, res: Response) => {
  const appId = typeof req.query.appId === "string" ? req.query.appId : null;
  const params: unknown[] = [];
  const where = appId ? (params.push(appId), `WHERE app_id = $1`) : "";
  const result = await getDb().query(
    `SELECT * FROM ui_graph_action_events ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  res.json({ ok: true, data: result.rows });
});

router.get("/promotion-events", requireAdminAuth, async (_req: Request, res: Response) => {
  const result = await getDb().query(
    `SELECT e.*, c.app_id, c.candidate_type, c.candidate_key
     FROM ui_graph_promotion_events e
     JOIN ui_graph_learning_candidates c ON c.id = e.candidate_id
     ORDER BY e.created_at DESC LIMIT 200`,
  );
  res.json({ ok: true, data: result.rows });
});

router.post("/candidates/:id/validate", requireAdminAuth, async (req: Request, res: Response) => {
  if (typeof req.body?.success !== "boolean" || typeof req.body?.stateVerified !== "boolean") {
    return res.status(400).json({ ok: false, error: "success and stateVerified booleans are required" });
  }
  const decision = await uiGraphLearningLoop.validate({
    candidateId: req.params.id,
    context: {
      appId: String(req.body?.appId ?? "unknown"),
      deviceId: typeof req.body?.deviceId === "string" ? req.body.deviceId : null,
      appVersion: typeof req.body?.appVersion === "string" ? req.body.appVersion : null,
      appBuild: typeof req.body?.appBuild === "string" ? req.body.appBuild : null,
      androidVersion: typeof req.body?.androidVersion === "string" ? req.body.androidVersion : null,
      locale: typeof req.body?.locale === "string" ? req.body.locale : null,
      deviceClass: typeof req.body?.deviceClass === "string" ? req.body.deviceClass : null,
      branchKey: typeof req.body?.branchKey === "string" ? req.body.branchKey : "default",
      initialStateKey: typeof req.body?.initialStateKey === "string" ? req.body.initialStateKey : null,
      finalStateKey: typeof req.body?.finalStateKey === "string" ? req.body.finalStateKey : null,
      recoveryCount: Number.isFinite(req.body?.recoveryCount) ? Math.max(0, req.body.recoveryCount) : 0,
    },
    success: req.body.success,
    stateVerified: req.body.stateVerified,
    evidence: req.body?.evidence && typeof req.body.evidence === "object" ? req.body.evidence : {},
  });
  res.json({ ok: true, data: { candidateId: req.params.id, decision } });
});

router.post("/snapshots", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const data = await persistStateSnapshot({
      appId: String(req.body?.appId ?? ""),
      stateKey: String(req.body?.stateKey ?? ""),
      uiTree: String(req.body?.uiTree ?? ""),
      appVersion: typeof req.body?.appVersion === "string" ? req.body.appVersion : null,
      androidVersion: typeof req.body?.androidVersion === "string" ? req.body.androidVersion : null,
      locale: typeof req.body?.locale === "string" ? req.body.locale : null,
      deviceClass: typeof req.body?.deviceClass === "string" ? req.body.deviceClass : null,
      deviceId: typeof req.body?.deviceId === "string" ? req.body.deviceId : null,
      workflowId: typeof req.body?.workflowId === "string" ? req.body.workflowId : null,
      branchKey: typeof req.body?.branchKey === "string" ? req.body.branchKey : null,
      source: req.body?.source,
      metadata: req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {},
    });
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

router.post("/snapshots/replay", requireAdminAuth, async (req: Request, res: Response) => {
  if (!Array.isArray(req.body?.rules) || !req.body?.machine || typeof req.body.machine !== "object") {
    return res.status(400).json({ ok: false, error: "rules and machine are required" });
  }
  const data = await replaySnapshotCorpus({
    appId: String(req.body?.appId ?? ""),
    rules: req.body.rules,
    machine: req.body.machine,
  });
  res.status(data.failed > 0 ? 409 : 200).json({ ok: data.failed === 0, data });
});

router.post("/canary-runs", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const data = await recordCanaryResult({
      cohortId: String(req.body?.cohortId ?? ""),
      cacheKey: String(req.body?.cacheKey ?? ""),
      deviceId: String(req.body?.deviceId ?? ""),
      workflowId: typeof req.body?.workflowId === "string" ? req.body.workflowId : null,
      branchKey: typeof req.body?.branchKey === "string" ? req.body.branchKey : "default",
      status: req.body?.status,
      postconditionVerified: req.body?.postconditionVerified === true,
      recoveryCount: Number(req.body?.recoveryCount ?? 0),
      evidence: req.body?.evidence && typeof req.body.evidence === "object" ? req.body.evidence : {},
    });
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

router.get("/canary-cohorts", requireAdminAuth, async (_req: Request, res: Response) => {
  const result = await getDb().query(
    `SELECT c.*,
            COUNT(r.id)::int AS run_count,
            COUNT(r.id) FILTER (
              WHERE run_state.terminal
                AND NOT run_state.retryable
                AND NOT run_state.administrative
                AND r.postcondition_verified
            )::int AS verified_count,
            COUNT(r.id) FILTER (
              WHERE run_state.terminal AND run_state.retryable
            )::int AS failed_count
       FROM workflow_canary_cohorts c
       LEFT JOIN workflow_canary_runs r ON r.cohort_id=c.id
       LEFT JOIN lifecycle_resource_bindings run_binding
         ON run_binding.resource_table=to_regclass('workflow_canary_runs')
        AND run_binding.state_column='status'
       LEFT JOIN lifecycle_state_definitions run_state
         ON run_state.lifecycle_key=run_binding.lifecycle_key
        AND run_state.status=r.status
      GROUP BY c.id ORDER BY c.updated_at DESC`,
  );
  res.json({ ok: true, data: result.rows });
});

router.post("/canary-cohorts", requireAdminAuth, async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const platform = typeof req.body?.platform === "string" ? req.body.platform.trim() : "";
  if (!name || !platform) return res.status(400).json({ ok: false, error: "name and platform are required" });
  const result = await getDb().query(
    `INSERT INTO workflow_canary_cohorts
       (name, platform, safety_classes, required_distinct_devices, required_distinct_branches, config)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET
       platform=EXCLUDED.platform, safety_classes=EXCLUDED.safety_classes,
       required_distinct_devices=EXCLUDED.required_distinct_devices,
       required_distinct_branches=EXCLUDED.required_distinct_branches,
       config=EXCLUDED.config, updated_at=NOW()
     RETURNING *`,
    [
      name, platform, JSON.stringify(Array.isArray(req.body?.safetyClasses) ? req.body.safetyClasses : ["read_only", "navigation"]),
      Math.max(1, Number(req.body?.requiredDistinctDevices ?? 2)),
      Math.max(1, Number(req.body?.requiredDistinctBranches ?? 2)),
      JSON.stringify(req.body?.config && typeof req.body.config === "object" ? req.body.config : {}),
    ],
  );
  res.json({ ok: true, data: result.rows[0] });
});

router.get("/canary-cohorts/:cohortId/gate/:cacheKey", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const data = await evaluateCanaryGate(req.params.cacheKey, req.params.cohortId);
    res.status(data.ready ? 200 : 409).json({ ok: data.ready, data });
  } catch (error) {
    res.status(404).json({ ok: false, error: (error as Error).message });
  }
});

router.put("/flags/:scopeType/:scopeValue", requireAdminAuth, async (req: Request, res: Response) => {
  const { scopeType, scopeValue } = req.params;
  if (!SCOPE_TYPES.has(scopeType)) return res.status(400).json({ ok: false, error: "invalid scope type" });
  if (!scopeValue.trim()) return res.status(400).json({ ok: false, error: "scope value is required" });
  const enabled = req.body?.enabled === true;
  const result = await getDb().query(
    `INSERT INTO ui_graph_runtime_flags
       (scope_type, scope_value, enabled, selector_first, graph_runtime, ai_recovery, candidate_learning, auto_promotion, config, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (scope_type, scope_value) DO UPDATE SET
       enabled=EXCLUDED.enabled, selector_first=EXCLUDED.selector_first, graph_runtime=EXCLUDED.graph_runtime,
       ai_recovery=EXCLUDED.ai_recovery, candidate_learning=EXCLUDED.candidate_learning,
       auto_promotion=EXCLUDED.auto_promotion, config=EXCLUDED.config, updated_by=EXCLUDED.updated_by, updated_at=NOW()
     RETURNING *`,
    [scopeType, scopeValue, enabled, req.body?.selectorFirst === true, req.body?.graphRuntime === true,
      req.body?.aiRecovery !== false, req.body?.candidateLearning !== false, req.body?.autoPromotion === true,
      JSON.stringify(req.body?.config ?? {}), actor(req)],
  );
  res.json({ ok: true, data: result.rows[0] });
});

router.post("/candidates/:id/promote", requireAdminAuth, async (req: Request, res: Response) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) return res.status(400).json({ ok: false, error: "reason is required" });
  try {
    const entityId = await uiGraphLearningLoop.promote(req.params.id, actor(req), reason, false);
    const persisted = await getDb().query(
      `SELECT status FROM ui_graph_learning_candidates WHERE id=$1`,
      [req.params.id],
    );
    res.json({ ok: true, data: { candidateId: req.params.id, entityId, status: persisted.rows[0]?.status } });
  } catch (error) {
    res.status(409).json({ ok: false, error: (error as Error).message });
  }
});

router.post("/candidates/:id/quarantine", requireAdminAuth, async (req: Request, res: Response) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) return res.status(400).json({ ok: false, error: "reason is required" });
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`SELECT * FROM ui_graph_learning_candidates WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "candidate not found" });
    }
    const transition = await selectResourceLifecycleTransition(
      "ui_graph_learning_candidates",
      locked.rows[0].status,
      { targetAdministrative: true, transitionManualAllowed: true },
      "status",
      client,
    );
    if (!transition) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "candidate has no configured administrative transition" });
    }
    await client.query(
      `UPDATE ui_graph_learning_candidates
          SET status=$2, quarantined_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [req.params.id, transition.toStatus],
    );
    await client.query(
      `INSERT INTO ui_graph_promotion_events (candidate_id, action, previous_status, next_status, actor, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, transition.actionKey, locked.rows[0].status, transition.toStatus, actor(req), reason],
    );
    if (locked.rows[0].promoted_entity_id) {
      for (const table of ["ui_graph_selectors", "ui_graph_transitions"]) {
        const linked = await client.query(`SELECT status FROM ${table} WHERE id=$1 FOR UPDATE`, [locked.rows[0].promoted_entity_id]);
        if (!linked.rows[0]) continue;
        const linkedTransition = await selectResourceLifecycleTransition(
          table,
          linked.rows[0].status,
          { targetAdministrative: true, transitionManualAllowed: true },
          "status",
          client,
        );
        if (!linkedTransition) {
          throw new Error("linked UI graph entity has no configured administrative transition");
        }
        await client.query(
          `UPDATE ${table} SET status=$2, updated_at=NOW() WHERE id=$1`,
          [locked.rows[0].promoted_entity_id, linkedTransition.toStatus],
        );
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true, data: { candidateId: req.params.id, status: transition.toStatus } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export default router;
