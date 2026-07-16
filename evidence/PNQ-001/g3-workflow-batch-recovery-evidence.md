# PNQ-001 G3 WORKFLOW/BATCH/Recovery Evidence

Date: 2026-07-16

Scope: isolated, server-only G3 remediation and evidence. No Android/APK/OTA, live service, device, deploy, release, push, restart, or cron mutation was performed.

Exact review base:

```text
9a13cbf1d3fdc4a032965eb0af4038c2eca0a72d
```

Production remediation head:

```text
cb319fbbaa26a871be35ccd9fb2d429035372932
```

The final review HEAD also includes only the evidence, static-baseline, and stale test-contract corrections recorded after that production head.

## Mandatory Replay

```bash
npx vitest run \
  src/modules/device-execution/device-execution-arbiter.test.ts \
  src/ws/direct-ws.server.test.ts \
  src/transport/transport.test.ts \
  src/modules/workflows/workflow-dispatch.service.test.ts
```

Result: PASS, 4 files / 51 tests.

```bash
env -u DATABASE_URL \
  PNQ001_PG_URL='postgresql://pnqtest@127.0.0.1:55432/pnq001_test' \
  npx vitest run tests/pnq-001/device-execution-postgres.integration.test.ts
```

Result: PASS, 1 file / 16 tests against real PostgreSQL.

```bash
npx vitest run --reporter=dot
```

Result: PASS, 41 files / 561 tests.

```bash
npm run build
git diff --check
git status --short --branch
```

Result: build and diff-check PASS. The review commit is clean after committing this evidence.

## G3 Safety Coverage

| Requirement | Direct evidence |
| --- | --- |
| One PostgreSQL-authorized egress path | Raw ordinary JOB/BATCH/WORKFLOW senders fail closed and record rejection audit events; semantic static guard pins every remaining import and call boundary. |
| Canonical workflow topology | Server workflow JOB, recovery, generated/self-healing/prestep, and BATCH children receive the existing workflow root identity; child terminal results do not release the root. |
| BATCH/WORKFLOW result correlation | Typed pending handles are registered before wire send. Present malformed/mismatched handles reject; missing Android handles are accepted only for an authenticated socket with the exact pending operation and DB ownership CAS. |
| Result-before-dispatched race | The waiter exists before wire egress and terminal CAS accepts the authoritative dispatch state without a later `dispatched` write overwriting terminal state. |
| FIFO and non-overlap | Real-PG tests cover mixed JOB/BATCH/WORKFLOW FIFO, 100 admissions, one active root, two-device independence, and multi-worker claim races. |
| Failure ambiguity | Disconnect, timeout, shutdown, send uncertainty, and restart move roots to blocked/reconciling before pending state is cleared. Failed ambiguity persistence retains pending work and retries; it never advances the successor. |
| Socket ownership race | Close handling checks connection object identity, so a superseded socket cannot delete or block the current connection. Async websocket handlers contain rejected promises. |
| Immutable replay | Replay envelopes are schema-versioned and identity-bound. Duplicate admission cannot replace dispatch metadata; corrupt queue heads block and audit instead of silently advancing. |
| Cancellation | Queued, unsent roots and every registered child operation are terminalized through CAS. In-flight workflow cancellation returns 409 and retains ownership instead of claiming false cancellation. |
| Workflow completion and runner exceptions | All-prestep workflows terminalize their canonical root. Unexpected post-admission runner failures terminalize failed or, if uncertain, block fail-closed. |
| Rejection audit | Wrong-device, stale-generation, malformed/mismatched/missing-context, duplicate, late, and no-waiter result paths are rejected and audited. |
| Timer/waiter lifecycle | Queue sweep, DirectWS timers, collision checks, shutdown, disconnect, and timeout cleanup are bounded and covered. |

## Reviewed Static Egress Baseline

`static-egress-baseline.json` now contains the current production surface directly. The guard no longer filters historical entries or synthesizes a passing expected value. Remaining entries are classified control egress, permit-backed transport internals, or reviewed serializers; ordinary raw G3 senders removed from production no longer appear.

## Commit Chain After Initial Candidate

- `722f6a0` — result ingress race, handle audit, and waiter fixes
- `252b37d` — canonical workflow egress
- `85dad9e` — fail-closed PostgreSQL timeout expectation
- `8aae013` — secure authenticated compatibility for Android result shapes
- `f0a8a74` — canonical server-workflow topology and recovery/cascade identity
- `cc74d09` — awaited ambiguity lifecycle
- `77350d2` — queued-only cancellation and all-prestep completion
- `5427bf1` — canonical PostgreSQL fixture roots
- `cb319fb` — socket replacement, ambiguity retry/retention, async containment, child cancellation, and runner exception hardening

## Residual Product Limitations

- Standalone edge BATCH/WORKFLOW requests that encounter `would_wait` are safely cancelled before fallback/error because no durable replay payload exists for those legacy callers. Safety and FIFO ownership are preserved, but durable deferred edge replay remains future product work.
- The legacy websocket implementation remains a classified serializer/control surface outside the enforced DirectWS execution lane. Any future ordinary device execution added there must first adopt the typed arbiter contract and update the static baseline under review.

## Review State

The previous LENS GO at `5427bf1` and all earlier review verdicts are stale after final hardening. Fresh LENS and ECHO reviews must inspect the exact final evidence commit; FORGE may issue the final G3 verdict only after both complete.
