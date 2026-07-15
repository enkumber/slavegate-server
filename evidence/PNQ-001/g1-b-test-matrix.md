# PNQ-001 G1-B Test Matrix

## Deterministic Static Guard

Command:

```bash
npx vitest run tests/pnq-001/static-egress-guard.test.ts
```

Expected result:

- Passes on base `51668e45ffaf9754401a9c80e3a1ee8508bd524d`.
- Fails if a production TypeScript file under `src/` adds, removes, or moves to a new file/kind count for a known egress primitive.
- Failure requires FORGE/VOLT classification before G2.

## DB Concurrency Evidence Plan

This lane does not implement DB acquisition. The deterministic G2 fixture should be owned by VOLT/FORGE after the PNQ admission interface exists:

1. Create one durable queue/lease table fixture with device `pnq-device-a`.
2. Start two isolated server admission clients against the same PostgreSQL database.
3. Barrier both clients before claim.
4. Race root `raw-job-a` and root `workflow-b`.
5. Assert exactly one root reaches `claimed/dispatched`.
6. Assert the loser is durable `queued` with FIFO order.
7. Repeat with restart between claim and terminal event.
8. Assert stale owner result cannot release or mutate the successor.

Required observable events:

- `admission_requested`
- `claim_attempted`
- `claim_won` or `queued`
- `sent`
- `terminal_observed`
- `released`
- `promoted`
- `stale_rejected`

## Interface Needs

- A server-side admission function that accepts device id, root execution id, child execution id, egress kind, timeout, and idempotency key.
- A durable owner token or generation returned by admission and required by all transport send calls.
- A test adapter for DirectWS that records send attempts without touching a live device.
- A reconciliation hook for server restart and ambiguous in-flight sends.

## G1-B Blockers To Raise

- Current production senders call `sendJobToDevice`, `directWsServer.sendBatch`, `directWsServer.sendWorkflowStart`, `directWsServer.sendWorkflowCancel`, and `directWsServer.sendToDevice` directly from many modules. There is no single static admission interface to assert yet.
- Control egress policy is unresolved for cancel, OTA, model config, auth revoke, and kill switch.
- Legacy websocket and DirectWS coexist in production source; FORGE should decide whether both need PNQ enforcement or whether legacy paths are decommissioning.

