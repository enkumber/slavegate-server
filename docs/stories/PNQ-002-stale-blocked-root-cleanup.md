# PNQ-002: Clear stale blocked root workflow gates after terminal workflows

**Priority:** P0 incident
**Owner:** FORGE
**Requester:** ATLAS
**Created:** 2026-07-17
**Base:** `slavegate-server` `master` commit `1b7e583789eb52fba2cbfbcf2d0e5509c845985c` (`fix(workflows): register result waiter before dispatch`)
**Branch:** `fix/pnq-stale-blocked-root-cleanup`
**Status:** Ready for implementation

## Incident

After the 3.9.161 update, a controlled BustaBuster run failed terminally before any deterministic step reached the device.

Live evidence from the incident report:

- Health/build: `3.9.161` / `1b7e583789eb52fba2cbfbcf2d0e5509c845985c`, healthy.
- Agency run: `220b8d50-1b79-49f1-82e2-6bd88201960f`.
- Task: `c4cdd809-9fc4-4d28-b7f2-01e62997d87a`.
- Workflow: `129fec4e-0de2-45e5-8fc8-5e69b4c973a0`.
- Terminal error: `RECOVERY_BUDGET_EXCEEDED`.
- Workflow checkpoint showed `screen_wake` step `0` rejected twice almost immediately with `Failed to send job to device: blocked` at `05:50:08.242` and `05:50:19.165`.
- There were zero deterministic steps, zero child result timeouts, and zero LLM/VLM calls.
- No workflows were running or queued on device `acasa` / `d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd` after the run.

Working conclusion: the old terminal PNQ root remained fail-closed as `blocked` after restart/update, likely from the 3.9.160 probe with a `ui_tree_dump` timeout, and continued occupying the device slot. 3.9.161 fixed the waiter race, but the new workflow never reached device send.

## Goal

Release only stale blocked root locks whose owning workflow is demonstrably terminal, while preserving fail-closed behavior whenever ownership, terminal state, or active work evidence is ambiguous.

## Required lifecycle reproduction

FORGE must reproduce this exact lifecycle locally with PostgreSQL-backed state:

1. Create or seed a blocked root gate for a workflow/device.
2. Mark the owning workflow terminal with no active device work, no queued workflow work, and no child result timeout in flight.
3. Simulate process restart or startup reconciliation.
4. Start a new workflow for the same device and prove it is not rejected by the stale root.
5. Add a negative control where the root remains blocked because the evidence is ambiguous or the workflow is not terminal.

## Implementation requirements

- Cleanup must be identity-aware: release only roots tied to the same workflow/run/device identity proved terminal.
- Cleanup must be evidence-aware: require terminal workflow state and absence of running/queued child work before releasing.
- Ambiguity must remain fail-closed. Missing ownership, missing workflow state, active work, queued work, or mismatched identity must not be cleared.
- Add startup reconciliation and/or terminal workflow cleanup so the stale lock cannot survive restart/update when terminal evidence is complete.
- Keep cleanup idempotent and concurrency-safe under overlapping workflow terminalization, cancellation, and startup reconciliation.
- Do not add device actions, deploy/release actions, cron mutations, or live retries as part of this story.

## Acceptance criteria

- A PG-backed test reproduces the stale blocked root lifecycle and fails before the fix.
- A positive PG-backed test proves terminal workflow cleanup/reconciliation clears the stale blocked root and permits the next workflow to send work to the device.
- A negative PG-backed test proves a non-terminal, running, queued, identity-mismatched, or evidence-incomplete root remains blocked.
- Tests cover restart/startup reconciliation and terminal cleanup paths, or justify why one path is intentionally authoritative.
- Tests cover cancellation/concurrency enough to show no active workflow can have its root released by another terminal workflow.
- Focused test command, full relevant test command, build command, and diff summary are included in FORGE's final handoff.
- No live device, deploy, release, update, or cron mutation is performed.
- `bustabit-bankroll-live-monitor` (`bef3b27d-75cc-4724-b05b-f55f6266092e`) remains stopped/untouched.

## Review focus

- Concurrency around cleanup versus new workflow start.
- Cancellation and retry lifecycle: canceled/failed/succeeded terminal states should be explicit, not inferred loosely.
- Restart reconciliation ordering: cleanup must run only after enough database evidence is available.
- SQL predicates and indexes: ensure the release query cannot clear unrelated device roots.
- Telemetry/logging: enough context to diagnose future stale-blocked cleanup without logging sensitive data.

## FORGE deliverables

1. Implementation patch on `fix/pnq-stale-blocked-root-cleanup`.
2. PG-backed positive and negative tests.
3. Focused/full/build verification output.
4. Reviewer notes covering concurrency, cancellation, and restart behavior.
5. Final handoff back to ATLAS/Nox before any deploy/release/update/device action.
