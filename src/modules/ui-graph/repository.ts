import { getDb } from "../../db/client";
import { loadMap } from "../app-mapping/recorder.service";
import { getUiGraphRuntimeFlags } from "./config";
import { projectLegacyAppMap } from "./legacy-adapter";
import type {
  RuntimeFlags,
  StateResolution,
  TargetResolutionMethod,
  UiGraphContext,
  UiSelectorDefinition,
  UiStateDefinition,
  UiTransitionDefinition,
} from "./types";
import type { GraphRuntimeCheckpoint } from "./graph-runtime";
import { uiGraphScopePolicy } from "./runtime-policy";

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try { return jsonArray(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { return jsonObject(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

export class UiGraphRepository {
  async loadStates(appId: string): Promise<UiStateDefinition[]> {
    const db = getDb();
    const result = await db.query(
      `SELECT s.id, s.app_id, s.state_key, s.name, s.kind, s.safety_class,
              v.id AS variant_id, v.variant_key, v.signature_hash,
              v.required_anchors, v.optional_anchors, v.forbidden_anchors,
              v.app_version_pattern, v.locale_pattern, v.device_class, v.confidence_threshold
       FROM ui_graph_states s
       LEFT JOIN ui_graph_state_variants v ON v.state_id = s.id AND v.active = TRUE
       WHERE s.app_id = $1 AND s.active = TRUE
       ORDER BY s.state_key, v.variant_key`,
      [appId],
    );

    if (result.rows.length === 0) {
      const legacy = await loadMap(appId);
      return legacy ? projectLegacyAppMap(legacy).states : [];
    }

    const byId = new Map<string, UiStateDefinition>();
    for (const row of result.rows) {
      let state = byId.get(row.id);
      if (!state) {
        state = {
          id: row.id,
          appId: row.app_id,
          key: row.state_key,
          name: row.name,
          kind: row.kind,
          safetyClass: row.safety_class,
          variants: [],
        };
        byId.set(row.id, state);
      }
      if (row.variant_id) {
        state.variants.push({
          id: row.variant_id,
          key: row.variant_key,
          signatureHash: row.signature_hash,
          requiredAnchors: jsonArray(row.required_anchors),
          optionalAnchors: jsonArray(row.optional_anchors),
          forbiddenAnchors: jsonArray(row.forbidden_anchors),
          appVersionPattern: row.app_version_pattern,
          localePattern: row.locale_pattern,
          deviceClass: row.device_class,
          confidenceThreshold: Number(row.confidence_threshold),
        });
      }
    }
    return [...byId.values()];
  }

  async loadSelectors(appId: string, stateId: string, elementKey: string): Promise<UiSelectorDefinition[]> {
    if (stateId.startsWith("legacy:")) {
      const legacy = await loadMap(appId);
      if (!legacy) return [];
      return projectLegacyAppMap(legacy).selectors.filter((selector) => selector.stateId === stateId && selector.elementKey === elementKey);
    }
    const db = getDb();
    const result = await db.query(
      `SELECT id, state_id, element_key, strategy, selector, priority, dynamic,
              confidence, status, app_version_pattern, device_class, metadata
       FROM ui_graph_selectors selector
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table=to_regclass('ui_graph_selectors')
        AND binding.state_column='status'
       JOIN lifecycle_state_definitions state
         ON state.lifecycle_key=binding.lifecycle_key
        AND state.status=selector.status
       WHERE selector.state_id = $1 AND selector.element_key = $2
         AND state.dispatchable
       ORDER BY priority, confidence DESC`,
      [stateId, elementKey],
    );
    return result.rows.map((row) => {
      const selector = jsonObject(row.selector);
      return {
        id: row.id,
        stateId: row.state_id,
        elementKey: row.element_key,
        strategy: row.strategy,
        value: typeof selector.value === "string" ? selector.value : undefined,
        path: Array.isArray(selector.path) ? selector.path.filter((item): item is string => typeof item === "string") : undefined,
        coords: typeof selector.x === "number" && typeof selector.y === "number" ? { x: selector.x, y: selector.y } : undefined,
        priority: Number(row.priority),
        dynamic: Boolean(row.dynamic),
        confidence: Number(row.confidence),
        appVersionPattern: row.app_version_pattern,
        deviceClass: row.device_class,
        variantId: typeof jsonObject(row.metadata).variantId === "string" ? String(jsonObject(row.metadata).variantId) : null,
      } as UiSelectorDefinition;
    });
  }

  async loadTransitions(appId: string): Promise<UiTransitionDefinition[]> {
    const db = getDb();
    const result = await db.query(
      `SELECT transition.id, transition.transition_key, transition.app_id,
              transition.source_state_id, transition.target_state_id, transition.element_key,
              transition.action, transition.preconditions, transition.postconditions,
              transition.cost, transition.safety_class, transition.confidence
       FROM ui_graph_transitions transition
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table=to_regclass('ui_graph_transitions')
        AND binding.state_column='status'
       JOIN lifecycle_state_definitions state
         ON state.lifecycle_key=binding.lifecycle_key
        AND state.status=transition.status
       WHERE transition.app_id = $1 AND NOT state.administrative`,
      [appId],
    );
    if (result.rows.length === 0) {
      const legacy = await loadMap(appId);
      return legacy ? projectLegacyAppMap(legacy).transitions : [];
    }
    return result.rows.map((row) => ({
      id: row.id,
      key: row.transition_key,
      appId: row.app_id,
      sourceStateId: row.source_state_id,
      targetStateId: row.target_state_id,
      elementKey: row.element_key,
      action: jsonObject(row.action),
      preconditions: jsonObject(row.preconditions),
      postconditions: jsonObject(row.postconditions),
      cost: Number(row.cost),
      safetyClass: row.safety_class,
      confidence: Number(row.confidence),
    }));
  }

  async resolveFlags(context: UiGraphContext): Promise<RuntimeFlags> {
    const fallback = getUiGraphRuntimeFlags();
    try {
      const scopePolicy = await uiGraphScopePolicy();
      const contextValues = context as unknown as Record<string, unknown>;
      const scopes: Array<[string, string | null]> = scopePolicy.map((scope) => {
        const value = scope.contextField
          ? contextValues[scope.contextField]
          : scope.scopeValue;
        return [
          scope.scopeType,
          typeof value === "string" && value.trim() ? value.trim() : null,
        ];
      });
      const values: string[] = [];
      const params: unknown[] = [];
      for (const [scopeType, scopeValue] of scopes) {
        if (!scopeValue) continue;
        params.push(scopeType, scopeValue);
        values.push(`(scope_type = $${params.length - 1} AND scope_value = $${params.length})`);
      }
      if (values.length === 0) return fallback;
      const result = await getDb().query(
        `SELECT * FROM ui_graph_runtime_flags WHERE ${values.join(" OR ")}`,
        params,
      );
      const precedence = new Map(scopePolicy.map((scope, index) => [scope.scopeType, index]));
      const row = result.rows.sort((a, b) => (precedence.get(a.scope_type) ?? 99) - (precedence.get(b.scope_type) ?? 99))[0];
      if (!row) return fallback;
      return {
        enabled: Boolean(row.enabled),
        selectorFirst: Boolean(row.selector_first),
        graphRuntime: Boolean(row.graph_runtime),
        aiRecovery: Boolean(row.ai_recovery),
        candidateLearning: Boolean(row.candidate_learning),
        autoPromotion: Boolean(row.auto_promotion),
        config: jsonObject(row.config),
      };
    } catch {
      return fallback;
    }
  }

  async recordObservation(context: UiGraphContext, resolution: StateResolution, evidence: Record<string, unknown> = {}): Promise<void> {
    await getDb().query(
      `INSERT INTO ui_graph_observations
         (app_id, device_id, workflow_id, step_id, resolved_state_id, resolved_variant_id,
          resolution_method, confidence, fingerprint, ui_tree_hash, context, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)`,
      [
        context.appId, context.deviceId ?? null, context.workflowId ?? null, context.stepId ?? null,
        resolution.stateId?.startsWith("legacy:") ? null : resolution.stateId,
        resolution.variantId?.startsWith("legacy:") ? null : resolution.variantId,
        resolution.method, resolution.confidence, resolution.fingerprint,
        JSON.stringify(context), JSON.stringify({ ...evidence, matchedAnchors: resolution.matchedAnchors, missingAnchors: resolution.missingAnchors }),
      ],
    );
  }

  async recordActionEvent(input: {
    context: UiGraphContext;
    sourceStateId?: string | null;
    targetStateId?: string | null;
    stateResolutionMethod: string;
    targetResolutionMethod: TargetResolutionMethod;
    outcome: string;
    latencyMs: number;
    llmCalls?: number;
    vlmCalls?: number;
    retryCount?: number;
    reason?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const safeState = (value: string | null | undefined) => value?.startsWith("legacy:") ? null : value ?? null;
    await getDb().query(
      `INSERT INTO ui_graph_action_events
         (app_id, device_id, workflow_id, step_id, source_state_id, target_state_id,
          state_resolution_method, target_resolution_method, outcome, latency_ms,
          llm_calls, vlm_calls, retry_count, reason, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        input.context.appId, input.context.deviceId ?? null, input.context.workflowId ?? null, input.context.stepId ?? null,
        safeState(input.sourceStateId), safeState(input.targetStateId), input.stateResolutionMethod,
        input.targetResolutionMethod, input.outcome, input.latencyMs, input.llmCalls ?? 0,
        input.vlmCalls ?? 0, input.retryCount ?? 0, input.reason ?? null, JSON.stringify(input.details ?? {}),
      ],
    );
  }

  async saveRuntimeCheckpoint(input: {
    context: UiGraphContext;
    checkpoint: GraphRuntimeCheckpoint;
    status: string;
  }): Promise<void> {
    const safeUuid = (value: string | null | undefined) => value?.startsWith("legacy:") ? null : value ?? null;
    await getDb().query(
      `INSERT INTO ui_graph_runtime_checkpoints
         (workflow_id, app_id, device_id, target_state_id, current_state_id, checkpoint, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workflow_id) DO UPDATE SET
         target_state_id=EXCLUDED.target_state_id, current_state_id=EXCLUDED.current_state_id,
         checkpoint=EXCLUDED.checkpoint, status=EXCLUDED.status, updated_at=NOW()`,
      [input.context.workflowId, input.context.appId, input.context.deviceId ?? null,
        safeUuid(input.checkpoint.targetStateId), safeUuid(input.checkpoint.currentStateId),
        JSON.stringify(input.checkpoint), input.status],
    );
  }

  async recordSelectorOutcome(selectorId: string, success: boolean): Promise<void> {
    if (!selectorId || selectorId.startsWith("legacy:")) return;
    const db = getDb();
    const result = await db.query(
      `UPDATE ui_graph_selectors SET
         success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
         failure_count = failure_count + CASE WHEN $2 THEN 0 ELSE 1 END,
         confidence = LEAST(0.99, GREATEST(0.05,
           (success_count + CASE WHEN $2 THEN 1 ELSE 0 END)::double precision /
           GREATEST(1, success_count + failure_count + 1))),
         status = CASE
           WHEN NOT $2 AND failure_count + 1 > success_count THEN COALESCE(
             (
               SELECT transition.to_status
                 FROM lifecycle_resource_bindings binding
                 JOIN lifecycle_transitions transition
                   ON transition.lifecycle_key=binding.lifecycle_key
                  AND transition.from_status=ui_graph_selectors.status
                 JOIN lifecycle_state_definitions target
                   ON target.lifecycle_key=transition.lifecycle_key
                  AND target.status=transition.to_status
                WHERE binding.resource_table=to_regclass('ui_graph_selectors')
                  AND binding.state_column='status'
                  AND transition.automatic
                  AND target.administrative
                  AND transition.metadata ? 'minimumFailureCount'
                  AND failure_count + 1 >= (transition.metadata->>'minimumFailureCount')::int
                ORDER BY target.sort_order
                LIMIT 1
             ),
             status
           )
           WHEN NOT $2 THEN COALESCE(
             lifecycle_transition_target(
               'ui_graph_selectors'::regclass,
               status,
               '{"targetRetryable":true,"transitionAutomatic":true}'::jsonb
             ),
             status
           )
           ELSE status END,
         last_validated_at = CASE WHEN $2 THEN NOW() ELSE last_validated_at END,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, status, metadata`,
      [selectorId, success],
    );
    const row = result.rows[0];
    const candidateId = row ? jsonObject(row.metadata).candidateId : null;
    if (typeof candidateId === "string") {
      await db.query(
        `UPDATE ui_graph_learning_candidates SET
           success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
           failure_count = failure_count + CASE WHEN $2 THEN 0 ELSE 1 END,
           status = CASE
             WHEN NOT $2 AND failure_count + 1 > success_count THEN COALESCE(
               (
                 SELECT transition.to_status
                   FROM lifecycle_resource_bindings binding
                   JOIN lifecycle_transitions transition
                     ON transition.lifecycle_key=binding.lifecycle_key
                    AND transition.from_status=ui_graph_learning_candidates.status
                   JOIN lifecycle_state_definitions target
                     ON target.lifecycle_key=transition.lifecycle_key
                    AND target.status=transition.to_status
                  WHERE binding.resource_table=to_regclass('ui_graph_learning_candidates')
                    AND binding.state_column='status'
                    AND transition.automatic
                    AND target.administrative
                    AND transition.metadata ? 'minimumFailureCount'
                    AND failure_count + 1 >= (transition.metadata->>'minimumFailureCount')::int
                  ORDER BY target.sort_order
                  LIMIT 1
               ),
               status
             )
             WHEN NOT $2 THEN COALESCE(
               lifecycle_transition_target(
                 'ui_graph_learning_candidates'::regclass,
                 status,
                 '{"targetRetryable":true,"transitionAutomatic":true}'::jsonb
               ),
               status
             )
             ELSE status END,
           updated_at=NOW()
         WHERE id=$1`,
        [candidateId, success],
      );
    }
  }
}

export const uiGraphRepository = new UiGraphRepository();
