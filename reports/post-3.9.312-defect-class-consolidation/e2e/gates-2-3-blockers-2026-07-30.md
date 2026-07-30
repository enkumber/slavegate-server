# Gates 2 and 3 blocker evidence

Story: `STORY-PN-POST-3-9-312-DEFECT-CLASS-CONSOLIDATION-AUDIT-001`
Worktree: `/data/worktrees/phone-network-post-3.9.312-defect-class-audit`
Branch: `audit/post-3.9.312-defect-class-consolidation`
Candidate before this report: `ff08a27eab689b8ca02075b8dc0d5370565ade7e`
Baseline/live identity under audit: `3.9.312` / `505f3cddb707bef1dcd510ebde4edd966b245ca9`
Freeze attestation: no publish, deploy, Umbrel bump, live restart, live DB mutation, phone/ADB action, or Dan update request was performed.

## Gate 2: live-derived clone HTTP E2E with egress capture

Status: blocked.

Concrete blocker:

- No reachable live-derived snapshot/export source or approved disposable clone DSN is available in this session.
- The only located live DB source is `/data/.openclaw/workspace/slavegate/server/.env:DATABASE_URL`.
- That source is not an approved clone URL, and it is not reachable from this OpenClaw container.
- Docker/container control is not exposed here, so this session cannot enter the live app network or create/restore the disposable PG17 clone from the Umbrel runtime.
- No runnable egress-capture harness is present for this exact candidate that can deny DNS/HTTP/WebSocket/VLM/device dispatch at the process/container boundary while exercising mutating HTTP flows against a clone.

Evidence commands run:

```bash
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' /data/.openclaw/workspace/slavegate/server/.env | sort | grep -E 'DATABASE|PG|PNQ|PHONE|LIVE|SNAPSHOT|POSTGRES|READ'
```

Result: `DATABASE_URL` exists; no `PNQ001_PG_URL`, read-only URL, snapshot URL, or clone URL was present.

```bash
docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'
```

Result: no Docker/container control was available from this session.

Command to run once FORGE/ATLAS provides a live-derived snapshot/export source and clone target:

```bash
LIVE_SNAPSHOT_SOURCE='<approved read-only pg_dump/export source or snapshot path>' \
CLONE_DATABASE_URL='<disposable PG17 clone URL>' \
PN_PROMOTION_GATE_EGRESS_CAPTURE=enabled \
PN_PROMOTION_GATE_NETWORK_DENY=enabled \
PN_PROMOTION_GATE_CAPTURE_DIR='reports/post-3.9.312-defect-class-consolidation/e2e/http-transcripts' \
EGRESS_CAPTURE_FILE='reports/post-3.9.312-defect-class-consolidation/e2e/promotion-egress.ndjson' \
npx vitest run tests/promotion-gate/live-derived-http-e2e.integration.test.ts
```

Required harness step before that command is meaningful:

- Restore the provided source into an isolated PG17 database.
- Start the exact candidate SHA against only that clone DB.
- Deny outbound network at the process/container boundary.
- Route DNS, HTTP, WebSocket, VLM, and device dispatch sinks to capture files.
- Exercise real HTTP ingress for incident daily audit/readback, compile/readback, recovery/replay/conflict, restart, and duplicate/concurrent paths.
- Confirm the egress capture remains zero and seal HTTP transcripts plus DB before/after manifests.

## Gate 3: same-timestamp incident reconciliation

Status: blocked from this session.

Required baseline from assignment:

- 59 incidents total.
- 5 resolved.
- 54 nonterminal.
- 31 acknowledged.
- 23 investigating.
- oldest nonterminal date `2026-07-23`.
- remediation owners: hydra 37, nautilus 14, nox 5, null 3.

Read-only DB command attempted:

```bash
node - <<'NODE'
const { Pool } = require('pg');
require('dotenv').config({ path: '/data/.openclaw/workspace/slavegate/server/.env' });
(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    statement_timeout: 15000,
    query_timeout: 15000,
    application_name: 'spark_lane_b_readonly_reconcile'
  });
  const client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE lifecycle_state_matches('phone_network_incidents'::regclass, status, '{"terminal":true}'::jsonb))::int AS terminal,
           COUNT(*) FILTER (WHERE NOT lifecycle_state_matches('phone_network_incidents'::regclass, status, '{"terminal":true}'::jsonb))::int AS nonterminal,
           COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
           COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
           COUNT(*) FILTER (WHERE status = 'investigating')::int AS investigating,
           MIN(last_detected_at) FILTER (WHERE NOT lifecycle_state_matches('phone_network_incidents'::regclass, status, '{"terminal":true}'::jsonb)) AS oldest_nonterminal_last_detected_at
      FROM phone_network_incidents
  `);
  await client.query(`
    SELECT remediation_owner AS owner, COUNT(*)::int AS count
      FROM phone_network_incidents
     GROUP BY remediation_owner
     ORDER BY count DESC, owner NULLS LAST
  `);
  await client.query('COMMIT');
  await pool.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

Result: failed before any read-only transaction could be opened:

```text
connect EHOSTUNREACH 10.21.0.21:5432
```

HTTP daily audit/readback command attempted:

```bash
node - <<'NODE'
require('dotenv').config({ path: '/data/.openclaw/workspace/slavegate/server/.env' });
(async () => {
  const port = process.env.PORT || '3000';
  const url = `http://127.0.0.1:${port}/api/audits/daily?date=2026-07-30&timezone=Europe%2FBucharest`;
  const res = await fetch(url, { headers: { 'x-api-key': process.env.API_KEY || '' } });
  console.log(res.status, await res.text());
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

Result: failed before an HTTP status was returned:

```text
fetch failed for http://127.0.0.1:18791/api/audits/daily?date=2026-07-30&timezone=Europe%2FBucharest
```

Command to run once a reachable read-only live source or approved same-timestamp source is available:

```bash
READONLY_DATABASE_URL='<reachable production read-only URL or approved same-timestamp source>' \
LIVE_AUDIT_BASE_URL='<reachable live HTTP base URL>' \
LIVE_AUDIT_API_KEY='<read-only monitoring/admin token>' \
node reports/post-3.9.312-defect-class-consolidation/harness/incident-reconcile-readonly.mjs \
  > reports/post-3.9.312-defect-class-consolidation/e2e/incident-reconciliation-2026-07-30.json
```

The harness must:

- capture one timestamp before DB and HTTP reads;
- set `BEGIN READ ONLY` and run `SELECT` only;
- compare DB totals/status/owner/oldest-nonterminal values to the required 59/54 baseline;
- GET `/api/audits/daily?date=2026-07-30&timezone=Europe%2FBucharest`;
- compare HTTP `openIncidentBacklog` to the same DB snapshot;
- redact credentials and record source identity without secrets.

## Current verdict

Gate 2 remains open because clone provenance and egress-capture execution are unavailable.
Gate 3 remains open because this session cannot reach either PostgreSQL or live HTTP from its container network, so it cannot produce a same-timestamp read-only reconciliation.
