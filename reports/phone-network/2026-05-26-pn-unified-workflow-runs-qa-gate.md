# Phone Network Unified Workflow Runs QA Gate

Date: 2026-05-26
Repo: `/data/.openclaw/workspace/slavegate/server`
Branch: `pn-unified-workflow-runs-refactor`
Story: `/data/.openclaw/workspace-atlas/stories/STORY-PN-UNIFIED-WORKFLOW-RUNS-001.md`

## Verdict

PASS for local implementation and regression coverage.

Remaining live-device gap: this environment did not run a real device BFS discovery or execute a real workflow on a connected phone. The service path is covered with mocked app-map/discovery/compiler/runner boundaries.

## Implemented Surface

- `POST /api/workflow-runs` is mounted from `src/index.ts`.
- Route accepts the unified contract `{ instruction, appId, deviceId }`.
- `src/modules/workflow-runs/` owns the new workflow-run domain.
- `workflow_runs` table is added in migration `037_unified_workflow_runs.sql`.
- `/api/creative-workflows` is no longer mounted as a separate public workflow-run surface.
- Existing complete app-maps skip discovery.
- Missing/incomplete app-maps trigger `startRecording(deviceId, appId)` and reload the persisted map before compile.
- Compile uses the existing workflow compiler.
- Execution uses the deterministic compiled workflow runner.
- Workflow-run lifecycle events publish with persisted `workflowRunId`.
- App-map persistence now mirrors DB maps to `seeds/app-maps/{appId}.json` and falls back to those seed files when DB has no map.
- Legacy template dispatch endpoints now return `410 WORKFLOW_TEMPLATES_ARE_EXAMPLES_ONLY`; template listing endpoints mark templates as `exampleOnly`.
- Stale tracked backup file `src/api/routes.ts.backup` was removed so old template execution routes are not present in the source tree.
- `POST /api/agency/workflow-runs` remains unchanged and compatibility tests pass.

## Evidence Commands

### TypeScript Compile

Command:

```bash
npx tsc --noEmit --pretty false
```

Result: PASS.

### Targeted Tests

Command:

```bash
npm test -- workflow-run-routes workflow-run.service creative-workflow creative-workflow-routes agency-workflow-runs
```

Result: PASS.

Summary:

```text
Test Files  5 passed (5)
Tests       32 passed (32)
```

Coverage:

- Unified route contract.
- Missing field validation.
- Existing app-map path.
- Missing app-map discovery path.
- Incomplete app-map failure before compile.
- Compile failure does not execute.
- Non-persisted compiled workflow ID is rejected before execution.
- Lifecycle events include persisted run IDs.
- Agency workflow-run compatibility.
- Existing creative route baseline.

### Full Server Suite

Command:

```bash
npm test
```

Result: PASS.

Summary:

```text
Test Files  24 passed (24)
Tests       275 passed (275)
```

### Diff Hygiene

Command:

```bash
git diff --check
```

Result: PASS.

## Risk Checks

- `POST /api/agency/workflow-runs` stays compatible: PASS.
- Missing/incomplete app-map does not silently compile invalid workflows: PASS in service tests.
- Route never returns fake run/task IDs: PASS for unified workflow IDs; service rejects non-persisted compiled workflow IDs before execution.
- Deterministic execution remains app-map based: PASS locally; execution goes through `runCompiledWorkflow`.
- Legacy templates are examples only: PASS locally; direct template dispatch and edge template push/broadcast now return 410.
- App-map persistence ambiguity: PARTIAL PASS; DB remains runtime source, with durable `seeds/app-maps/{appId}.json` mirror/fallback.
