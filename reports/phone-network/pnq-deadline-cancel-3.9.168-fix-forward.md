# PNQ Deadline/Cancel Fix-Forward

Date: 2026-07-18
Branch: fix/pnq-deadline-cancel-3.9.168
Base before this follow-up: b0ac64a6d3da0ef7e914c3acee7f1db4f57c9c27

## Changes

- Propagated `maxSelfHealingAttempts` from task-runner control plane into generated workflow dispatch context and durable workflow checkpoints.
- Made workflow executor recovery policy read the checkpoint control-plane budget, and hard-disable AI recovery when `maxSelfHealingAttempts=0`.
- Added regression coverage proving `attemptGeneratedWorkflowAiRecovery`/`llmJson` is not invoked when control-plane budget is zero, even if the template advertises `ai_autopilot`.
- Preserved the prior fix-forward diff for Android `JOB_RESULT` retry persistence, DirectWS single result authority, bounded effect waits vs strict observations, and in-flight cancellation.

## Verification

- `npx vitest run src/modules/workflows/workflow.executor.retry.test.ts src/modules/task-runner/task-runner.service.test.ts` - passed, 39 tests.
- `npm run build` - passed.
- `npm test` - passed, 61 files / 800 tests.
- `./gradlew :app:assembleDebug` - blocked: `JAVA_HOME not set and no 'java' command found`.

No deploy/live/cron actions were performed.
