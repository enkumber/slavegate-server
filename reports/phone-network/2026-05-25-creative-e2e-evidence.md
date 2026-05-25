# Creative E2E Integration Evidence

- capturedAt: 2026-05-25T20:20:17Z
- story: Creative E2E integration complet
- scope: `POST /api/creative-workflows`, persisted creative queue path, API status contract, tests

## Implementation

- Added top-level REST endpoint: `POST /api/creative-workflows`
- Kept existing agency endpoint aligned: `POST /api/agency/creative-workflows`
- Replaced fake UUID run/task behavior with DB transaction:
  - validates client/account/device/objective input
  - validates account/client/platform
  - resolves cache-safe `reddit_account_health_scan` generated workflow artifact
  - inserts `agency_workflow_runs`
  - inserts queued `tasks` row with `routine='generated_workflow'`
  - links `agency_workflow_runs.task_id`
  - publishes workflow `queued` event for dashboard streaming
- Dry-run remains proposal-only and does not touch DB.
- Unsupported or invalid live execution returns `not_ready` with explicit codes instead of fake IDs.

## Verification

```text
cd server && npm test -- creative-workflow creative-workflow-routes
PASS 2 files / 13 tests
```

```text
cd server && npx tsc --noEmit --pretty false
PASS
```

```text
cd server && npm test
PASS 22 files / 265 tests
```

```text
cd server && npm run build
PASS
```

```text
cd server && git diff --check
PASS
```

## Endpoint Test

`src/api/creative-workflow-routes.test.ts` starts an Express listener and sends real HTTP `fetch` requests to:

```text
POST /api/creative-workflows
```

Covered response contracts:

- `201` for queued creative workflow runs
- `400` for missing required fields
- `409` for not-ready generated workflow artifact states

## Live Device Endpoint Attempt

Live curl/device execution was not run from this container because the configured local DB was unavailable:

```text
node -r dotenv/config <db candidate query>
connect ECONNREFUSED 127.0.0.1:5432
```

No live task was queued on a real device from this environment.

## Remaining Runtime Gap

The endpoint queues the generated workflow task and persists the initial creative report in `agency_workflow_runs.output`. It does not hold the HTTP response open until task completion. Final output/report enrichment should be handled by the existing task completion path for `agency_workflow_runs` or by a follow-up wait/report API if synchronous behavior is required.
