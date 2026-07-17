# PNQ-003 Queue v2 Contract

Status: accepted for Phase 2 first increment

## Context

Phase 1 added PostgreSQL-backed observe-mode guardrails around the existing
device execution path. Queue v2 defines the durable PostgreSQL contract for a
later dispatcher cutover without changing live runtime behavior in this phase.

## Decision

Queue v2 is PostgreSQL-authoritative and uses `pnq_nodes`, `pnq_jobs`, and
`pnq_resolution_audit`.

The canonical contract is:

- `node_seq` is allocated monotonically from each node and provides per-node FIFO.
- `(node_id, request_key)` makes enqueue idempotent, with payload conflicts
  rejected and audited.
- `execution_id` identifies a concrete execution attempt.
- `connection_epoch` fences stale node connections before ownership changes.
- `job_version` plus `dispatch_generation` protect ownership and result
  transitions with compare-and-swap checks.
- `queue_deadline_at`, `dispatch_deadline_at`, `execution_deadline_at`, and
  `result_deadline_at` stay distinct and strictly ordered.
- The lifecycle is `PENDING -> DISPATCHING -> RUNNING -> DONE`; ambiguous ownership/recovery terminalizes as `STUCK`, and the schema provides no
  implicit retry out of that fail-closed state.

## Enforcement

The forward migration encodes the contract with PostgreSQL constraints, unique
indexes, append-only audit triggers, and transition functions for node
registration, idempotent enqueue, FIFO claim, explicit execution start, result
recording, and STUCK recovery.

Detailed schema notes live in
`docs/PNQ-003-QUEUE-V2-PERSISTENCE-CONTRACT.md`.
