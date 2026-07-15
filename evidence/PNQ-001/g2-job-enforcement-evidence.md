# PNQ-001 G2 JOB Enforcement Evidence

Scope: server-only evidence lane. Edits are limited to `tests/pnq-001/**` and `evidence/PNQ-001/**`.

## Database

Real PostgreSQL endpoint:

```bash
postgresql://pnqtest@127.0.0.1:55432/pnq001_test
```

Connectivity check:

```text
PostgreSQL 18.3 (Homebrew) on x86_64-pc-linux-gnu
```

The harness refuses to reuse `DATABASE_URL` and resets only the disposable PNQ test schema objects before each case.

## Commands

```bash
npx vitest run tests/pnq-001/static-egress-guard.test.ts
```

Result: passed, 1 file / 7 tests.

```bash
PNQ001_PG_URL=postgresql://pnqtest@127.0.0.1:55432/pnq001_test \
  npx vitest run tests/pnq-001/device-execution-postgres.integration.test.ts
```

Result: passed, 1 file / 12 tests.

```bash
PNQ001_PG_URL=postgresql://pnqtest@127.0.0.1:55432/pnq001_test \
  npx vitest run tests/pnq-001/static-egress-guard.test.ts tests/pnq-001/device-execution-postgres.integration.test.ts
```

Result: passed, 2 files / 19 tests.

```bash
git diff --check
```

Result: passed.

## G2 JOB Coverage

| Requirement | Evidence |
| --- | --- |
| 100 concurrent admissions stable FIFO / `maxActive=1` | Real-PG test concurrently admits 100 JOB roots, drains in PostgreSQL FIFO order, and records active counts never exceeding one. |
| Two devices concurrent | Real-PG test claims separate device roots concurrently and verifies one active root per device. |
| Two workers one claim | Real-PG test races two arbiters against one queued root and gets exactly one permit. |
| Canonical DB/wire handle | Real-PG test uses `runStandaloneJobEgress`, compares waiter and wire permits, checks `pnqHandle`, operation ledger `wire_handle`, root id, device id, operation id, and owner generation. |
| Waiter registered before send | Same test records callback order as `waiter` then `wire`. |
| Terminal CAS rejects wrong-device / late / duplicate / stale generation | Real-PG test verifies all four rejection paths and audit event counts. |
| Timeout / disconnect / restart remains blocked | Real-PG parameterized test leaves successors queued while roots are `blocked` or `reconciling`; startup reconciliation is included. |
| Queued and running cancellation | Real-PG test cancels queued and dispatched JOB roots, rejects late results, and then claims successors. |
| `POST /api/jobs` remains `202` queued | Static route contract test pins the route handler to `res.status(202).json` with `status: "queued"`. |
| Semantic raw egress guard | Static guard now detects aliased and namespace raw transport/direct-WS imports and calls, and records `directWsServer.sendJobWithPermit` as the central permit-bearing wire edge. |

## Worktree Caveat

During this evidence run, production G2 changes were already dirty in the worktree and were not authored by this lane. This lane does not stage or commit production files. The updated static baseline reflects the current working tree's narrower raw JOB surface, where Hydra, app mapping, screen detection, and `POST /api/jobs` use `sendStandaloneJobToDevice`.

## Blockers

None for the evidence lane after the current G2 production working-tree changes are present. FORGE should ensure those production files are owned, reviewed, and committed by the production-remediation lane before treating this evidence commit as standalone green.
