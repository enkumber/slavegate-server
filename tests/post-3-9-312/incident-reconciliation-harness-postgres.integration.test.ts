import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runIncidentReconciliationHarness,
  validateIncidentReconciliationEnv,
} from "../../src/harness/post-3-9-312/incident-reconciliation-harness";

const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool | undefined;
let pool: Pool | undefined;
let schema = "";
let server: http.Server;
let serverUrl = "";
let lastRequest: { method?: string; url?: string; authorization?: string; sourceIdentity?: string } = {};
let pg17Ready = false;

describe("post-3.9.312 incident reconciliation harness", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }

    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    let version;
    try {
      version = await adminPool.query<{ server_version_num: string }>("SHOW server_version_num");
    } catch {
      await adminPool.end();
      adminPool = undefined;
      return;
    }
    if (Number(version.rows[0]?.server_version_num ?? 0) < 170000) return;
    pg17Ready = true;

    schema = `incident_recon_harness_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(postgresUrl);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: isolated.toString(), max: 2 });

    await pool.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        terminal BOOLEAN NOT NULL DEFAULT FALSE,
        dispatchable BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE lifecycle_resource_bindings (
        resource_table REGCLASS NOT NULL,
        state_column NAME NOT NULL,
        lifecycle_key TEXT NOT NULL
      );
      CREATE TABLE phone_network_incidents (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        incident_key TEXT,
        source_type TEXT,
        source_id TEXT,
        task_id TEXT,
        device_id TEXT,
        incident_commander TEXT,
        remediation_owner TEXT,
        last_detected_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        superseded_by_task_id TEXT,
        acknowledged_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        terminal_reason TEXT
      );
      CREATE OR REPLACE FUNCTION lifecycle_state_matches(
        resource_table REGCLASS,
        current_status TEXT,
        selector JSONB
      ) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT COALESCE((
          SELECT (NOT selector ? 'terminal'
                    OR definition.terminal = (selector->>'terminal')::boolean)
            FROM lifecycle_resource_bindings binding
            JOIN lifecycle_state_definitions definition
              ON definition.lifecycle_key = binding.lifecycle_key
             AND definition.status = current_status
           WHERE binding.resource_table = $1
        ), FALSE)
      $$;
      INSERT INTO lifecycle_state_definitions (lifecycle_key, status, terminal, dispatchable)
      VALUES ('incident_lifecycle', 'investigating', FALSE, FALSE),
             ('incident_lifecycle', 'resolved', TRUE, FALSE);
      INSERT INTO lifecycle_resource_bindings (resource_table, state_column, lifecycle_key)
      VALUES ('phone_network_incidents'::regclass, 'status', 'incident_lifecycle');
      INSERT INTO phone_network_incidents (id, status, severity, incident_key, source_type, source_id, task_id, device_id, incident_commander, remediation_owner, last_detected_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'investigating', 'medium', 'task:1', 'task', '1', '1', 'fixture-device', 'fixture-commander', 'fixture-owner', '2026-07-30T07:30:00Z'),
             ('22222222-2222-4222-8222-222222222222', 'resolved', 'medium', 'task:2', 'task', '2', '2', 'fixture-device', 'fixture-commander', 'fixture-owner', '2026-07-30T07:35:00Z');
    `);

    server = http.createServer((req, res) => {
      lastRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        sourceIdentity: String(req.headers["x-source-identity"] ?? ""),
      };
      if (req.method !== "GET" || !req.url?.startsWith("/api/audits/daily?")) {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unexpected route" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        data: {
          date: "2026-07-30",
          timezone: "UTC",
          capturedAt: "2026-07-30T08:00:00.000Z",
          incidents: [
            { status: "investigating", severity: "medium", count: 1 },
            { status: "resolved", severity: "medium", count: 1 },
          ],
          openIncidentBacklog: [{
            status: "investigating",
            severity: "medium",
            count: 1,
            oldest_last_detected_at: "2026-07-30T07:30:00.000Z",
            newest_last_detected_at: "2026-07-30T07:30:00.000Z",
          }],
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("fails closed before touching network or DB when mandatory config is absent", async () => {
    const blockedPath = path.join(os.tmpdir(), `incident-recon-blocked-${process.pid}-${Date.now()}.json`);
    expect(validateIncidentReconciliationEnv({})).toContain("PN_POST_312_INCIDENT_CANDIDATE_SHA");
    const blocked = await runIncidentReconciliationHarness({
      candidateSha: "a",
      expectedCandidateSha: "b",
      sourceIdentity: "fixture-source\nAuthorization: Bearer leaked",
      capturedAt: "2026-07-30T08:00:00Z",
      date: "2026-07-30",
      timezone: "UTC",
      databaseUrl: "postgresql://pnqtest:secret@127.0.0.1:55432/pnq001_test",
      apiBaseUrl: "http://127.0.0.1:1",
      apiKey: "secret",
      evidencePath: blockedPath,
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockedReasons).toContain("candidate SHA must exactly match PN_POST_312_INCIDENT_EXPECTED_CANDIDATE_SHA");
    const persisted = await fs.readFile(blockedPath, "utf8");
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain("Bearer leaked");
  });

  it("uses BEGIN READ ONLY, SELECT-only database reads, one timestamp, and HTTP GET daily audit", async () => {
    if (!pg17Ready) return;
    const evidencePath = path.join(os.tmpdir(), `incident-recon-${process.pid}-${Date.now()}.json`);
    const isolated = new URL(postgresUrl);
    isolated.searchParams.set("options", `-c search_path=${schema}`);

    const evidence = await runIncidentReconciliationHarness({
      candidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e",
      expectedCandidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e",
      sourceIdentity: "forge-local-pg17-fixture",
      capturedAt: "2026-07-30T08:00:00Z",
      date: "2026-07-30",
      timezone: "UTC",
      databaseUrl: isolated.toString(),
      apiBaseUrl: serverUrl,
      apiKey: "fixture-secret-token",
      evidencePath,
      baselineTotalShapeFields: "16",
      baselineNonterminalShapeFields: "11",
      baselineStatusCountsJson: JSON.stringify([
        { status: "investigating", severity: "medium", count: 1, oldest_last_detected_at: "2026-07-30T07:30:00.000Z", oldest_age_seconds: 1800 },
        { status: "resolved", severity: "medium", count: 1, oldest_last_detected_at: "2026-07-30T07:35:00.000Z", oldest_age_seconds: 1500 },
      ]),
    });

    expect(evidence.status).toBe("PASS");
    expect(evidence.readOnlyTransaction).toBe(true);
    expect(evidence.comparisons).toMatchObject({
      sameReadback: true,
      dailyAuditOkEnvelope: true,
      dateMatchesHttp: true,
      timezoneMatchesHttp: true,
      capturedAtMatchesHttp: true,
      dailyIncidentsMatchHttp: true,
      openBacklogMatchesHttp: true,
      totalShapeFieldsMatch: true,
      nonterminalShapeFieldsMatch: true,
      statusCountsMatch: true,
    });
    expect(evidence.comparisons.statusBacklogSemantics).toContain("daily findings");
    expect(evidence.dbShape.ownerDistribution).toEqual([{
      incident_commander: "fixture-commander",
      remediation_owner: "fixture-owner",
      count: 2,
    }]);
    expect(lastRequest).toMatchObject({
      method: "GET",
      sourceIdentity: "forge-local-pg17-fixture",
    });
    expect(lastRequest.url).toContain("/api/audits/daily?");
    expect(lastRequest.authorization).toBe("Bearer fixture-secret-token");

    const persisted = await fs.readFile(evidencePath, "utf8");
    expect(persisted).not.toContain("fixture-secret-token");
    expect(persisted).not.toContain("pnqtest:");
    expect(JSON.parse(persisted)).toMatchObject({ status: "PASS" });
  });
});
