# PNQ-003 Phase 4 Shadow E2E

Phase 4 adds a local-only executable gate for the standalone production route:

`POST /api/jobs -> dispatcher -> DirectWS -> JOB_RESULT`

Legacy remains the wire, HTTP response, and result authority. Queue v2 is shadow telemetry only: it may persist lifecycle evidence, reject stale epochs, or fail its own database work, but it must not add a second sender, delay the legacy response, replay work, or block legacy result handling.

## Gate

The Phase 4 gate exercises the real Express route, dispatcher service, production transport facade, and DirectWS singleton against local PostgreSQL Queue v2 tables. It proves:

- one route admission creates exactly one legacy `JOB` wire frame;
- shadow enqueue, legacy mapping, dispatch attempt, and terminal result lifecycle persist in PostgreSQL;
- pending or rejected shadow persistence is telemetry-only for the legacy HTTP and result paths;
- stale socket epochs are rejected and audited only in Queue v2 while legacy completion continues;
- startup/deadline reconciliation marks eligible active rows `STUCK` without sending or replaying;
- same-device Queue v2 order remains FIFO;
- different devices progress in parallel with real concurrent PostgreSQL connections;
- the exercised sender is the canonical DirectWS path, not a test-only production sender.

The gate is local-only, uses deterministic test rows, bounded polling, and no live devices, deploys, cron, or enforced-mode behavior.
