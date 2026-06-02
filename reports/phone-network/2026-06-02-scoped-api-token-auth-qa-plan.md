# Scoped API Token Auth QA Evidence

Story: `/data/.openclaw/workspace-atlas/stories/STORY-PN-SCOPED-API-TOKEN-AUTH-001.md`
Repo: `/data/.openclaw/workspace/slavegate/server`
Date: 2026-06-02
Owner: LENS
Status: PASS - live scoped-token smoke verified by Nox

## Verdict

Local QA passed and deployed live smoke passed using an `openclaw_agent` bearer token with no `X-API-Key`.

Raw token material was not printed.

## Local Evidence

Command:

```sh
npm test -- src/api/routes.monitoring-auth.test.ts src/api/auth.middleware.test.ts src/api/workflow-run-routes.test.ts src/api/agency-workflow-runs.test.ts
```

Result:

```text
PASS src/api/routes.monitoring-auth.test.ts  3 tests
PASS src/api/auth.middleware.test.ts        11 tests
PASS src/api/workflow-run-routes.test.ts     3 tests
PASS src/api/agency-workflow-runs.test.ts   10 tests
Total: 4 files, 27 tests passed
```

Command:

```sh
npm run build
```

Result:

```text
PASS TypeScript build completed
```

Local acceptance covered:

```text
GET  /api/debug/connections       -> 200 with openclaw_agent
GET  /api/scalability/status      -> 200 with openclaw_agent
POST /api/agency/workflow-runs    -> 401 with openclaw_agent in focused auth coverage
invalid/expired/revoked tokens    -> 401 in focused auth coverage
global API key compatibility      -> PASS in focused auth coverage
dashboard JWT compatibility       -> PASS in focused auth and real-router monitoring coverage
```

## Deployed Build Evidence

Target:

```text
http://enkzoned.go.ro:3000
```

Deployed server identity:

```text
appVersion=3.9.42
buildCommit=79add12e71201a4db79b8a81ff450e0b3fb4a525
```

This confirms the deployed server is no longer the old `d2524fe...` build.

Note: raw public manifest branch/CDN views may temporarily show stale `PHONE_NETWORK_APP_VERSION: "3.9.41"`. Live `/api/health` is the release gate evidence here and reports deployed `appVersion=3.9.42` with build commit `79add12e71201a4db79b8a81ff450e0b3fb4a525`.

## Live Smoke Evidence

Nox verified at `2026-06-02T08:50Z` against `http://enkzoned.go.ro:3000`.

Credential handling:

- Used `openclaw_agent` bearer token only.
- Did not send `X-API-Key`.
- Raw token was not printed.

Results:

```text
GET  /api/health                  -> 200, appVersion=3.9.42, buildCommit=79add12e71201a4db79b8a81ff450e0b3fb4a525
GET  /api/devices                 -> 200
GET  /api/debug/connections       -> 200
GET  /api/scalability/status      -> 200
POST /api/agency/workflow-runs    -> 401
```

## LENS Credential Note

LENS attempted an independent bearer-only rerun using the local persisted credential file at:

```text
/data/.openclaw/credentials/phone-network-api-token.json
```

That local persisted token currently verifies as invalid via `/api/device-tokens/verify`, and bearer-only requests with it returned 401. This appears to be a stale local credential file, not a deployed auth failure, because Nox verified the live smoke with a valid `openclaw_agent` bearer token and the deployed build is `79add12e71201a4db79b8a81ff450e0b3fb4a525`.

Recommended follow-up: update or replace the stale local credential file used by LENS/OpenClaw if it is still intended to be the monitoring token source.
