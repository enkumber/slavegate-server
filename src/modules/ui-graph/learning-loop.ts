import crypto from "crypto";
import { getDb } from "../../db/client";
import {
  getResourceLifecycleState,
  getResourceLifecycleTransitionToState,
  listResourceLifecycleStates,
  selectResourceLifecycleTransition,
  type LifecycleQueryable,
} from "../lifecycle/lifecycle.service";
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
  validationStage: string;
  blockers: string[];
}

async function dispatchableResourceState(
  resourceTable: string,
  db: LifecycleQueryable,
): Promise<string> {
  const matches = (await listResourceLifecycleStates(resourceTable, "status", db))
    .filter((state) => state.dispatchable && !state.terminal && !state.administrative);
  if (matches.length !== 1) {
    throw new Error("UI graph resource must have exactly one configured dispatchable state");
  }
  return matches[0].status;
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
    context.androidVersion ?? "unknown",
    context.locale ?? "unknown",
    context.deviceClass ?? "unknown",
    context.branchKey ?? "default",
  ].join("|");
}

export function promotionDecision(input: {
  type: CandidateType;
  discoveryMethod: CandidateDiscoveryMethod;
  safetyClass: UiSafetyClass;
  successCount: number;
  failureCount: number;
  stateVerified: boolean;
  distinctDevices?: number;
  distinctBranches?: number;
  distinctEnvironments?: number;
  recoveryCount?: number;
}): PromotionDecision {
  const requiredSuccesses = 5;
  const distinctDevices = input.distinctDevices ?? 0;
  const distinctBranches = input.distinctBranches ?? 0;
  const distinctEnvironments = input.distinctEnvironments ?? 0;
  const validationStage = input.successCount < requiredSuccesses || !input.stateVerified
    ? "candidate"
    : distinctDevices < 2
      ? "device_validated"
      : distinctBranches < 2 || distinctEnvironments < 2
        ? "cohort_validated"
        : "global_promoted";
  const blockers: string[] = [];
  if (input.successCount < requiredSuccesses) blockers.push("insufficient_successes");
  if (!input.stateVerified) blockers.push("destination_state_not_verified");
  if (distinctDevices < 2) blockers.push("insufficient_device_coverage");
  if (distinctBranches < 2) blockers.push("insufficient_branch_coverage");
  if (distinctEnvironments < 2) blockers.push("insufficient_environment_coverage");
  if ((input.recoveryCount ?? 0) > 0) blockers.push("recovery_observed_requires_clean_validation");
  // Automatic reuse is deliberately a clean 5/5 gate. A candidate with any
  // failed or unverified execution remains available for manual review, but
  // is never promoted into the shared fast path automatically.
  if (input.failureCount > 0) blockers.push("manual_review_required_after_failed_validation");
  if (["mutating", "sensitive"].includes(input.safetyClass)) blockers.push("manual_review_required_for_safety_class");
  if (input.type === "state") blockers.push("state_candidates_require_manual_review");
  if (input.type === "recovery_rule") blockers.push("recovery_rules_require_manual_materialization");
  return {
    ready: input.successCount >= requiredSuccesses && input.stateVerified,
    autoPromotable: blockers.length === 0,
    requiredSuccesses,
    validationStage,
    blockers,
  };
}

