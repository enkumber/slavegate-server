# PNBB-001 — BustaBuster/PNQ Recovery Audit Remediation

## Status

- Owner: ATLAS
- Tech lead: FORGE
- Flow: ATLAS -> FORGE -> implementation -> LENS -> ECHO -> FORGE final
- State: Active intake on 2026-07-16 after explicit Dan authorization.
- Server base: `origin/master` at `5f514d4107c58a04f4d4cf83d1620477cfa17295`
- Server worktree: `/data/worktrees/slavegate-pnbb-001-server`
- Server branch: `fix/pnbb-001-audit-remediation`
- BustaBuster worktree: `/data/worktrees/bustabuster-pnbb-001`
- BustaBuster branch: `fix/pnbb-001-compile-pin-recovery`

## Scope

Fix exactly the two defects confirmed in the 2026-07-16 BustaBuster/PNQ audit.

1. In `bustabit_phone_live.py`, an expired pinned `compileJobId` must recover safely on `COMPILE_JOB_NOT_FOUND` as well as `GENERATED_WORKFLOW_CACHE_MISS`. Recovery must recompile, validate, persist, and update the manifest without duplicate executions.
2. In the Phone Network server generated-workflow path, a PNQ `would_wait` response because another root owns the device must not be reported as device unreachable. The runner must wait/resume/replay through existing PNQ behavior with FIFO and fail-closed semantics, no interleaving, no busy loop, and no duplicate sends.

## Hard Stops

- No push, deploy, release, service restart, cron run, phone action, live API action, live DB mutation, Android/APK/OTA, or Gemma/VLM modification/start.
- Do not trigger the existing BustaBuster cron. Read-only cron state checks are allowed only if needed.
- Writers must use separate worktrees. No two writers may edit the same worktree at the same time.
- Keep PNQ semantics fail-closed and FIFO; do not bypass the arbiter.

## Acceptance Criteria

- Deterministic BustaBuster tests cover `COMPILE_JOB_NOT_FOUND` recovery, manifest update, validation failure, idempotency, and no duplicate execution dispatch.
- Deterministic server tests cover generated-workflow PNQ `would_wait` eventual progress, FIFO preservation, idempotency/no duplicate sends, cancellation, timeout, and restart/replay behavior where applicable.
- If PNQ internals are touched, run real PostgreSQL PNQ integration with a disposable local URL only.
- Focused suites, server build, full relevant suite, `git diff --check`, and clean final worktrees must pass before final gate.
- Evidence must include exact commands, exit codes, commits, status, and residual risks.

## Lane Plan

- FORGE: own architecture review, lane split, integration sequencing, and final gate.
- BustaBuster implementer lane: own `/data/worktrees/bustabuster-pnbb-001`, only BustaBuster script/tests/docs.
- Server implementer lane: own `/data/worktrees/slavegate-pnbb-001-server`, generated-workflow/PNQ server path and focused tests.
- LENS: verification with explicit timeouts after candidates are ready.
- ECHO: safety review of compile pin recovery, PNQ wait/resume semantics, idempotency, cancellation, timeout, restart, and operational boundaries.
