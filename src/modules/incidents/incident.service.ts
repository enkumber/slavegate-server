import { getDb } from "../../db/client";

export type IncidentStatus = "open" | "acknowledged" | "investigating" | "resolved" | "closed";

interface TerminalTaskFailure {
  id: string;
  device_id: string;
  routine: string;
  account_id?: string | null;
  params?: Record<string, unknown>;
}

interface FailureResult {
  failReason?: string;
  failedStep?: string | number;
  stepsCompleted?: number;
  totalSteps?: number;
  durationMs?: number;
  generatedWorkflow?: {
    workflowId?: string;
    cacheKey?: string;
    failureCode?: string;
  };
}

const SAFE_TIMEZONES = new Set(["Europe/Bucharest", "UTC"]);
const INCIDENT_STATUSES = new Set<IncidentStatus>(["open", "acknowledged", "investigating", "resolved", "closed"]);

function cleanText(value: unknown, max = 1000): string {
  return String(value ?? "Unknown failure").replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function errorCode(result: FailureResult): string | null {
  if (result.generatedWorkflow?.failureCode) return cleanText(result.generatedWorkflow.failureCode, 120);
  const match = cleanText(result.failReason, 240).match(/^([A-Z][A-Z0-9_]{2,80})(?::|\b)/);
  return match?.[1] ?? null;
}

function classifyFailure(reason: string): { category: string; severity: string } {
  const value = reason.toLowerCase();
  if (/credential|secret|token|exfiltrat|unauthori[sz]ed|permission|security/.test(value)) {
    return { category: "security", severity: "critical" };
  }
  if (/offline|disconnect|unreachable|no device|not connected/.test(value)) {
    return { category: "availability", severity: "high" };
  }
  if (/account|login|challenge|captcha|verification/.test(value)) {
    return { category: "account", severity: "high" };
  }
  if (/mismatch|contradict|invalid state|checkpoint|integrity/.test(value)) {
    return { category: "integrity", severity: "high" };
  }
  return { category: "execution", severity: "medium" };
}

async function addEvent(incidentId: string, eventType: string, actor: string, details: Record<string, unknown>): Promise<void> {
  await getDb().query(
    `INSERT INTO phone_network_incident_events (incident_id, event_type, actor, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [incidentId, eventType, cleanText(actor, 80), JSON.stringify(details)],
  );
}

export async function recordExhaustedTaskIncident(
  task: TerminalTaskFailure,
  result: FailureResult,
  recoveryAttempts: number,
): Promise<void> {
  try {
    const reason = cleanText(result.failReason);
    const classification = classifyFailure(reason);
    const workflowId = result.generatedWorkflow?.workflowId
      ?? (typeof task.params?.workflowId === "string" ? task.params.workflowId : null);
    const telemetry = {
      routine: task.routine,
      failedStep: result.failedStep ?? null,
      stepsCompleted: result.stepsCompleted ?? null,
      totalSteps: result.totalSteps ?? null,
      durationMs: result.durationMs ?? null,
      cacheKey: result.generatedWorkflow?.cacheKey ?? null,
      accountId: task.account_id ?? null,
    };
    const saved = await getDb().query<{ id: string; inserted: boolean }>(
      `INSERT INTO phone_network_incidents (
         incident_key, source_type, source_id, task_id, workflow_id, device_id,
         category, severity, error_code, summary, recovery_attempts, telemetry
       ) VALUES ($1, 'task', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (incident_key) DO UPDATE SET
         status = CASE
           WHEN phone_network_incidents.status IN ('resolved', 'closed') THEN 'open'
           ELSE phone_network_incidents.status
         END,
         category = EXCLUDED.category,
         severity = EXCLUDED.severity,
         error_code = EXCLUDED.error_code,
         summary = EXCLUDED.summary,
         recovery_attempts = GREATEST(phone_network_incidents.recovery_attempts, EXCLUDED.recovery_attempts),
         telemetry = EXCLUDED.telemetry,
         occurrence_count = phone_network_incidents.occurrence_count + 1,
         last_detected_at = NOW(),
         resolved_at = NULL,
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        `task:${task.id}`,
        task.id,
        task.id,
        workflowId,
        task.device_id,
        classification.category,
        classification.severity,
        errorCode(result),
        reason,
        Math.max(0, recoveryAttempts),
        JSON.stringify(telemetry),
      ],
    );
    const row = saved.rows[0];
    if (row) {
      await addEvent(row.id, row.inserted ? "created" : "reopened", "phone-network", {
        source: "task-runner",
        taskId: task.id,
        recoveryAttempts,
      });
    }
  } catch (err) {
    console.error("[incidents] Failed to persist exhausted task incident:", (err as Error).message);
  }
}

export async function listIncidents(filters: {
  status?: string;
  severity?: string;
  since?: string;
  limit?: number;
} = {}): Promise<unknown[]> {
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const result = await getDb().query(
    `SELECT * FROM phone_network_incidents
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR severity = $2)
        AND ($3::timestamptz IS NULL OR last_detected_at >= $3)
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        last_detected_at DESC
      LIMIT $4`,
    [filters.status ?? null, filters.severity ?? null, filters.since ?? null, limit],
  );
  return result.rows;
}

