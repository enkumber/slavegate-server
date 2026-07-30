import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Pool } from "pg";
import { runCloneHttpE2eHarness } from "./clone-egress-deny";
import { runIncidentReconciliationHarness } from "./incident-reconciliation-harness";
import { HARNESS_BLOCKED, HARNESS_PASS, redactJson, redactString } from "./redaction";

const pgBin = process.env.PN_POST_312_PG17_BIN ?? "/data/.openclaw/tools/postgresql-17.10/bin";
const reportDir = process.env.PN_POST_312_EVIDENCE_DIR
  ?? path.join(process.cwd(), "reports/post-3.9.312-defect-class-consolidation/e2e");

async function main(): Promise<void> {
  await fs.mkdir(reportDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const candidateSha = git(["rev-parse", "HEAD"]);
  const sourceIdentity = `post312-local-pg17-${candidateSha.slice(0, 12)}`;
  const pg = await startPg17();
    const dsn = `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:${pg.port}/post312_fixture_pg17`;
  const ledger: Record<string, unknown> = {
    status: HARNESS_BLOCKED,
    startedAt,
    candidateSha,
    sourceIdentity,
    commands: [] as Array<Record<string, unknown>>,
    artifacts: {},
  };

  try {
    await run(`${path.join(pgBin, "createdb")} -h 127.0.0.1 -p ${pg.port} post312_fixture_pg17`, ledger);
    await seedFixture(dsn);

    const clonePath = path.join(reportDir, "clone-http-e2e-local-pg17.json");
    const incidentPath = path.join(reportDir, "incident-reconciliation-local-pg17.json");
    const commonDate = "2026-07-30";
    const capturedAt = "2026-07-30T08:00:00Z";
    const launchCommand = "node -r tsx/cjs src/harness/post-3-9-312/fixture-candidate-server.ts";

    const cloneEvidence = await runCloneHttpE2eHarness({
      candidateSha,
      fixtureDatabaseUrl: dsn,
      sourceIdentity,
      apiKey: "fixture-secret-token",
      launchCommand,
      egressDeny: "true",
      egressCapturePath: clonePath,
      cleanCheckoutCommand: "git clone <repo> post312-clean && cd post312-clean && git checkout <candidate-sha> && npm ci && npm run post312:fixture-gates",
      ingressPath: `/api/audits/daily?date=${commonDate}&timezone=UTC&capturedAt=${encodeURIComponent(capturedAt)}`,
      restartPath: "/__post312/restart",
      conflictPath: "/__post312/conflict",
      replayCount: "2",
      concurrency: "3",
    });
    (ledger.commands as Array<Record<string, unknown>>).push({ command: "runCloneHttpE2eHarness", status: cloneEvidence.status, assertions: cloneEvidence.assertions });

    const incidentServer = await launchFixtureCandidate(launchCommand, candidateSha, sourceIdentity, dsn);
    try {
      const incidentEvidence = await runIncidentReconciliationHarness({
        candidateSha,
        expectedCandidateSha: candidateSha,
        sourceIdentity,
        capturedAt,
        date: commonDate,
        timezone: "UTC",
        databaseUrl: dsn,
        apiBaseUrl: incidentServer.apiBaseUrl,
        apiKey: "fixture-secret-token",
        evidencePath: incidentPath,
        baselineTotalShapeFields: "16",
        baselineNonterminalShapeFields: "11",
      });
      (ledger.commands as Array<Record<string, unknown>>).push({ command: "runIncidentReconciliationHarness", status: incidentEvidence.status, comparisons: incidentEvidence.comparisons });

      ledger.status = cloneEvidence.status === HARNESS_PASS && incidentEvidence.status === HARNESS_PASS
        ? HARNESS_PASS
        : HARNESS_BLOCKED;
    } finally {
      await incidentServer.stop();
    }
    ledger.artifacts = { clonePath, incidentPath };
  } finally {
    await stopPg17(pg);
    ledger.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(reportDir, "local-fixture-gate-ledger.json"), `${redactJson(ledger)}\n`);
  }
}

