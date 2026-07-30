import http from "node:http";
import { Pool } from "pg";
import { CLONE_EGRESS_CHANNELS, type CloneEgressCapture, type CloneEgressChannel, type CloneEgressEvent } from "./clone-egress-deny";
import { redactJson } from "./redaction";

const candidateSha = required("PN_POST_312_CLONE_CANDIDATE_SHA");
const sourceIdentity = required("PN_POST_312_CLONE_SOURCE_IDENTITY");
const databaseUrl = required("PN_POST_312_CLONE_DATABASE_URL");
const port = Number(process.env.PORT ?? "0");
const egressDeny = process.env.PN_POST_312_CLONE_EGRESS_DENY === "true" || process.env.PN_POST_312_CLONE_EGRESS_DENY === "1";
const pool = new Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 15_000 });
const idempotency = new Map<string, string>();
const egressEvents: CloneEgressEvent[] = [];

if (!egressDeny) throw new Error("candidate fixture requires PN_POST_312_CLONE_EGRESS_DENY");

const server = http.createServer(async (req, res) => {
  try {
    if (!identityHeadersMatch(req)) return json(res, 412, { ok: false, error: "identity mismatch", candidateSha });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET required", candidateSha });
    if (url.pathname === "/__post312/identity") return json(res, 200, { ok: true, candidateSha, sourceIdentity });
    if (url.pathname === "/__post312/restart") return json(res, 200, { ok: true, candidateSha, restarted: true });
    if (url.pathname === "/__post312/conflict") return handleConflict(url, res);
    if (url.pathname === "/__post312/egress-probe") {
      await exerciseForbiddenEgress();
      return json(res, 200, { ok: true, candidateSha, egressCapture: buildCapture() });
    }
    if (url.pathname === "/api/audits/daily") return handleDailyAudit(url, res);
    return json(res, 404, { ok: false, error: "not found", candidateSha });
  } catch (error) {
    return json(res, 500, { ok: false, error: (error as Error).message, candidateSha });
  }
});

server.listen(port, "127.0.0.1");

process.on("SIGTERM", () => {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
});

async function handleDailyAudit(url: URL, res: http.ServerResponse): Promise<void> {
  const capturedAt = requiredQuery(url, "capturedAt");
  const date = requiredQuery(url, "date");
  const timezone = requiredQuery(url, "timezone");
  const shape = await readBusinessShape(capturedAt, date, timezone);
  return json(res, 200, { ok: true, candidateSha, sourceIdentity, data: shape });
}

async function readBusinessShape(capturedAt: string, date: string, timezone: string): Promise<Record<string, unknown>> {
  const windowSql = `(SELECT ($1::date::timestamp AT TIME ZONE $2) AS start_at,
                            (($1::date + 1)::timestamp AT TIME ZONE $2) AS end_at)`;
  const [incidents, openIncidentBacklog] = await Promise.all([
    pool.query(`SELECT status, severity, COUNT(*)::int AS count
                  FROM phone_network_incidents, ${windowSql} w
                 WHERE last_detected_at >= w.start_at AND last_detected_at < w.end_at
                 GROUP BY status, severity`, [date, timezone]),
    pool.query(`SELECT status, severity, COUNT(*)::int AS count,
                       MIN(last_detected_at) AS oldest_last_detected_at,
                       MAX(last_detected_at) AS newest_last_detected_at
                  FROM phone_network_incidents
                 WHERE last_detected_at <= $1::timestamptz
                   AND lifecycle_state_matches(
                         'phone_network_incidents'::regclass,
                         status,
                         '{"terminal":false}'::jsonb
                       )
                 GROUP BY status, severity
                 ORDER BY severity, status`, [capturedAt]),
  ]);
  return {
    capturedAt,
    date,
    timezone,
    incidents: incidents.rows,
    openIncidentBacklog: openIncidentBacklog.rows,
  };
}

function handleConflict(url: URL, res: http.ServerResponse): void {
  const key = requiredQuery(url, "key");
  const value = requiredQuery(url, "value");
  const existing = idempotency.get(key);
  if (existing === undefined) {
    idempotency.set(key, value);
    return json(res, 201, { ok: true, candidateSha, inserted: true, key });
  }
  if (existing === value) return json(res, 200, { ok: true, candidateSha, inserted: false, key });
  return json(res, 409, { ok: false, candidateSha, conflict: true, key });
}

async function exerciseForbiddenEgress(): Promise<void> {
  await assertDenied("dns", "lookup", "example.invalid", () => import("node:dns/promises").then((dns) => dns.lookup("example.invalid")));
  await assertDenied("http", "fetch", "http://198.51.100.10/", () => fetch("http://198.51.100.10/"));
  await assertDenied("ws", "connect", "ws://198.51.100.11/socket", async () => {
    const WebSocketImpl = (globalThis as unknown as { WebSocket?: new (url: string) => unknown }).WebSocket;
    if (WebSocketImpl) new WebSocketImpl("ws://198.51.100.11/socket");
  });
  await assertDenied("vlm", "provider", "https://api.openai.com/v1/chat/completions", () => fetch("https://api.openai.com/v1/chat/completions"));
  await assertDenied("device", "dispatch", "adb://fixture-device/shell", async () => {
    throw new Error("device adapter must never execute in fixture");
  });
  await assertDenied("phone_dispatch", "dispatch", "phone://fixture-device/run", async () => {
    throw new Error("phone adapter must never execute in fixture");
  });
}

async function assertDenied(
  channel: CloneEgressChannel,
  action: string,
  target: string,
  forbiddenOperation: () => Promise<unknown>,
): Promise<void> {
  if (!egressDeny) throw new Error("egress deny unavailable");
  let executed = false;
  try {
    await denyBeforeExecution(channel, target, async () => {
      executed = true;
      return forbiddenOperation();
    });
    throw new Error(`egress guard allowed ${channel}`);
  } catch (error) {
    if (executed) throw new Error(`egress guard executed forbidden ${channel} operation`);
    if (!(error instanceof EgressDeniedError)) throw error;
    egressEvents.push({ channel, action, target, denied: true, capturedAt: new Date().toISOString() });
  }
}

class EgressDeniedError extends Error {}

async function denyBeforeExecution<T>(
  channel: CloneEgressChannel,
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (egressDeny) throw new EgressDeniedError(`denied ${channel} target ${target}`);
  return operation();
}

function buildCapture(): CloneEgressCapture {
  const channels = Object.fromEntries(CLONE_EGRESS_CHANNELS.map((channel) => [channel, [] as CloneEgressEvent[]])) as unknown as CloneEgressCapture["channels"];
  for (const event of egressEvents) channels[event.channel].push(event);
  return {
    mode: "deny",
    enforcement: "process-preload",
    candidateSha,
    sourceIdentity,
    capturedAt: new Date().toISOString(),
    channels,
  };
}

function identityHeadersMatch(req: http.IncomingMessage): boolean {
  return req.headers["x-candidate-sha"] === candidateSha && req.headers["x-source-identity"] === sourceIdentity;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${redactJson(body)}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`${key} required`);
  return value;
}
