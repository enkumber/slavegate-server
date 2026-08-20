Story: STORY-PN-LIVE-CLONE-HTTP-E2E-PROMOTION-GATE-3-9-311-001

Base SHA:
dae0388257af4d5896c4edc63e12fdc83e55980b

Commands:

- `git -C /data/.openclaw/workspace/slavegate/server rev-parse HEAD`
  - exit 0
  - output: `dae0388257af4d5896c4edc63e12fdc83e55980b`

- `git -C /data/.openclaw/workspace/slavegate/server worktree add -b feat/pn-live-clone-http-e2e-gate-3.9.311 /data/worktrees/phone-network-live-clone-http-e2e-gate-3.9.311 dae0388257af4d5896c4edc63e12fdc83e55980b`
  - exit 0

- `npm ci`
  - exit 0

- `npm run build`
  - exit 0

- `npx vitest run src/modules/human-workflow/compile-job.service.test.ts`
  - exit 0
  - 5 tests passed

- `npx vitest run src/transport/transport.test.ts src/modules/human-workflow/compile-job.service.test.ts`
  - exit 0
  - 13 tests passed

- `npx vitest run tests/human-workflow-compile-reconciler-postgres.integration.test.ts`
  - exit 1
  - blocker: local PostgreSQL endpoint rejected the default test role with `role "pnqtest" does not exist`; no usable PostgreSQL test DSN was present in env.

- `PHONE_NETWORK_ANDROID_ROOT=/data/.openclaw/workspace/slavegate/android-agent npm run hardcoding:audit`
  - exit 0
  - output: `Hardcoding audit passed: no packaged lifecycle/status semantics found.`

- `git diff --check`
  - exit 0

PostgreSQL Proofs:

- Added real PostgreSQL integration coverage in `tests/human-workflow-compile-reconciler-postgres.integration.test.ts`.
- Coverage includes startup reconciliation, expired running reclaim, non-stale lease protection, concurrent claim uniqueness, idempotent request identity, conflicting idempotency payload fail-closed, crash recovery before compile and before readback, missing/disabled policy fail-closed, and owner-generation fencing.
- Execution in this container is blocked by missing local PostgreSQL test role; the test is not mocked and will run against a supplied `HUMAN_WORKFLOW_COMPILE_PG_URL`, `PNQ003_PG_URL`, or `PNQ001_PG_URL`.

HTTP / Egress Evidence:

- Production default remains real DirectWS.
- Promotion capture mode requires `PN_PROMOTION_GATE_EGRESS_CAPTURE=enabled` plus `PN_PROMOTION_GATE_DB_FINGERPRINT` matching `sha256(current_database() || ':' || current_schema())`.
- Typed egress captures persist into `promotion_gate_egress_captures` with unique `capture_mode/db_fingerprint/dispatch_identity`.
- Raw DirectWS JOB, legacy JOB, WORKFLOW_START, and WORKFLOW_CANCEL sends throw in capture mode.
- No live DirectWS, phone, deploy, service restart, or production DB mutation was performed.

Residual Risks:

- Real PostgreSQL integration execution remains pending until a valid isolated test PostgreSQL DSN is provided in the environment.
- SPARK isolated live-clone HTTP harness lane was not run here.
