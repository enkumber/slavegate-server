# Scoped API Token Auth QA Evidence

Story: `/data/.openclaw/workspace-atlas/stories/STORY-PN-SCOPED-API-TOKEN-AUTH-001.md`
Repo: `/data/.openclaw/workspace/slavegate/server`
Date: 2026-06-02
Owner: LENS
Status: CHANGES REQUIRED - local QA found a route-level blocker

## Summary

VOLT's patch is present locally and the shared auth middleware now validates hashed `api_tokens` from the DB. Targeted tests and build pass, but the real `routes.ts` integration still blocks `openclaw_agent` from two required read-only monitoring endpoints.

Do not proceed to live smoke yet.

## Evidence Executed

Command:

```sh
npm test -- auth.middleware workflow-run-routes agency-workflow-runs
```

Result:

```text
PASS src/api/auth.middleware.test.ts        8 tests
PASS src/api/workflow-run-routes.test.ts    3 tests
PASS src/api/agency-workflow-runs.test.ts  10 tests
Total: 3 files, 21 tests passed
```

Command:

```sh
npm run build
```

Result:

```text
PASS TypeScript build completed
```

## Passing Local Coverage

- `src/api/auth.middleware.ts` validates `Authorization: Bearer <token>` by SHA-256 hash lookup in `api_tokens`.
- Unknown, expired, and revoked API tokens are rejected by focused middleware tests.
- `openclaw_agent` is denied on mutating workflow routes in focused middleware tests.
- `admin` API tokens are allowed on admin-only routes in focused middleware tests.
- Existing global API key compatibility is covered by focused middleware tests.
- `POST /api/workflow-runs` is explicitly protected by `requireAdminAuth`.
- `POST /api/agency/workflow-runs` is explicitly protected by `requireAdminAuth`.
- Token-management routes now use the shared admin guard.

## Blocker

`openclaw_agent` still cannot satisfy all required read-only monitoring routes in the real router.

Reason:

- `src/api/routes.ts:261` applies `router.use(requireApiGateAuth)`, which correctly treats `GET /debug/connections` and `GET /scalability/status` as monitoring-read paths.
- But `src/api/routes.ts:181` aliases `requireAuth = requireAdminAuth`.
- `src/api/routes.ts:2007` still declares `router.get("/debug/connections", requireAuth, ...)`.
- `src/api/routes.ts:2022` still declares `router.get("/scalability/status", requireAuth, ...)`.

So an `openclaw_agent` token can pass the first monitoring gate, then gets rejected by the second admin-only route guard. This fails the story requirement:

```text
GET /api/debug/connections       -> 200 with openclaw_agent
GET /api/scalability/status      -> 200 with openclaw_agent
```

Likely fix: remove the redundant route-level `requireAuth` on those two GET handlers or replace it with monitoring auth. The top-level gate already protects those paths.

## Current Acceptance Status

- `api_tokens` accepted by real auth layer using hashed token validation: PARTIAL PASS
- `openclaw_agent` can read `/api/devices`: LIKELY PASS by code path, pending route smoke
- `openclaw_agent` can read `/api/health`: LIKELY PASS by code path, because it is below `requireApiGateAuth` and has no second admin guard
- `openclaw_agent` can read `/api/debug/connections`: FAIL by route inspection
- `openclaw_agent` can read `/api/scalability/status`: FAIL by route inspection
- `openclaw_agent` denied on mutating workflow/admin routes: PASS locally for workflow routes
- invalid/expired/revoked tokens rejected: PASS in focused middleware tests
- global API key compatibility: PASS in focused middleware tests
- dashboard JWT compatibility: NOT YET EVIDENCED by focused test output
- live smoke proving monitoring no longer needs global API key: NOT RUN, blocked until local route issue is fixed and ECHO approves

## Required Re-Run After Fix

Run:

```sh
npm test -- auth.middleware workflow-run-routes agency-workflow-runs
npm run build
```

Then perform local route smoke or add an integration test that mounts the real `/api` router and proves:

```text
GET  /api/devices                 -> 200 with openclaw_agent
GET  /api/debug/connections       -> 200 with openclaw_agent
GET  /api/scalability/status      -> 200 with openclaw_agent
GET  /api/health                  -> 200 with openclaw_agent
POST /api/agency/workflow-runs    -> 401/403 with openclaw_agent
```

Only after that should live post-deploy smoke run with the existing `openclaw_agent` token and no global API key.

