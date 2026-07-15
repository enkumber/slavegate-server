# PNQ-001 G1-C Evidence Matrix

Scope: SPARK-owned server-only evidence. No production, migration, package, PNEX, Android, push, deploy, live restart, cron, or device edits.

## Startup Confirmation

First command:

```bash
pwd
```

Result:

```text
/data/worktrees/slavegate-pnq-001-server
```

Repository confirmation before edits:

```text
branch: feature/pnq-001-server-device-queue
HEAD: 3a16268
status --short: clean
```

## Commands Run Locally

```bash
npx vitest run tests/pnq-001/static-egress-guard.test.ts
```

Result: passed, 1 file / 3 tests.

```bash
npx vitest run tests/pnq-001/device-execution-postgres.integration.test.ts
```

Result: passed as a safe skip, 1 file / 7 tests skipped because `PNQ001_PG_URL` is not set.

Local PostgreSQL tooling check:

```text
which psql: not found
which postgres: not found
which docker: not found
env | rg '^(DATABASE_URL|POSTGRES|PG|PNQ)': no matches
```

Because this container has no local PostgreSQL server, PostgreSQL CLI, Docker, or PNQ test database URL, the real-PostgreSQL harness could be compiled but not executed against a live database in this run.

## Real-PostgreSQL Harness Command

Use a disposable database whose name includes `pnq` and `test`, `pnq001`, `vitest`, or `tmp`. The test refuses to reset any other database name and refuses to reuse `DATABASE_URL`.

```bash
PNQ001_PG_URL=postgresql://USER:PASSWORD@HOST:5432/pnq001_test \
  npx vitest run tests/pnq-001/device-execution-postgres.integration.test.ts
```

The harness drops and recreates only `devices`, `device_execution_roots`, and `device_execution_events` in that disposable database, then applies `src/db/migrations/081_device_execution_queue.sql`.

## Test Matrix

| Requirement | Harness / evidence | Local result | Notes |
| --- | --- | --- | --- |
| Semantic static bypass guard | `tests/pnq-001/static-egress-guard.test.ts` parses TypeScript AST for calls/declarations and ignores comments/strings | Passed | Added `directWsServer.sendJob` baseline entry for the internal facade edge missed by the old regex scan. |
| 100 FIFO admissions | `device-execution-postgres.integration.test.ts` admits 100 job roots, verifies FIFO sequence, drains through claim/dispatch/terminal, and checks `maxActive <= 1` | Compiled, skipped without `PNQ001_PG_URL` | Deterministic sequential admissions; two-worker concurrency covered separately. |
| Two devices parallel | Same PostgreSQL harness claims roots for two devices concurrently and verifies two active roots total, one per device | Compiled, skipped without `PNQ001_PG_URL` | Proves active uniqueness is scoped per device. |
| Two-worker single claim | Same PostgreSQL harness races two arbiters against one queued root and expects exactly one permit plus one null | Compiled, skipped without `PNQ001_PG_URL` | Uses PostgreSQL advisory lock and active-slot uniqueness. |
| Crash/restart ambiguity | Same PostgreSQL harness dispatches a root, marks it `reconciling`, instantiates a new arbiter, and verifies the successor remains queued | Compiled, skipped without `PNQ001_PG_URL` | Simulates restart ambiguity because no production startup reconciliation hook exists. |
| Terminal CAS rejection | Same PostgreSQL harness audits wrong-device rejection and duplicate terminal rejection/ignore without overwriting terminal state | Compiled, skipped without `PNQ001_PG_URL` | Stale-generation rejection requires the separately owned production terminal handle/owner-generation path. |
| Schema verification failure | Same PostgreSQL harness verifies tables/columns/types/constraints/FKs/index predicates, then drops a required index and expects `DeviceExecutionSchemaError` | Compiled, skipped without `PNQ001_PG_URL` | Harness is ready to verify the deeper schema contract supplied by production remediation. |
| Root-boundary matrix | `docs/stories/PNQ-001-egress-inventory.md` | Completed | Covers standalone job, batch, edge workflow, server workflow, generated/recovery children, control egress, and dashboard websocket. |
| Control/admin/multi-worker policy matrix | `docs/stories/PNQ-001-egress-inventory.md` | Completed | Calls out control lane, admin resolution, multi-worker claim, websocket owner generation, and startup reconciliation dependencies. |

## Production Dependencies To Coordinate

- A single async egress API must provide DB authorization, CAS dispatching, waiter registration, wire send, and CAS dispatched. SPARK did not patch production senders.
- Durable operation ledger rows must map child `jobId`/`batchId`/`workflowId` to root id, device id, owner generation, and state. SPARK did not patch production schema or arbiter code.
- Terminal result observation must accept and verify owner generation, not only device plus root/external id. FORGE should verify this in the separately owned production remediation.
- Startup reconciliation needs an exposed hook so crash-before/after-send and crash-before/after-result boundaries can be tested directly.
- Production `validateSchema()` must cover full type/constraint/FK/index-predicate validation before G2 enforcement. The G1-C harness verifies that contract when a disposable PostgreSQL URL is supplied.
- Control/admin policy remains unresolved for workflow cancel, OTA/model config, auth revoke, kill switch, and administrative resolution.
