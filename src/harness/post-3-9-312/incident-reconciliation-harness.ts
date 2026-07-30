import fs from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { HARNESS_BLOCKED, HARNESS_PASS, HARNESS_STATUS_FIELD, redact, redactJson, redactString } from "./redaction";

export interface IncidentReconciliationEnv {
  candidateSha?: string;
  expectedCandidateSha?: string;
  sourceIdentity?: string;
  capturedAt?: string;
  date?: string;
  timezone?: string;
  databaseUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  evidencePath?: string;
  baselineTotalShapeFields?: string;
  baselineNonterminalShapeFields?: string;
  baselineStatusCountsJson?: string;
}

export interface IncidentReconciliationEvidence {
  status: string;
  candidateSha?: string;
  sourceIdentity?: string;
  capturedAt?: string;
  date?: string;
  timezone?: string;
  readOnlyTransaction: boolean;
  blockedReasons?: string[];
  dbShape: Record<string, unknown>;
  dailyAudit: unknown;
  readback: Record<string, unknown>;
  comparisons: Record<string, unknown>;
  target: Record<string, unknown>;
}

const SELECT_ONLY = /^\s*(select|show)\b/i;

export function readIncidentReconciliationEnv(env: NodeJS.ProcessEnv = process.env): IncidentReconciliationEnv {
  return {
    candidateSha: env.PN_POST_312_INCIDENT_CANDIDATE_SHA,
    expectedCandidateSha: env.PN_POST_312_INCIDENT_EXPECTED_CANDIDATE_SHA,
    sourceIdentity: env.PN_POST_312_INCIDENT_SOURCE_IDENTITY,
    capturedAt: env.PN_POST_312_INCIDENT_CAPTURED_AT,
    date: env.PN_POST_312_INCIDENT_DATE,
    timezone: env.PN_POST_312_INCIDENT_TIMEZONE,
    databaseUrl: env.PN_POST_312_INCIDENT_DATABASE_URL,
    apiBaseUrl: env.PN_POST_312_INCIDENT_API_BASE_URL,
    apiKey: env.PN_POST_312_INCIDENT_API_KEY,
    evidencePath: env.PN_POST_312_INCIDENT_EVIDENCE_PATH,
    baselineTotalShapeFields: env.PN_POST_312_INCIDENT_BASELINE_TOTAL_SHAPE_FIELDS,
    baselineNonterminalShapeFields: env.PN_POST_312_INCIDENT_BASELINE_NONTERMINAL_SHAPE_FIELDS,
    baselineStatusCountsJson: env.PN_POST_312_INCIDENT_BASELINE_STATUS_COUNTS_JSON,
  };
}

export function validateIncidentReconciliationEnv(env: IncidentReconciliationEnv): string[] {
  const missing: string[] = [];
  if (!env.candidateSha) missing.push("PN_POST_312_INCIDENT_CANDIDATE_SHA");
  if (!env.expectedCandidateSha) missing.push("PN_POST_312_INCIDENT_EXPECTED_CANDIDATE_SHA");
  if (!env.sourceIdentity) missing.push("PN_POST_312_INCIDENT_SOURCE_IDENTITY");
  if (!env.capturedAt) missing.push("PN_POST_312_INCIDENT_CAPTURED_AT");
  if (!env.date) missing.push("PN_POST_312_INCIDENT_DATE");
  if (!env.timezone) missing.push("PN_POST_312_INCIDENT_TIMEZONE");
  if (!env.databaseUrl) missing.push("PN_POST_312_INCIDENT_DATABASE_URL");
  if (!env.apiBaseUrl) missing.push("PN_POST_312_INCIDENT_API_BASE_URL");
  if (!env.apiKey) missing.push("PN_POST_312_INCIDENT_API_KEY");
  if (!env.evidencePath) missing.push("PN_POST_312_INCIDENT_EVIDENCE_PATH");

  if (env.candidateSha && env.expectedCandidateSha && env.candidateSha !== env.expectedCandidateSha) {
    missing.push("candidate SHA must exactly match PN_POST_312_INCIDENT_EXPECTED_CANDIDATE_SHA");
  }
  if (env.databaseUrl && !isFixtureOrReadOnlyDsn(env.databaseUrl)) {
    missing.push("PN_POST_312_INCIDENT_DATABASE_URL must target a read-only fixture/clone/test database");
  }
  if (env.capturedAt && Number.isNaN(Date.parse(env.capturedAt))) {
    missing.push("PN_POST_312_INCIDENT_CAPTURED_AT must be an ISO timestamp");
  }
  if (env.date && !/^\d{4}-\d{2}-\d{2}$/.test(env.date)) {
    missing.push("PN_POST_312_INCIDENT_DATE must use YYYY-MM-DD");
  }
  if (env.baselineTotalShapeFields && !/^\d+$/.test(env.baselineTotalShapeFields)) {
    missing.push("PN_POST_312_INCIDENT_BASELINE_TOTAL_SHAPE_FIELDS must be an integer");
  }
  if (env.baselineNonterminalShapeFields && !/^\d+$/.test(env.baselineNonterminalShapeFields)) {
    missing.push("PN_POST_312_INCIDENT_BASELINE_NONTERMINAL_SHAPE_FIELDS must be an integer");
  }
  if (env.baselineStatusCountsJson && !parseJson(env.baselineStatusCountsJson)) {
    missing.push("PN_POST_312_INCIDENT_BASELINE_STATUS_COUNTS_JSON must be valid JSON");
  }
  if (env.capturedAt && env.date && env.timezone && !capturedDateMatches(env.capturedAt, env.date, env.timezone)) {
    missing.push("PN_POST_312_INCIDENT_CAPTURED_AT must resolve to PN_POST_312_INCIDENT_DATE in PN_POST_312_INCIDENT_TIMEZONE");
  }
  return missing;
}

