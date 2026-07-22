import crypto from "crypto";
import { getDb } from "../../db/client";
import type { UiGraphContext, UiSafetyClass } from "./types";

export type CandidateType = "state" | "selector" | "transition" | "recovery_rule";
export type CandidateDiscoveryMethod = "ui_tree" | "ocr" | "vlm" | "llm_recovery" | "manual";

export interface CandidateObservation {
  appId: string;
  type: CandidateType;
  sourceStateId?: string | null;
  targetStateId?: string | null;
  payload: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  context: UiGraphContext;
  discoveryMethod: CandidateDiscoveryMethod;
  confidence: number;
  safetyClass: UiSafetyClass;
}

export interface PromotionDecision {
  ready: boolean;
  autoPromotable: boolean;
  requiredSuccesses: number;
  blockers: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function candidateKey(input: Pick<CandidateObservation, "appId" | "type" | "sourceStateId" | "targetStateId" | "payload">): string {
  // `Pick` only constrains TypeScript. Runtime callers pass the full
  // observation, so hashing `input` directly also included volatile evidence,
  // context and confidence and created one candidate per execution.
  const canonical = {
    appId: input.appId,
    type: input.type,
    sourceStateId: input.sourceStateId ?? null,
    targetStateId: input.targetStateId ?? null,
    payload: input.payload,
  };
  return crypto.createHash("sha256").update(stable(canonical)).digest("hex");
}

/**
 * Groups observations by portable UI environment without coupling shared
 * knowledge to a physical phone. deviceId is intentionally excluded: it is
 * recorded on observations/validations for telemetry only.
 */
export function candidateEnvironmentKey(context: UiGraphContext): string {
  return [
    context.appId,
    context.appVersion ?? "unknown",
    context.locale ?? "unknown",
    context.deviceClass ?? "unknown",
  ].join("|");
}

export function promotionDecision(input: {
  type: CandidateType;
  discoveryMethod: CandidateDiscoveryMethod;
  safetyClass: UiSafetyClass;
  successCount: number;
  failureCount: number;
  stateVerified: boolean;
}): PromotionDecision {
  const requiredSuccesses = 5;
  // Repeated state-verified executions are the safety gate. Portable
  // environment diversity is telemetry, never a cross-device prerequisite.
  const blockers: string[] = [];
  if (input.successCount < requiredSuccesses) blockers.push("insufficient_successes");
  if (!input.stateVerified) blockers.push("destination_state_not_verified");
  // Automatic reuse is deliberately a clean 5/5 gate. A candidate with any
  // failed or unverified execution remains available for manual review, but
  // is never promoted into the shared fast path automatically.
  if (input.failureCount > 0) blockers.push("manual_review_required_after_failed_validation");
  if (["mutating", "sensitive"].includes(input.safetyClass)) blockers.push("manual_review_required_for_safety_class");
  if (input.type === "state") blockers.push("state_candidates_require_manual_review");
  if (input.type === "recovery_rule") blockers.push("recovery_rules_require_manual_materialization");
  return {
    ready: blockers.filter((item) => !item.startsWith("manual_review") && !item.endsWith("require_manual_review") && item !== "recovery_rules_require_manual_materialization").length === 0,
    autoPromotable: blockers.length === 0,
    requiredSuccesses,
    blockers,
  };
}

export class UiGraphLearningLoop {
  async observe(input: CandidateObservation): Promise<string> {
    const key = candidateKey(input);
    const contextKey = candidateEnvironmentKey(input.context);
    const result = await getDb().query(
      `INSERT INTO ui_graph_learning_candidates
         (candidate_key, app_id, candidate_type, status, source_state_id, target_state_id,
          payload, evidence, contexts, discovery_method, confidence, safety_class, distinct_context_count)
       VALUES ($1,$2,$3,'candidate',$4,$5,$6,$7,jsonb_build_array($8::text),$9,$10,$11,1)
       ON CONFLICT (candidate_key) DO UPDATE SET
         evidence = ui_graph_learning_candidates.evidence || EXCLUDED.evidence,
         contexts = CASE
           WHEN ui_graph_learning_candidates.contexts @> EXCLUDED.contexts THEN ui_graph_learning_candidates.contexts
           ELSE ui_graph_learning_candidates.contexts || EXCLUDED.contexts
         END,
         distinct_context_count = CASE
           WHEN ui_graph_learning_candidates.contexts @> EXCLUDED.contexts THEN ui_graph_learning_candidates.distinct_context_count
           ELSE ui_graph_learning_candidates.distinct_context_count + 1
         END,
         confidence = GREATEST(ui_graph_learning_candidates.confidence, EXCLUDED.confidence),
         last_observed_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [
        key, input.appId, input.type, input.sourceStateId ?? null, input.targetStateId ?? null,
        JSON.stringify(input.payload), JSON.stringify(input.evidence ?? {}), contextKey,
        input.discoveryMethod, Math.max(0, Math.min(1, input.confidence)), input.safetyClass,
      ],
    );
    return result.rows[0].id;
  }

  async validate(input: {
    candidateId: string;
    context: UiGraphContext;
    success: boolean;
    stateVerified: boolean;
    evidence?: Record<string, unknown>;
  }): Promise<PromotionDecision> {
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ui_graph_candidate_validations
           (candidate_id, device_id, app_version, locale, device_class, success, state_verified, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.candidateId, input.context.deviceId ?? null, input.context.appVersion ?? null, input.context.locale ?? null,
          input.context.deviceClass ?? null, input.success, input.stateVerified, JSON.stringify(input.evidence ?? {})],
      );
      const updated = await client.query(
        `UPDATE ui_graph_learning_candidates c SET
           success_count = stats.success_count,
           failure_count = stats.failure_count,
           distinct_context_count = stats.distinct_context_count,
           confidence = LEAST(0.99, GREATEST(0.05,
             CASE WHEN stats.success_count + stats.failure_count = 0 THEN c.confidence
                  ELSE stats.success_count::double precision / (stats.success_count + stats.failure_count) END)),
           status = CASE
             WHEN stats.failure_count >= 3 AND stats.failure_count > stats.success_count THEN 'quarantined'
             WHEN stats.failure_count > 0 AND c.status = 'promoted' THEN 'degraded'
             WHEN c.status IN ('observed', 'candidate') THEN 'validating'
             ELSE c.status END,
           quarantined_at = CASE WHEN stats.failure_count >= 3 AND stats.failure_count > stats.success_count THEN NOW() ELSE c.quarantined_at END,
           updated_at = NOW()
         FROM (
           SELECT candidate_id,
                  COUNT(*) FILTER (WHERE success AND state_verified)::int AS success_count,
                  COUNT(*) FILTER (WHERE NOT success OR NOT state_verified)::int AS failure_count,
                  COUNT(DISTINCT COALESCE(app_version,'unknown') || '|' || COALESCE(locale,'unknown') || '|' || COALESCE(device_class,'unknown'))::int AS distinct_context_count,
                  BOOL_OR(success AND state_verified) AS state_verified
           FROM ui_graph_candidate_validations WHERE candidate_id = $1 GROUP BY candidate_id
         ) stats
         WHERE c.id = stats.candidate_id
         RETURNING c.*`,
        [input.candidateId],
      );
      const updatedCandidate = updated.rows[0];
      if (updatedCandidate?.status === "degraded" && updatedCandidate.promoted_entity_id) {
        const entityTable = updatedCandidate.candidate_type === "selector"
          ? "ui_graph_selectors"
          : updatedCandidate.candidate_type === "transition"
            ? "ui_graph_transitions"
            : null;
        if (entityTable) {
          await client.query(
            `UPDATE ${entityTable} SET status='degraded', updated_at=NOW() WHERE id=$1 AND status='promoted'`,
            [updatedCandidate.promoted_entity_id],
          );
          await client.query(
            `INSERT INTO ui_graph_promotion_events
               (candidate_id, action, previous_status, next_status, actor, reason, evidence)
             VALUES ($1,'degrade','promoted','degraded','edge_workflow_validation','First failed validation after promotion',$2)`,
            [input.candidateId, JSON.stringify(input.evidence ?? {})],
          );
        }
      }
      await client.query("COMMIT");
      const row = updatedCandidate;
      return promotionDecision({
        type: row.candidate_type,
        discoveryMethod: row.discovery_method,
        safetyClass: row.safety_class,
        successCount: Number(row.success_count),
        failureCount: Number(row.failure_count),
        stateVerified: input.stateVerified,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async promote(candidateId: string, actor: string, reason: string, allowAutomatic = false): Promise<string> {
    const client = await getDb().connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT * FROM ui_graph_learning_candidates WHERE id = $1 FOR UPDATE`, [candidateId]);
      const candidate = locked.rows[0];
      if (!candidate) throw new Error("UI_GRAPH_CANDIDATE_NOT_FOUND");
      if (candidate.status === "promoted" && candidate.promoted_entity_id) {
        await client.query("COMMIT");
        return candidate.promoted_entity_id;
      }
      const validationStats = await client.query(
        `SELECT BOOL_OR(success AND state_verified) AS state_verified FROM ui_graph_candidate_validations WHERE candidate_id = $1`,
        [candidateId],
      );
      const decision = promotionDecision({
        type: candidate.candidate_type,
        discoveryMethod: candidate.discovery_method,
        safetyClass: candidate.safety_class,
        successCount: Number(candidate.success_count),
        failureCount: Number(candidate.failure_count),
        stateVerified: Boolean(validationStats.rows[0]?.state_verified),
      });
      if (!decision.ready) throw new Error(`UI_GRAPH_CANDIDATE_NOT_READY:${decision.blockers.join(",")}`);
      if (allowAutomatic && !decision.autoPromotable) throw new Error(`UI_GRAPH_CANDIDATE_MANUAL_REVIEW_REQUIRED:${decision.blockers.join(",")}`);

      const payload = candidate.payload as Record<string, unknown>;
      let entityId: string;
      if (candidate.candidate_type === "selector") {
        const inserted = await client.query(
          `INSERT INTO ui_graph_selectors
             (state_id, element_key, strategy, selector, priority, dynamic, confidence, status,
              app_version_pattern, device_class, success_count, failure_count, last_validated_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'promoted',$8,$9,$10,$11,NOW(),$12)
           ON CONFLICT (state_id, element_key, strategy, selector) DO UPDATE SET
             status='promoted', confidence=EXCLUDED.confidence, success_count=EXCLUDED.success_count,
             failure_count=EXCLUDED.failure_count, last_validated_at=NOW(), updated_at=NOW()
           RETURNING id`,
          [candidate.source_state_id, payload.elementKey, payload.strategy, JSON.stringify(payload.selector ?? {}),
            Number(payload.priority ?? 100), Boolean(payload.dynamic), candidate.confidence,
            payload.appVersionPattern ?? null, payload.deviceClass ?? null, candidate.success_count,
            candidate.failure_count, JSON.stringify({ candidateId })],
        );
        entityId = inserted.rows[0].id;
      } else if (candidate.candidate_type === "transition") {
        const inserted = await client.query(
          `INSERT INTO ui_graph_transitions
             (app_id, transition_key, source_state_id, target_state_id, element_key, action,
              preconditions, postconditions, cost, safety_class, confidence, status, success_count, failure_count, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'promoted',$12,$13,$14)
           ON CONFLICT (app_id, transition_key) DO UPDATE SET
             status='promoted', confidence=EXCLUDED.confidence, action=EXCLUDED.action,
             preconditions=EXCLUDED.preconditions, postconditions=EXCLUDED.postconditions,
             success_count=EXCLUDED.success_count, failure_count=EXCLUDED.failure_count, updated_at=NOW()
           RETURNING id`,
          [candidate.app_id, payload.transitionKey, candidate.source_state_id, candidate.target_state_id,
            payload.elementKey ?? null, JSON.stringify(payload.action ?? {}), JSON.stringify(payload.preconditions ?? {}),
            JSON.stringify(payload.postconditions ?? {}), Number(payload.cost ?? 1), candidate.safety_class,
            candidate.confidence, candidate.success_count, candidate.failure_count, JSON.stringify({ candidateId })],
        );
        entityId = inserted.rows[0].id;
      } else {
        throw new Error("UI_GRAPH_CANDIDATE_TYPE_REQUIRES_MANUAL_MATERIALIZATION");
      }

      await client.query(
        `UPDATE ui_graph_learning_candidates SET status='promoted', promoted_entity_id=$2,
           promoted_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [candidateId, entityId],
      );
      await client.query(
        `INSERT INTO ui_graph_promotion_events
           (candidate_id, action, previous_status, next_status, actor, reason, evidence)
         VALUES ($1,'promote',$2,'promoted',$3,$4,$5)`,
        [candidateId, candidate.status, actor, reason, JSON.stringify({ decision })],
      );
      await client.query("COMMIT");
      return entityId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const uiGraphLearningLoop = new UiGraphLearningLoop();
