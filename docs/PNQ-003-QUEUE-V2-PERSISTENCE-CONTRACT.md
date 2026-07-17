# PNQ-003 Queue v2 Persistence Contract

Status: accepted for Phase 2 schema contract

## Context

PNQ Phase 1 introduced observe-mode guardrails around the existing device execution path. Queue v2 is the durable PostgreSQL contract that a later dispatcher cutover can use, but this phase deliberately does not change runtime dispatch behavior.

The existing repository already has a legacy `jobs` table. Queue v2 therefore uses prefixed table names (`pnq_nodes`, `pnq_jobs`, `pnq_resolution_audit`) so the contract can land without rewriting or shadowing Phase 1 behavior.

## Canonical Model

`pnq_nodes` owns device/node coordination. Each node has a monotonically increasing `next_node_seq` used to allocate FIFO positions and a monotonically increasing `connection_epoch` used for fencing stale connections.

`pnq_jobs` is the durable node-scoped queue. FIFO is per node through `UNIQUE(node_id, node_seq)`, while `pnq_jobs_one_active_per_node_idx` permits at most one `DISPATCHING` or `RUNNING` job per node. Idempotency is scoped to `(node_id, request_key)` and enforced by `pnq_jobs_request_key_unique`. Execution identity is `execution_id`, which is unique globally and required once a job is claimed for dispatch or completed. `STUCK` may preserve an existing attempt id when one exists, but a pre-dispatch ambiguity can terminalize without inventing an execution attempt. Concurrent mutation uses `job_version` plus `dispatch_generation`.

`pnq_resolution_audit` is append-only evidence for resolution decisions: idempotent replays, payload conflicts, stale epochs, CAS losses, stale or late results, recovery decisions, and explicit stuck/resolution events.

## State Machine

Allowed job states:

- `PENDING`: job has a node FIFO sequence and has not been claimed.
- `DISPATCHING`: a specific `execution_id` owns the durable server-to-device handoff phase.
- `RUNNING`: a specific `execution_id` owns the current dispatch attempt.
- `DONE`: terminal result state; `terminal_reason` and `result_payload` preserve outcome details.
- `STUCK`: terminal fail-closed state requiring explicit audited resolution.

The migration enforces the state vocabulary, terminal timestamp requirements, and non-null execution identity for `DISPATCHING`, `RUNNING`, and `DONE`. `STUCK` may have no execution identity when ambiguity is discovered before dispatch. It is terminal and the schema provides no implicit retry path out of it.

## Ownership And Idempotency

Ownership is node-scoped. `request_key` idempotency is also node-scoped because different devices may legitimately receive the same logical request key while retaining independent FIFO and execution histories.

Payload conflict behavior is fail-closed: if `pnq_enqueue_job` sees an existing `(node_id, request_key)` with a different `request_payload`, it writes `payload_conflict` audit evidence and returns the existing immutable job without allocating a new sequence or changing its payload. Exact replay also returns the existing job and writes `enqueue_idempotent_replay` evidence.

## Isolation And Locking

FIFO allocation is transactional. `pnq_enqueue_job` locks the node row `FOR UPDATE`, reads `next_node_seq`, increments it, and inserts the job with `UNIQUE(node_id, node_seq)` as the final database invariant.

The contract permits parallelism across nodes because each enqueue locks only its node row. Claim/start and result paths lock only the target job row, with epoch checks against the node and CAS checks against `job_version` plus `dispatch_generation`.

## Fencing And CAS

`connection_epoch` is monotonically bumped by `pnq_bump_connection_epoch`. `pnq_claim_next_job` and `pnq_start_execution` require the caller's observed epoch to match the current node epoch. Stale epochs are rejected from ownership changes and audited.

Every dispatch attempt has a `dispatch_generation` and a persisted `claimed_connection_epoch`. `pnq_claim_next_job` moves the FIFO head from `PENDING` to `DISPATCHING`, assigns `execution_id`, captures the current epoch, and increments both CAS counters. `pnq_start_execution` locks the node before checking epoch, then requires the same execution identity, claimed epoch, `job_version`, and `dispatch_generation` before moving the job to `RUNNING`. `pnq_record_result` also locks the node and requires both the claimed and current node epoch to match the result epoch, in addition to `execution_id` and `dispatch_generation`; stale or late results return the current row unchanged and append durable audit evidence.

## Deadline Semantics

Deadlines are intentionally distinct:

- `queue_deadline_at`: latest time the job may wait in `PENDING`.
- `dispatch_deadline_at`: latest time to complete server dispatch/handoff.
- `execution_deadline_at`: latest time the device-side execution may run.
- `result_deadline_at`: latest time a result may be accepted before recovery.

The schema enforces strict ordering with `pnq_jobs_deadline_order_check`. Recovery code in a later phase can reason about which boundary expired without collapsing all timeouts into one ambiguous timestamp.

## Retry And Recovery

This phase defines recovery evidence, not a runtime recovery loop. `pnq_jobs_recovery_idx` indexes in-flight jobs (`DISPATCHING`, `RUNNING`) by update time and result deadline for restart scanners. Ambiguous restart state should call `pnq_mark_stuck`, which terminalizes the row as `STUCK` and appends `marked_stuck` audit evidence.

Retries after `STUCK` require an explicit future operation that writes audit evidence. There is no implicit complete/retry transition in this contract.

## Audit Append-Only Enforcement

`pnq_resolution_audit` uses `BEFORE UPDATE` and `BEFORE DELETE` triggers that always raise. That is the repo-native, migration-local enforcement mechanism available without introducing database roles or grants that the current runner does not manage. Tests verify both update and delete are rejected.

## Migration And Rollback Boundary

Forward migration: `src/db/migrations/082_pnq_queue_v2_contract.sql`.

Rollback SQL: `src/db/rollbacks/082_pnq_queue_v2_contract.rollback.sql`.

The rollback file is intentionally outside `src/db/migrations` because the repository migration runners apply every SQL file in that directory as a forward migration. Rollback drops Queue v2 functions, triggers, and tables only. It does not touch Phase 1 tables or behavior.

## Phase Boundary

This ADR does not authorize dispatcher/runtime cutover. Phase 2 is limited to schema, contract functions, and PostgreSQL tests. Existing Phase 1 observe-mode behavior remains unchanged.