export async function getIncident(id: string): Promise<{ incident: unknown; events: unknown[] } | null> {
  const incident = await getDb().query(`SELECT * FROM phone_network_incidents WHERE id = $1`, [id]);
  if (!incident.rows[0]) return null;
  const events = await getDb().query(
    `SELECT * FROM phone_network_incident_events WHERE incident_id = $1 ORDER BY created_at ASC`,
    [id],
  );
  return { incident: incident.rows[0], events: events.rows };
}

export async function updateIncidentStatus(input: {
  id: string;
  status: IncidentStatus;
  actor: string;
  note?: string;
}): Promise<unknown | null> {
  if (!INCIDENT_STATUSES.has(input.status)) throw new Error("Invalid incident status");
  const result = await getDb().query(
    `UPDATE phone_network_incidents SET
       status = $2,
       acknowledged_at = CASE WHEN $2 IN ('acknowledged', 'investigating') THEN COALESCE(acknowledged_at, NOW()) ELSE acknowledged_at END,
       resolved_at = CASE WHEN $2 IN ('resolved', 'closed') THEN NOW() ELSE NULL END,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [input.id, input.status],
  );
  if (!result.rows[0]) return null;
  const eventType = input.status === "acknowledged" ? "acknowledged" : input.status;
  await addEvent(input.id, eventType, input.actor, { note: cleanText(input.note ?? "", 2000) });
  return result.rows[0];
}

export async function addIncidentEvent(input: {
  id: string;
  eventType: "shadow_check" | "quarantined" | "routed" | "note";
  actor: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await addEvent(input.id, input.eventType, input.actor, input.details ?? {});
}

export async function getDailyAuditSnapshot(date: string, timezone = "Europe/Bucharest"): Promise<Record<string, unknown>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  if (!SAFE_TIMEZONES.has(timezone)) throw new Error("unsupported timezone");
  const db = getDb();
  const params = [date, timezone];
  const windowSql = `(SELECT ($1::date::timestamp AT TIME ZONE $2) AS start_at,
                              (($1::date + 1)::timestamp AT TIME ZONE $2) AS end_at)`;
  const [tasks, runs, artifacts, candidates, incidents, findings, changedArtifacts, changedCandidates] = await Promise.all([
    db.query(`SELECT status, COUNT(*)::int AS count FROM tasks, ${windowSql} w
              WHERE COALESCE(completed_at, scheduled_time) >= w.start_at
                AND COALESCE(completed_at, scheduled_time) < w.end_at GROUP BY status`, params),
    db.query(`SELECT status, COUNT(*)::int AS count FROM workflow_runs, ${windowSql} w
              WHERE created_at >= w.start_at AND created_at < w.end_at GROUP BY status`, params),
    db.query(`SELECT artifact_state AS status, COUNT(*)::int AS count FROM generated_workflow_plan_cache, ${windowSql} w
              WHERE updated_at >= w.start_at AND updated_at < w.end_at GROUP BY artifact_state`, params),
    db.query(`SELECT status, candidate_type, COUNT(*)::int AS count FROM ui_graph_learning_candidates, ${windowSql} w
              WHERE updated_at >= w.start_at AND updated_at < w.end_at GROUP BY status, candidate_type`, params),
    db.query(`SELECT status, severity, COUNT(*)::int AS count FROM phone_network_incidents, ${windowSql} w
              WHERE last_detected_at >= w.start_at AND last_detected_at < w.end_at GROUP BY status, severity`, params),
    db.query(
      `SELECT 'promoted_without_clean_5_of_5' AS kind, 'high' AS severity,
              id::text AS subject_id, candidate_key, success_count, failure_count, safety_class
         FROM ui_graph_learning_candidates, ${windowSql} w
        WHERE status = 'promoted' AND updated_at >= w.start_at AND updated_at < w.end_at
          AND (success_count < 5 OR failure_count > 0 OR safety_class NOT IN ('read_only', 'navigation'))
       UNION ALL
       SELECT 'device_specific_candidate' AS kind, 'medium' AS severity,
              id::text AS subject_id, candidate_key, success_count, failure_count, safety_class
         FROM ui_graph_learning_candidates, ${windowSql} w
        WHERE updated_at >= w.start_at AND updated_at < w.end_at
          AND (payload::text ~* 'device[_-]?id' OR payload::text ~* 'device[_-]?class')
       UNION ALL
       SELECT 'suspicious_recovery_or_vlm' AS kind, 'medium' AS severity,
              id::text AS subject_id, COALESCE(step_id, workflow_id, id::text) AS candidate_key,
              retry_count AS success_count, (llm_calls + vlm_calls) AS failure_count, outcome AS safety_class
         FROM ui_graph_action_events, ${windowSql} w
        WHERE created_at >= w.start_at AND created_at < w.end_at
          AND (retry_count > 2 OR vlm_calls > 0 OR outcome IN ('failed', 'aborted'))
       ORDER BY severity DESC LIMIT 200`,
      params,
    ),
    db.query(
      `SELECT cache_key, template_id, platform, artifact_state, hit_count, updated_at,
              workflow->>'id' AS workflow_id,
              workflow->>'safetyClass' AS safety_class,
              CASE WHEN jsonb_typeof(workflow->'steps') = 'array' THEN jsonb_array_length(workflow->'steps') ELSE 0 END AS step_count,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'id', step->>'id', 'action', step->>'action',
                'hasSelector', step ? 'selector', 'hasNormalizedCoords', step ? 'normalizedCoords'
              )) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(workflow->'steps') = 'array' THEN workflow->'steps' ELSE '[]'::jsonb END) step), '[]'::jsonb) AS steps
         FROM generated_workflow_plan_cache, ${windowSql} w
        WHERE updated_at >= w.start_at AND updated_at < w.end_at
        ORDER BY updated_at DESC LIMIT 500`,
      params,
    ),
    db.query(
      `SELECT id, candidate_key, app_id, candidate_type, status, discovery_method,
              confidence, success_count, failure_count, safety_class,
              first_observed_at, last_observed_at, promoted_at, updated_at,
              ARRAY(SELECT jsonb_object_keys(payload)) AS payload_fields
         FROM ui_graph_learning_candidates, ${windowSql} w
        WHERE updated_at >= w.start_at AND updated_at < w.end_at
        ORDER BY updated_at DESC LIMIT 500`,
      params,
    ),
  ]);
  return {
    date,
    timezone,
    tasks: tasks.rows,
    workflowRuns: runs.rows,
    workflowArtifacts: artifacts.rows,
    learningCandidates: candidates.rows,
    incidents: incidents.rows,
    findings: findings.rows,
    changedArtifacts: changedArtifacts.rows,
    changedCandidates: changedCandidates.rows,
  };
}

export async function saveAuditRun(input: {
  date: string;
  timezone?: string;
  actor?: string;
  status: "completed" | "failed";
  summary?: Record<string, unknown>;
  findings?: Array<{
    findingKey: string;
    kind: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    subjectType: string;
    subjectId?: string;
    summary: string;
    evidence?: Record<string, unknown>;
    recommendedAction?: string;
    status?: "open" | "verified" | "dismissed" | "resolved";
  }>;
}): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must use YYYY-MM-DD");
  const timezone = input.timezone ?? "Europe/Bucharest";
  if (!SAFE_TIMEZONES.has(timezone)) throw new Error("unsupported timezone");
  const actor = cleanText(input.actor ?? "kraken", 80);
  const run = await getDb().query<{ id: string }>(
    `INSERT INTO phone_network_audit_runs (
       audit_date, timezone, actor, status, window_start, window_end, summary, completed_at
     ) VALUES (
       $1, $2, $3, $4,
       ($1::date::timestamp AT TIME ZONE $2),
       (($1::date + 1)::timestamp AT TIME ZONE $2),
       $5::jsonb, NOW()
     ) ON CONFLICT (audit_date, timezone, actor) DO UPDATE SET
       status = EXCLUDED.status,
       summary = EXCLUDED.summary,
       completed_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [input.date, timezone, actor, input.status, JSON.stringify(input.summary ?? {})],
  );
  const id = run.rows[0]?.id;
  if (!id) throw new Error("audit run was not persisted");
  for (const finding of (input.findings ?? []).slice(0, 500)) {
    await getDb().query(
      `INSERT INTO phone_network_audit_findings (
         audit_run_id, finding_key, kind, severity, subject_type, subject_id,
         summary, evidence, recommended_action, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (audit_run_id, finding_key) DO UPDATE SET
         kind = EXCLUDED.kind, severity = EXCLUDED.severity,
         subject_type = EXCLUDED.subject_type, subject_id = EXCLUDED.subject_id,
         summary = EXCLUDED.summary, evidence = EXCLUDED.evidence,
         recommended_action = EXCLUDED.recommended_action,
         status = EXCLUDED.status, updated_at = NOW()`,
      [
        id,
        cleanText(finding.findingKey, 200),
        cleanText(finding.kind, 100),
        finding.severity,
        cleanText(finding.subjectType, 80),
        finding.subjectId ? cleanText(finding.subjectId, 200) : null,
        cleanText(finding.summary, 2000),
        JSON.stringify(finding.evidence ?? {}),
        finding.recommendedAction ? cleanText(finding.recommendedAction, 2000) : null,
        finding.status ?? "open",
      ],
    );
  }
  return { id };
}

export const incidentService = {
  recordExhaustedTaskIncident,
  listIncidents,
  getIncident,
  updateIncidentStatus,
  addIncidentEvent,
  getDailyAuditSnapshot,
  saveAuditRun,
};