export class UiGraphLearningLoop {
  async observe(input: CandidateObservation): Promise<string> {
    const key = candidateKey(input);
    const contextKey = candidateEnvironmentKey(input.context);
    const result = await getDb().query(
      `INSERT INTO ui_graph_learning_candidates
         (candidate_key, app_id, candidate_type, source_state_id, target_state_id,
          payload, evidence, contexts, discovery_method, confidence, safety_class, distinct_context_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,jsonb_build_array($8::text),$9,$10,$11,1)
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
           (candidate_id, device_id, app_version, locale, device_class, success, state_verified, evidence,
            android_version, app_build, branch_key, initial_state_key, final_state_key, recovery_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [input.candidateId, input.context.deviceId ?? null, input.context.appVersion ?? null, input.context.locale ?? null,
          input.context.deviceClass ?? null, input.success, input.stateVerified, JSON.stringify(input.evidence ?? {}),
          input.context.androidVersion ?? null, input.context.appBuild ?? null, input.context.branchKey ?? "default",
          input.context.initialStateKey ?? null, input.context.finalStateKey ?? null,
          Math.max(0, Number(input.context.recoveryCount ?? 0))],
      );
      await client.query(
        `INSERT INTO ui_graph_candidate_coverage
           (candidate_id, device_id, app_version, android_version, locale, device_class, branch_key,
            initial_state_key, final_state_key, success_count, failure_count, recovery_count,
            state_verified, last_evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (
           candidate_id,
           COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
           COALESCE(app_version, ''), COALESCE(android_version, ''),
           COALESCE(device_class, ''), branch_key
         ) DO UPDATE SET
           initial_state_key=COALESCE(EXCLUDED.initial_state_key, ui_graph_candidate_coverage.initial_state_key),
           final_state_key=COALESCE(EXCLUDED.final_state_key, ui_graph_candidate_coverage.final_state_key),
           success_count=ui_graph_candidate_coverage.success_count + EXCLUDED.success_count,
           failure_count=ui_graph_candidate_coverage.failure_count + EXCLUDED.failure_count,
           recovery_count=ui_graph_candidate_coverage.recovery_count + EXCLUDED.recovery_count,
           state_verified=ui_graph_candidate_coverage.state_verified OR EXCLUDED.state_verified,
           last_evidence=EXCLUDED.last_evidence,
           last_observed_at=NOW()`,
        [
          input.candidateId, input.context.deviceId ?? null, input.context.appVersion ?? null,
          input.context.androidVersion ?? null, input.context.locale ?? null, input.context.deviceClass ?? null,
          input.context.branchKey ?? "default", input.context.initialStateKey ?? null,
          input.context.finalStateKey ?? null, input.success && input.stateVerified ? 1 : 0,
          input.success && input.stateVerified ? 0 : 1, Math.max(0, Number(input.context.recoveryCount ?? 0)),
          input.success && input.stateVerified, JSON.stringify(input.evidence ?? {}),
        ],
      );
      const lockedCandidate = await client.query(
        `SELECT status, promoted_entity_id
           FROM ui_graph_learning_candidates
          WHERE id=$1
          FOR UPDATE`,
        [input.candidateId],
      );
      if (!lockedCandidate.rows[0]) {
        throw new Error("UI_GRAPH_CANDIDATE_NOT_FOUND");
      }
      const updated = await client.query(
        `UPDATE ui_graph_learning_candidates c SET
           success_count = stats.success_count,
           failure_count = stats.failure_count,
           distinct_context_count = stats.distinct_context_count,
           validation_stage = CASE
             WHEN stats.success_count < 5 OR NOT stats.state_verified THEN 'candidate'
             WHEN stats.distinct_devices < 2 THEN 'device_validated'
             WHEN stats.distinct_branches < 2 OR stats.distinct_environments < 2 OR stats.recovery_count > 0 THEN 'cohort_validated'
             ELSE 'global_promoted' END,
           confidence = LEAST(0.99, GREATEST(0.05,
             CASE WHEN stats.success_count + stats.failure_count = 0 THEN c.confidence
                  ELSE stats.success_count::double precision / (stats.success_count + stats.failure_count) END)),
           status = COALESCE(
             (
               SELECT transition.to_status
                 FROM lifecycle_resource_bindings binding
                 JOIN lifecycle_transitions transition
                   ON transition.lifecycle_key=binding.lifecycle_key
                  AND transition.from_status=c.status
                 JOIN lifecycle_state_definitions target
                   ON target.lifecycle_key=transition.lifecycle_key
                  AND target.status=transition.to_status
                WHERE binding.resource_table=to_regclass('ui_graph_learning_candidates')
                  AND binding.state_column='status'
                  AND transition.automatic
                  AND target.administrative
                  AND transition.metadata ? 'minimumFailureCount'
                  AND stats.failure_count >= (transition.metadata->>'minimumFailureCount')::int
                  AND stats.failure_count > stats.success_count
                ORDER BY target.sort_order
                LIMIT 1
             ),
             CASE WHEN stats.failure_count > 0 THEN lifecycle_transition_target(
               'ui_graph_learning_candidates'::regclass,
               c.status,
               '{"targetRetryable":true,"automatic":true}'::jsonb
             ) END,
             CASE WHEN lifecycle_state_matches(
               'ui_graph_learning_candidates'::regclass,
               c.status,
               '{"initial":true}'::jsonb
             ) THEN lifecycle_transition_target(
               'ui_graph_learning_candidates'::regclass,
               c.status,
               '{"targetInitial":false,"targetTerminal":false,"targetAdministrative":false,"automatic":true}'::jsonb
             ) END,
             c.status
           ),
           quarantined_at = CASE WHEN EXISTS (
             SELECT 1
               FROM lifecycle_resource_bindings binding
               JOIN lifecycle_transitions transition
                 ON transition.lifecycle_key=binding.lifecycle_key
                AND transition.from_status=c.status
               JOIN lifecycle_state_definitions target
                 ON target.lifecycle_key=transition.lifecycle_key
                AND target.status=transition.to_status
              WHERE binding.resource_table=to_regclass('ui_graph_learning_candidates')
                AND binding.state_column='status'
                AND transition.automatic
                AND target.administrative
                AND transition.metadata ? 'minimumFailureCount'
                AND stats.failure_count >= (transition.metadata->>'minimumFailureCount')::int
                AND stats.failure_count > stats.success_count
           ) THEN NOW() ELSE c.quarantined_at END,
           updated_at = NOW()
         FROM (
           SELECT candidate_id,
                  COUNT(*) FILTER (WHERE success AND state_verified)::int AS success_count,
                  COUNT(*) FILTER (WHERE NOT success OR NOT state_verified)::int AS failure_count,
                  COUNT(DISTINCT COALESCE(app_version,'unknown') || '|' || COALESCE(locale,'unknown') || '|' || COALESCE(device_class,'unknown'))::int AS distinct_context_count,
                  COUNT(DISTINCT device_id) FILTER (WHERE success AND state_verified)::int AS distinct_devices,
                  COUNT(DISTINCT COALESCE(branch_key,'default')) FILTER (WHERE success AND state_verified)::int AS distinct_branches,
                  COUNT(DISTINCT COALESCE(app_version,'unknown') || '|' || COALESCE(android_version,'unknown') || '|' || COALESCE(device_class,'unknown')) FILTER (WHERE success AND state_verified)::int AS distinct_environments,
                  COALESCE(SUM(recovery_count) FILTER (WHERE success AND state_verified),0)::int AS recovery_count,
                  BOOL_OR(success AND state_verified) AS state_verified
           FROM ui_graph_candidate_validations WHERE candidate_id = $1 GROUP BY candidate_id
         ) stats
         WHERE c.id = stats.candidate_id
         RETURNING c.*, stats.distinct_devices, stats.distinct_branches,
                   stats.distinct_environments, stats.recovery_count`,
        [input.candidateId],
      );
      const updatedCandidate = updated.rows[0];
      const updatedState = updatedCandidate
        ? await getResourceLifecycleState(
          "ui_graph_learning_candidates",
          updatedCandidate.status,
          "status",
          client,
        )
        : null;
      if (updatedState?.retryable && updatedCandidate.promoted_entity_id) {
        for (const entityTable of ["ui_graph_selectors", "ui_graph_transitions"]) {
          const linked = await client.query(
            `SELECT status FROM ${entityTable} WHERE id=$1 FOR UPDATE`,
            [updatedCandidate.promoted_entity_id],
          );
          if (!linked.rows[0]) continue;
          const linkedTransition = await selectResourceLifecycleTransition(
            entityTable,
            linked.rows[0].status,
            { targetRetryable: true, transitionAutomatic: true },
            "status",
            client,
          );
          if (!linkedTransition) {
            throw new Error("promoted UI graph entity has no configured retryable transition");
          }
          await client.query(
            `UPDATE ${entityTable} SET status=$2, updated_at=NOW() WHERE id=$1`,
            [updatedCandidate.promoted_entity_id, linkedTransition.toStatus],
          );
        }
        const candidateTransition = await getResourceLifecycleTransitionToState(
          "ui_graph_learning_candidates",
          lockedCandidate.rows[0].status,
          updatedCandidate.status,
          "status",
          client,
        );
        if (!candidateTransition) {
          throw new Error("candidate lifecycle transition was not configured");
        }
        await client.query(
          `INSERT INTO ui_graph_promotion_events
             (candidate_id, action, previous_status, next_status, actor, reason, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.candidateId,
            candidateTransition.actionKey,
            lockedCandidate.rows[0].status,
            updatedCandidate.status,
            "edge_workflow_validation",
            "Validation policy selected a retryable lifecycle transition",
            JSON.stringify(input.evidence ?? {}),
          ],
        );
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
        distinctDevices: Number(row.distinct_devices ?? 0),
        distinctBranches: Number(row.distinct_branches ?? 0),
        distinctEnvironments: Number(row.distinct_environments ?? 0),
        recoveryCount: Number(row.recovery_count ?? 0),
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
      const candidateState = await getResourceLifecycleState(
        "ui_graph_learning_candidates",
        candidate.status,
        "status",
        client,
      );
      if (candidateState?.dispatchable && candidate.promoted_entity_id) {
        await client.query("COMMIT");
        return candidate.promoted_entity_id;
      }
      const validationStats = await client.query(
        `SELECT BOOL_OR(success AND state_verified) AS state_verified,
                COUNT(DISTINCT device_id) FILTER (WHERE success AND state_verified)::int AS distinct_devices,
                COUNT(DISTINCT COALESCE(branch_key,'default')) FILTER (WHERE success AND state_verified)::int AS distinct_branches,
                COUNT(DISTINCT COALESCE(app_version,'unknown') || '|' || COALESCE(android_version,'unknown') || '|' || COALESCE(device_class,'unknown')) FILTER (WHERE success AND state_verified)::int AS distinct_environments,
                COALESCE(SUM(recovery_count) FILTER (WHERE success AND state_verified),0)::int AS recovery_count
           FROM ui_graph_candidate_validations WHERE candidate_id = $1`,
        [candidateId],
      );
      const validation = validationStats.rows[0] ?? {};
      const decision = promotionDecision({
        type: candidate.candidate_type,
        discoveryMethod: candidate.discovery_method,
        safetyClass: candidate.safety_class,
        successCount: Number(candidate.success_count),
        failureCount: Number(candidate.failure_count),
        stateVerified: Boolean(validation.state_verified),
        distinctDevices: Number(validation.distinct_devices ?? 0),
        distinctBranches: Number(validation.distinct_branches ?? 0),
        distinctEnvironments: Number(validation.distinct_environments ?? 0),
        recoveryCount: Number(validation.recovery_count ?? 0),
      });
      if (!decision.ready) throw new Error(`UI_GRAPH_CANDIDATE_NOT_READY:${decision.blockers.join(",")}`);
      if (allowAutomatic && !decision.autoPromotable) throw new Error(`UI_GRAPH_CANDIDATE_MANUAL_REVIEW_REQUIRED:${decision.blockers.join(",")}`);
      const promotionTransition = await selectResourceLifecycleTransition(
        "ui_graph_learning_candidates",
        candidate.status,
        {
          targetDispatchable: true,
          targetTerminal: false,
          ...(allowAutomatic
            ? { transitionAutomatic: true }
            : { transitionManualAllowed: true }),
        },
        "status",
        client,
      );
      if (!promotionTransition) {
        throw new Error("candidate has no configured promotion transition");
      }

      const payload = candidate.payload as Record<string, unknown>;
      let entityId: string;
      if (candidate.candidate_type === "selector") {
        const entityStatus = await dispatchableResourceState("ui_graph_selectors", client);
        const inserted = await client.query(
          `INSERT INTO ui_graph_selectors
             (state_id, element_key, strategy, selector, priority, dynamic, confidence, status,
              app_version_pattern, device_class, success_count, failure_count, last_validated_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13)
           ON CONFLICT (state_id, element_key, strategy, selector) DO UPDATE SET
             status=EXCLUDED.status, confidence=EXCLUDED.confidence, success_count=EXCLUDED.success_count,
             failure_count=EXCLUDED.failure_count, last_validated_at=NOW(), updated_at=NOW()
           RETURNING id`,
          [candidate.source_state_id, payload.elementKey, payload.strategy, JSON.stringify(payload.selector ?? {}),
            Number(payload.priority ?? 100), Boolean(payload.dynamic), candidate.confidence, entityStatus,
            payload.appVersionPattern ?? null, payload.deviceClass ?? null, candidate.success_count,
            candidate.failure_count, JSON.stringify({ candidateId })],
        );
        entityId = inserted.rows[0].id;
      } else if (candidate.candidate_type === "transition") {
        const entityStatus = await dispatchableResourceState("ui_graph_transitions", client);
        const inserted = await client.query(
          `INSERT INTO ui_graph_transitions
             (app_id, transition_key, source_state_id, target_state_id, element_key, action,
              preconditions, postconditions, cost, safety_class, confidence, status, success_count, failure_count, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (app_id, transition_key) DO UPDATE SET
             status=EXCLUDED.status, confidence=EXCLUDED.confidence, action=EXCLUDED.action,
             preconditions=EXCLUDED.preconditions, postconditions=EXCLUDED.postconditions,
             success_count=EXCLUDED.success_count, failure_count=EXCLUDED.failure_count, updated_at=NOW()
           RETURNING id`,
          [candidate.app_id, payload.transitionKey, candidate.source_state_id, candidate.target_state_id,
            payload.elementKey ?? null, JSON.stringify(payload.action ?? {}), JSON.stringify(payload.preconditions ?? {}),
            JSON.stringify(payload.postconditions ?? {}), Number(payload.cost ?? 1), candidate.safety_class,
            candidate.confidence, entityStatus, candidate.success_count, candidate.failure_count, JSON.stringify({ candidateId })],
        );
        entityId = inserted.rows[0].id;
      } else {
        throw new Error("UI_GRAPH_CANDIDATE_TYPE_REQUIRES_MANUAL_MATERIALIZATION");
      }

      await client.query(
        `UPDATE ui_graph_learning_candidates SET status=$3, promoted_entity_id=$2,
           promoted_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [candidateId, entityId, promotionTransition.toStatus],
      );
      await client.query(
        `INSERT INTO ui_graph_promotion_events
           (candidate_id, action, previous_status, next_status, actor, reason, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          candidateId,
          promotionTransition.actionKey,
          candidate.status,
          promotionTransition.toStatus,
          actor,
          reason,
          JSON.stringify({ decision }),
        ],
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