export async function runIncidentReconciliationHarness(
  env: IncidentReconciliationEnv = readIncidentReconciliationEnv(),
): Promise<IncidentReconciliationEvidence> {
  const missing = validateIncidentReconciliationEnv(env);
  if (missing.length > 0) {
    return writeBlockedIncidentEvidence(env, missing);
  }

  const pool = new Pool({ connectionString: env.databaseUrl, max: 1, statement_timeout: 15_000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const readOnly = await selectOne<{ transaction_read_only: string }>(
      client,
      "SHOW transaction_read_only",
      [],
    );
    if (readOnly.transaction_read_only !== "on") throw new Error("BLOCKED: PostgreSQL transaction is not read-only");

    const dbShape = await readIncidentShape(client, env.capturedAt!, env.date!, env.timezone!);
    const dailyAudit = await fetchDailyAudit(env);
    const readback = await readIncidentShape(client, env.capturedAt!, env.date!, env.timezone!);
    await client.query("COMMIT");

    const evidence: IncidentReconciliationEvidence = {
      [HARNESS_STATUS_FIELD]: HARNESS_PASS,
      candidateSha: env.candidateSha!,
      sourceIdentity: env.sourceIdentity!,
      capturedAt: env.capturedAt!,
      date: env.date!,
      timezone: env.timezone!,
      readOnlyTransaction: true,
      dbShape,
      dailyAudit,
      readback,
      comparisons: compareShapes(dbShape, readback, dailyAudit, env),
      target: {
        databaseUrl: redactString(env.databaseUrl!),
        apiBaseUrl: env.apiBaseUrl,
        apiKey: "[REDACTED]",
      },
    };
    await fs.writeFile(env.evidencePath!, `${redactJson(evidence)}\n`);
    return evidence;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function readIncidentShape(
  client: PoolClient,
  capturedAt: string,
  date: string,
  timezone: string,
): Promise<Record<string, unknown>> {
  const timestamp = await selectOne<{ captured_at: string }>(client, "SELECT $1::timestamptz AS captured_at", [capturedAt]);
  const dailyIncidents = await selectRows(
    client,
    `SELECT status, severity, COUNT(*)::int AS count
       FROM phone_network_incidents,
            (SELECT ($1::date::timestamp AT TIME ZONE $2) AS start_at,
                    (($1::date + 1)::timestamp AT TIME ZONE $2) AS end_at) w
      WHERE last_detected_at >= w.start_at
        AND last_detected_at < w.end_at
      GROUP BY status, severity`,
    [date, timezone],
  );
  const incidentCounts = await selectRows(
    client,
    `SELECT status, severity, COUNT(*)::int AS count
            , MIN(last_detected_at) AS oldest_last_detected_at
            , FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - MIN(last_detected_at))))::int AS oldest_age_seconds
       FROM phone_network_incidents
      WHERE last_detected_at <= $1::timestamptz
      GROUP BY status, severity
      ORDER BY status, severity`,
    [capturedAt],
  );
  const statusDistribution = await selectRows(
    client,
    `SELECT status, severity, COUNT(*)::int AS count
       FROM phone_network_incidents
      WHERE last_detected_at <= $1::timestamptz
      GROUP BY status, severity
      ORDER BY status, severity`,
    [capturedAt],
  );
  const nonterminal = await selectOne<{ count: number }>(
    client,
    `SELECT COUNT(*)::int AS count
       FROM phone_network_incidents
      WHERE last_detected_at <= $1::timestamptz
        AND lifecycle_state_matches('phone_network_incidents'::regclass, status, '{"terminal":false}'::jsonb)`,
    [capturedAt],
  );
  const openBacklog = await selectRows(
    client,
    `SELECT status, severity, COUNT(*)::int AS count
            , MIN(last_detected_at) AS oldest_last_detected_at
            , MAX(last_detected_at) AS newest_last_detected_at
       FROM phone_network_incidents
      WHERE last_detected_at <= $1::timestamptz
        AND lifecycle_state_matches('phone_network_incidents'::regclass, status, '{"terminal":false}'::jsonb)
      GROUP BY status, severity
      ORDER BY status, severity`,
    [capturedAt],
  );
  const oldestAges = await selectRows(
    client,
    `SELECT status, MIN(last_detected_at) AS oldest_last_detected_at,
            FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - MIN(last_detected_at))))::int AS oldest_age_seconds
       FROM phone_network_incidents
      WHERE last_detected_at <= $1::timestamptz
      GROUP BY status
      ORDER BY status`,
    [capturedAt],
  );
  const fieldShape = await selectOne<{ total_shape_fields: number; nonterminal_shape_fields: number }>(
    client,
    `SELECT
       COUNT(*)::int AS total_shape_fields,
       COUNT(*) FILTER (WHERE column_name NOT IN ('resolved_at', 'superseded_by_task_id', 'acknowledged_at', 'closed_at', 'terminal_reason'))::int
         AS nonterminal_shape_fields
     FROM information_schema.columns
     WHERE table_name = 'phone_network_incidents'`,
    [],
  );
  const ownerDistribution = await selectRows(
    client,
    `SELECT COALESCE(incident_commander, 'unassigned') AS incident_commander,
            COALESCE(remediation_owner, 'unassigned') AS remediation_owner,
            COUNT(*)::int AS count
       FROM phone_network_incidents
      WHERE last_detected_at <= $1::timestamptz
      GROUP BY incident_commander, remediation_owner
      ORDER BY incident_commander, remediation_owner`,
    [capturedAt],
  );

  return {
    capturedAt: timestamp.captured_at,
    date,
    timezone,
    dailyIncidents,
    incidentCounts,
    statusDistribution,
    nonterminalCount: nonterminal.count,
    openBacklog,
    oldestAges,
    ownerDistribution,
    totalShapeFields: fieldShape.total_shape_fields,
    nonterminalShapeFields: fieldShape.nonterminal_shape_fields,
  };
}

function compareShapes(
  dbShape: Record<string, unknown>,
  readback: Record<string, unknown>,
  dailyAudit: unknown,
  env: IncidentReconciliationEnv,
): Record<string, unknown> {
  const comparisons: Record<string, unknown> = {
    sameReadback: stableJson(dbShape) === stableJson(readback),
    dailyAuditOkEnvelope: isOkDailyAudit(dailyAudit),
    dateMatchesHttp: dbShape.date === httpBusinessValue(dailyAudit, "date"),
    timezoneMatchesHttp: dbShape.timezone === httpBusinessValue(dailyAudit, "timezone"),
    capturedAtMatchesHttp: timestampsEqual(dbShape.capturedAt, httpBusinessValue(dailyAudit, "capturedAt")),
    dailyIncidentsMatchHttp: stableJson(dbShape.dailyIncidents) === stableJson(httpBusinessValue(dailyAudit, "incidents")),
    openBacklogMatchesHttp: stableJson(dbShape.openBacklog) === stableJson(httpBusinessValue(dailyAudit, "openIncidentBacklog")),
    totalsMatchHttp: stableJson(dbShape.incidentCounts) === stableJson(httpBusinessValue(dailyAudit, "incidentCounts")),
    nonterminalMatchesHttp: dbShape.nonterminalCount === httpBusinessValue(dailyAudit, "nonterminalCount"),
    statusDistributionMatchesHttp: stableJson(dbShape.statusDistribution) === stableJson(httpBusinessValue(dailyAudit, "statusDistribution")),
    oldestAgesMatchHttp: stableJson(dbShape.oldestAges) === stableJson(httpBusinessValue(dailyAudit, "oldestAges")),
    ownerDistributionMatchesHttp: stableJson(dbShape.ownerDistribution) === stableJson(httpBusinessValue(dailyAudit, "ownerDistribution")),
    statusBacklogSemantics: "daily findings are policy anomalies for the date window; backlog is nonterminal incident state as of the same captured timestamp",
  };
  if (env.baselineTotalShapeFields) {
    comparisons.totalShapeFieldsMatch = dbShape.totalShapeFields === Number(env.baselineTotalShapeFields);
  }
  if (env.baselineNonterminalShapeFields) {
    comparisons.nonterminalShapeFieldsMatch = dbShape.nonterminalShapeFields === Number(env.baselineNonterminalShapeFields);
  }
  if (env.baselineStatusCountsJson) {
    comparisons.statusCountsMatch = stableJson(dbShape.incidentCounts) === stableJson(parseJson(env.baselineStatusCountsJson));
  }
  if (Object.entries(comparisons).some(([key, value]) => key !== "statusBacklogSemantics" && value !== true)) {
    throw new Error(`BLOCKED: incident reconciliation comparison failed: ${redactJson(comparisons)}`);
  }
  return comparisons;
}

async function fetchDailyAudit(env: IncidentReconciliationEnv): Promise<unknown> {
  const url = new URL("/api/audits/daily", env.apiBaseUrl);
  url.searchParams.set("date", env.date!);
  url.searchParams.set("timezone", env.timezone!);
  url.searchParams.set("capturedAt", env.capturedAt!);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${env.apiKey}`,
      "x-source-identity": env.sourceIdentity!,
      "x-candidate-sha": env.candidateSha!,
    },
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`BLOCKED: daily audit response was not JSON: ${redactString(text.slice(0, 500))}`);
  }
  if (!response.ok) {
    throw new Error(`BLOCKED: daily audit HTTP ${response.status}: ${redactJson(payload)}`);
  }
  return redact(payload);
}

async function selectRows<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  values: unknown[],
): Promise<T[]> {
  if (!SELECT_ONLY.test(sql)) throw new Error(`BLOCKED: non-SELECT SQL refused by harness: ${sql.slice(0, 32)}`);
  const result = await client.query<T>(sql, values);
  return result.rows;
}

async function selectOne<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  values: unknown[],
): Promise<T> {
  const rows = await selectRows<T>(client, sql, values);
  const row = rows[0];
  if (!row) throw new Error("BLOCKED: expected one read-only row");
  return row;
}

function isOkDailyAudit(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && (value as Record<string, unknown>).ok === true
    && !!(value as Record<string, unknown>).data;
}

function httpBusinessValue(dailyAudit: unknown, key: string): unknown {
  if (!dailyAudit || typeof dailyAudit !== "object") return undefined;
  const data = (dailyAudit as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return undefined;
  return (data as Record<string, unknown>)[key];
}

function isFixtureOrReadOnlyDsn(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return /^(127\.0\.0\.1|localhost)$/i.test(parsed.hostname)
      && /(fixture|clone|test|pg17|pnq|readonly|read_only)/i.test(`${parsed.pathname} ${parsed.search}`);
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForComparison(value));
}

function normalizeForComparison(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalizeForComparison(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeForComparison(entry)]),
  );
}

function timestampsEqual(left: unknown, right: unknown): boolean {
  const leftTime = typeof left === "string" || left instanceof Date ? new Date(left).getTime() : Number.NaN;
  const rightTime = typeof right === "string" || right instanceof Date ? new Date(right).getTime() : Number.NaN;
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

async function writeBlockedIncidentEvidence(
  env: IncidentReconciliationEnv,
  reasons: string[],
): Promise<IncidentReconciliationEvidence> {
  const evidence: IncidentReconciliationEvidence = {
    [HARNESS_STATUS_FIELD]: HARNESS_BLOCKED,
    candidateSha: env.candidateSha,
    sourceIdentity: env.sourceIdentity,
    capturedAt: env.capturedAt,
    date: env.date,
    timezone: env.timezone,
    readOnlyTransaction: false,
    blockedReasons: reasons.map((reason) => redactString(reason)),
    dbShape: {},
    dailyAudit: null,
    readback: {},
    comparisons: {},
    target: {
      databaseUrl: env.databaseUrl ? redactString(env.databaseUrl) : undefined,
      apiBaseUrl: env.apiBaseUrl,
      apiKey: env.apiKey ? "[REDACTED]" : undefined,
    },
  };
  if (env.evidencePath) await fs.writeFile(env.evidencePath, `${redactJson(evidence)}\n`);
  return evidence;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function capturedDateMatches(capturedAt: string, date: string, timezone: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(capturedAt));
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}` === date;
  } catch {
    return false;
  }
}

if (require.main === module) {
  runIncidentReconciliationHarness()
    .then((evidence) => {
      process.stdout.write(`${redactJson({ [HARNESS_STATUS_FIELD]: evidence.status, evidencePath: process.env.PN_POST_312_INCIDENT_EVIDENCE_PATH })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${redactString((error as Error).message)}\n`);
      process.exitCode = 2;
    });
}
