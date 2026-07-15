# PNQ-001 G3 WORKFLOW/BATCH/Recovery Evidence

Scope: server-only bounded evidence lane. Edits are limited to `tests/pnq-001/**` and `evidence/PNQ-001/**`; production `src/**` changes were concurrent VOLT-owned work and were not staged by this lane.

Base verified at start:

```text
fec2dc09c048af188c864b1a020ce4b05e1befa8
```

Real PostgreSQL endpoint:

```bash
postgresql://pnqtest@127.0.0.1:55432/pnq001_test
```

## Commands

```bash
npx vitest run tests/pnq-001/static-egress-guard.test.ts
```

Result: passed, 1 file / 8 tests.

```bash
PNQ001_PG_URL=postgresql://pnqtest@127.0.0.1:55432/pnq001_test \
  npx vitest run tests/pnq-001/device-execution-postgres.integration.test.ts
```

Result: passed, 1 file / 16 tests.

## G3 Coverage

| Requirement | Evidence |
| --- | --- |
| BATCH canonical DB/wire handle | Real-PG `runObservedEgress` test dispatches `edge_batch`, verifies waiter-before-wire order, root/operation ownership, `wire_handle`, owner generation, and terminal CAS through the returned handle. |
| WORKFLOW canonical DB/wire handle | Same real-PG test dispatches `server_workflow_root` with `WORKFLOW_START`, verifies DB handle equals wire handle, then completes by handle. |
| FIFO/non-overlap across JOB/BATCH/WORKFLOW | Mixed-root real-PG test admits `server_workflow`, `batch`, and `job`, verifies FIFO order, confirms one active root, rejects overlapping claim, and drains each terminal before the next claim. |
| Multi-worker races | Real-PG test races eight workers against queued BATCH then WORKFLOW roots and observes exactly one active claim, with the successor still queued. |
| Waiter-before-send | BATCH/WORKFLOW real-PG test and timeout test both record `waiter` before `wire`. |
| Timeout fail-closed | Observed WORKFLOW send throws `workflow_send_timeout`; operation is rejected, root remains active `dispatching`, successor stays queued, and later claim returns null. |
| Disconnect/restart fail-closed | Existing real-PG parameterized G2 test keeps successors queued while roots are `blocked` for disconnect/timeout and `reconciling` after startup reconciliation. |
| Wrong/stale/late/duplicate terminal CAS | Existing real-PG CAS test rejects wrong-device and stale-generation results, rejects duplicate/late terminal results, and checks audit event counts. |
| Recovery semantic boundary | Static guard pins `generated_child`, `self_healing_child`, `prestep_child`, and `recovery_child` to `server_workflow` roots, `job` operations, `requiresExistingRootHandle: true`, `retainsRootUntilTerminal: false`, and no queue bypass. |
| Multi-worker ownership policy | Static guard pins PostgreSQL authority, `root_id_device_id_owner_generation` ownership token, generation CAS, and observed single-active websocket ownership. |

## Concurrent Production Caveat

The static baseline was narrowed to the current production surface observed during this run: raw job sender imports/calls were removed from `workflow-compiler/recovery.service.ts`, `workflow-compiler/runner.service.ts`, and `workflows/workflow.executor.ts`, and `workflow-dispatch.service.ts` now has one raw `sendJobToDevice` call. Those production edits were not authored or staged by this evidence lane.

## Blockers

None for this bounded evidence lane after the current production interfaces are present. The child-operation production API still needs the existing-root handle seam implied by `requiresExistingRootHandle: true`; this lane pins that semantic contract but does not edit production to implement it.