async function seedFixture(dsn: string): Promise<void> {
  const pool = new Pool({ connectionString: dsn, max: 2 });
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
    `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION lifecycle_state_matches(resource_table REGCLASS, current_status TEXT, selector JSONB)
    RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
      SELECT COALESCE((
        SELECT (NOT selector ? 'terminal' OR definition.terminal = (selector->>'terminal')::boolean)
          FROM lifecycle_resource_bindings binding
          JOIN lifecycle_state_definitions definition
            ON definition.lifecycle_key = binding.lifecycle_key
           AND definition.status = current_status
         WHERE binding.resource_table = $1
      ), FALSE)
    $$;
    INSERT INTO lifecycle_state_definitions (lifecycle_key, status, terminal, dispatchable)
    VALUES ('incident_lifecycle', 'investigating', FALSE, FALSE),
           ('incident_lifecycle', 'triaged', FALSE, FALSE),
           ('incident_lifecycle', 'resolved', TRUE, FALSE);
    INSERT INTO lifecycle_resource_bindings (resource_table, state_column, lifecycle_key)
    VALUES ('phone_network_incidents'::regclass, 'status', 'incident_lifecycle');
    INSERT INTO phone_network_incidents
      (id, status, severity, incident_key, source_type, source_id, task_id, device_id, incident_commander, remediation_owner, last_detected_at)
    VALUES
      ('11111111-1111-4111-8111-111111111111', 'investigating', 'high', 'task:1', 'task', '1', '1', 'fixture-device-a', 'alice', 'platform', '2026-07-30T07:00:00Z'),
      ('22222222-2222-4222-8222-222222222222', 'investigating', 'medium', 'task:2', 'task', '2', '2', 'fixture-device-b', 'bob', 'runtime', '2026-07-30T07:30:00Z'),
      ('33333333-3333-4333-8333-333333333333', 'resolved', 'low', 'task:3', 'task', '3', '3', 'fixture-device-c', 'alice', 'platform', '2026-07-30T07:40:00Z');
  `);
  await pool.end();
}

async function startPg17(): Promise<{ dir: string; port: number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "post312-pg17-"));
  const port = 55432 + Math.floor(Math.random() * 5000);
  await runCommand(path.join(pgBin, "initdb"), ["-D", dir, "-A", "trust"]);
  await runCommand(path.join(pgBin, "pg_ctl"), ["-D", dir, "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
  return { dir, port };
}

async function stopPg17(pg: { dir: string }): Promise<void> {
  await runCommand(path.join(pgBin, "pg_ctl"), ["-D", pg.dir, "-m", "fast", "-w", "stop"]).catch(() => undefined);
  await fs.rm(pg.dir, { recursive: true, force: true });
}

async function run(command: string, ledger: Record<string, unknown>): Promise<void> {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  (ledger.commands as Array<Record<string, unknown>>).push({
    command: redactString(command),
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    stdout: redactString(result.stdout.slice(-2000)),
    stderr: redactString(result.stderr.slice(-2000)),
  });
  if (result.status !== 0) throw new Error(`command failed: ${command}`);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function launchFixtureCandidate(
  command: string,
  candidateSha: string,
  sourceIdentity: string,
  databaseUrl: string,
): Promise<{ apiBaseUrl: string; stop: () => Promise<void> }> {
  const port = 58000 + Math.floor(Math.random() * 1000);
  const child = spawn(command, {
    shell: true,
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PN_POST_312_CLONE_CANDIDATE_SHA: candidateSha,
      PN_POST_312_CLONE_SOURCE_IDENTITY: sourceIdentity,
      PN_POST_312_CLONE_DATABASE_URL: databaseUrl,
      PN_POST_312_CLONE_EGRESS_DENY: "true",
    },
  });
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture candidate exited ${child.exitCode}`);
    try {
      const response = await fetch(`${apiBaseUrl}/__post312/identity`, {
        headers: {
          authorization: "Bearer fixture-secret-token",
          "x-source-identity": sourceIdentity,
          "x-candidate-sha": candidateSha,
        },
      });
      if (response.ok) return { apiBaseUrl, stop: () => stopChild(child) };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("fixture candidate did not become ready");
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${redactString((error as Error).stack ?? (error as Error).message)}\n`);
  process.exit(2);
});
