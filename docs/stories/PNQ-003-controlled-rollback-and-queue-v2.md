# PNQ-003: Controlled PNQ enforcement rollback and PostgreSQL Queue v2

**Priority:** P0/P1, Dan-authorized GO
**Requester:** Dan via ATLAS
**PM / Entry point:** ATLAS
**Primary owner:** FORGE
**QA owners:** VOLT + SPARK
**Review owners:** LENS + ECHO
**Final integrator:** FORGE
**Created:** 2026-07-17
**Base:** `origin/master` `081dfb3973e088f09c61fe455643a3a19eeb2887`
**Branch:** `feature/pnq-v2-controlled-rollback`
**Status:** Ready for FORGE implementation

## Scope guardrails

- No global `git reset` or broad revert.
- Do not lose independent fixes already on `master`.
- No live deploy, release, update, device action, cron mutation, or live test until local/integration gates are green and FORGE issues an explicit gate for Dan approval.
- The real cron and real device stay untouched during this story.
- This story must go through: FORGE -> VOLT/SPARK -> LENS -> ECHO -> FORGE.

## Phase 1: controlled rollback of PNQ enforcement

Identify the PNQ integration that introduced the 3.9.164 regression and disable PNQ authority coherently for critical production flows.

Required behavior:

- Disable admission, result gating, and timeout/enforcement PNQ as one switch/contract, not as scattered bypasses.
- Keep PNQ schema, data, metrics, and telemetry in observe-only mode.
- Restore the previously stable production path for critical flows.
- Preserve independent fixes from 3.9.161 through current `master`.
- Document the exact rollback audit: commits, files, runtime switches, affected code paths, and independent fixes intentionally preserved.

Phase 1 gate:

- A realistic E2E of the production path, including cron single-flight behavior.
- No mock of the arbiter or transport layer.
- Prove no PNQ blockage and no double execution.
- Local/integration only. No live device, deploy, release, update, cron mutation, or live cron/device test.

## Phase 2: ADR and Queue v2, separate from PNQ

Write a canonical ADR for Queue v2 and implement/test the design separately from PNQ enforcement.

Closed architecture decisions:

- PostgreSQL is the only source of truth. BullMQ/Redis are excluded from per-device lifecycle.
- N independent FIFO lanes, with cross-device parallelism.
- Core tables: `nodes`, `jobs`, and append-only `resolution_audit`.
- States: `PENDING`, `DISPATCHING`, `RUNNING`, `STUCK`, `DONE`.
- `node_seq` is allocated transactionally per device.
- A partial unique index allows only one active job in `DISPATCHING`, `RUNNING`, or `STUCK`.
- `request_key` is unique for enqueue deduplication.
- `execution_id` is immutable and is the execution/dedup identity.
- `connection_epoch` is monotonic and fences owner/session authority.
- `job_version` / `dispatch_generation` provide per-job CAS and must not be removed in favor of `connection_epoch`.
- The complete reconstructible envelope is persisted in `jobs`; the row is the outbox.
- Dispatch deadline and execution deadline are distinct.
- Timeout does not release the slot. Re-dispatch uses the same `execution_id`, then transitions to `STUCK`.
- A legitimate terminal result can reconcile its execution even from an old epoch after authentication plus `node_id` / `execution_id` matching. Old epochs cannot control new transitions.
- Durable ownership lives in `nodes`; `LISTEN/NOTIFY` is wake-up only.
- Android writes a persistent journal before the first external effect. Unconfirmed results are retained and retransmitted until durable ACK.
- A single-device workflow is one job. Mutating steps use persistent checkpoint / `step_execution_id`; no blind full-workflow retry.
- Reconciler runs in the same process type.
- Admin resolver is authenticated and audited. Unsafe override is explicit. Retry creates a new job with a new `execution_id` and `retry_of_job_id`.
- `DONE` is immutable. Identical duplicates are no-op; conflicting duplicates are audited/alerted.
- Critical operations are CAS, and only the `UPDATE ... RETURNING` winner may send.
- No ownership inference from `command_log` / text.
- No in-memory waiter/timer is required for recovery correctness.

## Mandatory Queue v2 gates

- Duplicate enqueue.
- Real FIFO with two concurrent workers.
- Parallelism across two devices.
- Crash commit-before-send and send-before-ACK.
- Old ACK.
- Two recoverers, single CAS winner.
- Split-brain A/B.
- Restart in every state.
- Offline/reconnect.
- Duplicate, late, wrong-device, and conflicting results.
- Device reboot after external effect.
- Lost local result and retransmission.
- Old idle / missing journal does not abandon.
- Mutating checkpoint.
- Child completion and next-job creation are atomic.
- `STUCK` and audited admin resolver.
- E2E on the real route with real concurrent PostgreSQL connections.
- Shadow mode -> one-device canary -> gradual enforcement plan. No live activation in this story.

## Deliverables

1. Story and acceptance criteria.
2. Exact audit of the Phase 1 rollback proposal.
3. Canonical Queue v2 ADR.
4. Implementation and tests.
5. QA/review report from VOLT/SPARK, LENS, and ECHO.
6. Separate release recommendations for Phase 1 and Phase 2.

## Acceptance criteria

- FORGE identifies the exact PNQ enforcement integration behind the 3.9.164 regression.
- Phase 1 disables PNQ admission/result-gating/timeout authority via one coherent runtime contract while keeping PNQ observe-only.
- Existing independent fixes on `master` remain present; the diff is surgical and explained.
- Production critical path E2E passes locally/integration with real arbiter and transport, cron single-flight included, proving no block and no duplicate execution.
- Queue v2 ADR is committed as a canonical design artifact and explicitly records every closed decision above.
- Queue v2 implementation uses PostgreSQL durable state and CAS semantics for all critical transitions.
- All mandatory Queue v2 gates have automated tests or explicit signed-off deferrals with risk notes; no deferral is allowed for duplicate enqueue, FIFO/concurrency, crash/restart, stale ACK/result, or resolver audit.
- QA owners run independent local/integration verification and attach commands/results.
- LENS performs risk review focused on concurrency, crash recovery, epoch fencing, result reconciliation, and release split.
- ECHO performs final reviewer approval or blocks with concrete findings.
- FORGE produces the final implementation/review handoff and separate Phase 1 / Phase 2 release recommendations.
- No deploy/release/update/device/cron action occurs in this story.
