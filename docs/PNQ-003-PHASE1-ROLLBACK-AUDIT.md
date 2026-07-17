# PNQ-003 Phase 1 controlled rollback audit

## Decision

PNQ remains installed as an observe-only ledger. `DEVICE_EXECUTION_AUTHORITY`
is the single immutable runtime contract; production mode is `observe_only`.
Tests may explicitly select either contract, but production cannot flip it via
environment configuration or diverge between processes.

## Authority removed coherently

- Admission: workflow rows advance on the stable lifecycle regardless of a PNQ wait decision.
- Egress: JOB, BATCH, and edge WORKFLOW use the real DirectWS methods without a PNQ permit.
- Ingress: authenticated JOB results resolve the stable waiter/executor path; PNQ receives telemetry only.
- Timeout/ambiguity: waiter cleanup no longer waits on PNQ terminal/ambiguity transitions.
- Startup: PNQ in-flight and terminal reconciliation are not lifecycle gates.
- Cancellation: the workflow queued-state CAS is authoritative; PNQ receives terminal telemetry only.

## Preserved independent work

The rollback is surgical and does not revert commits. Schema validation,
migrations, PNQ rows/events/metrics, result-waiter-before-dispatch behavior from
`1b7e583`, terminal identity cleanup from `403baf1`, and child-timeout/root
reconciliation code through base `081dfb3` remain present and testable under the
explicit enforced test contract.

## Local gate

The production transport seam test uses the real `DirectWsServer` serializer
and the actual transport function in observe-only mode, proving a JOB is sent
once without a PNQ queue claim or permit. Task-runner tests cover the cron
single-flight contract, including the case where an existing generated workflow
remains active past the observer warning and must not be redispatched.

No deploy, release, live cron mutation/test, or real-device action is part of
this phase.
