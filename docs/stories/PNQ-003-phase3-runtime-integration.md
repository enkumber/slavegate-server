# PNQ-003 Phase 3 Runtime Integration

Phase 3 wires the PostgreSQL Queue v2 contract into the standalone job runtime as a disabled-by-default shadow sidecar. The legacy route, BullMQ queue, DirectWS egress, and legacy result handling remain the production authority.

## Mode Semantics

- `disabled` is the default. The runtime service returns before opening a database connection, starts no Queue v2 timers, and does not mirror route, dispatch, connection, or result events.
- `shadow` mirrors lifecycle observations into Queue v2. Queue v2 errors are logged as observed errors and fail open to legacy behavior. Shadow never authorizes, blocks, reorders, duplicates, delays, or replays wire egress.
- Unknown `PNQ_V2_RUNTIME_MODE` values normalize fail-closed to `disabled`.
- Mode is read as process startup configuration. Changing it requires restart; tests may use the test-only override.

## Identity Mapping

- `node_key` is the legacy `deviceId`.
- `request_key` is the legacy `jobId`.
- `request_payload` is a versioned sanitized dispatch envelope containing only legacy identifiers and redacted params.
- `pnq_legacy_job_map` durably links `legacy_job_id` to `pnq_job_id`, `attempt_execution_id`, `dispatch_generation`, and the socket-observed epoch.

## Sequence

1. `POST /api/jobs` creates the legacy job and BullMQ entry. Shadow then registers the node and idempotently enqueues Queue v2 by legacy `jobId`.
2. The canonical send path performs one DirectWS send. Immediately before the legacy send, shadow attempts `claim_next` and `start_execution` using the authenticated socket epoch.
3. `/ws-direct` and `/ws` store the epoch on the authenticated connection object. Result handling records Queue v2 terminal state using that socket-owned epoch before continuing legacy processing.
4. Startup and periodic sweeps mark Queue v2 `DISPATCHING`/`RUNNING` crash windows as `STUCK`. They never transmit jobs.

## Crash Matrix

| Window | Shadow action | Wire action |
| --- | --- | --- |
| after enqueue, before claim | remains pending until deadline/sweep evidence | no replay |
| after claim, before start | restart sweep marks `STUCK` | no replay |
| after start, before result | restart sweep marks `STUCK` | no replay |
| stale replaced socket result | Queue v2 rejects/audits epoch mismatch | legacy path remains non-blocking |
| CAS/generation mismatch | Queue v2 rejects/audits | legacy path remains authority |

## Rollback

Set `PNQ_V2_RUNTIME_MODE=disabled` and restart. The rollback SQL drops only the runtime mapping table. Phase 1 authority and legacy production behavior are unchanged.

## Future Cutover Exclusions

This phase does not add enforced mode, authoritative dispatch, Queue v2 wire replay, device changes, live cron changes, release/deploy behavior, or public cutover.
