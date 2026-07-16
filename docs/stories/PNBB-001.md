# PNBB-001 — BustaBuster/PNQ Recovery Audit Remediation

## Status

- Owner: ATLAS
- Tech lead: FORGE
- Flow: ATLAS -> FORGE -> implementation -> LENS -> ECHO -> FORGE final
- State: Final local GO on 2026-07-16; release/integration intentionally not performed.
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

## Final Local Evidence

- BustaBuster commit: `6fc0381` (`fix(bustabuster): recover expired workflow compile pins`).
- Phone Network replay commit: `9c6614f` (`fix(pnbb): replay queued generated edge workflows`).
- Phone Network lifecycle completion commit: `3b40b22` (`fix(pnbb): complete queued workflow replay lifecycle`).
- BustaBuster deterministic tests: `python3 -m unittest -v test_bustabit_phone_live.py` — 5/5 PASS.
- Server focused gate: transport, replay lifecycle, generated workflow dispatch, task runner timeout/cancellation, and workflow cancellation — 52/52 PASS.
- Real PostgreSQL 16 PNQ gate on disposable port `55439`: 18/18 PASS.
- Full server suite with isolated PNQ and PNMC databases: 52 files / 719 tests PASS.
- `npm run build`, Python bytecode compilation, and `git diff --check`: PASS.
- Disposable PostgreSQL was stopped after the gate and moved to recoverable trash; no QA service remains running.

The compile-pin path now preserves structured API error codes, recompiles on an expired `compileJobId`, validates before atomically replacing the manifest, and retries the run endpoint only for explicit pre-dispatch reference errors. The PNQ path persists an identity-bound edge-workflow replay envelope, resumes it through the FIFO queue pump, promotes the persisted workflow lifecycle after the wire send, applies ACK timeout handling without overwriting a concurrent ACK, and atomically cancels a workflow that exceeds its queued wait timeout. A queue-pump/cancellation race continues waiting for the already-dispatched workflow instead of issuing a duplicate execution.

No push, deploy, release, service restart, cron mutation/run, phone action, live API/DB mutation, Android/APK/OTA, or VLM action was performed.
