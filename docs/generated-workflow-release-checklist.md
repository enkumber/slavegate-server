# Generated Workflow Release Checklist

Use this checklist before bumping the Umbrel Phone Network app for the generated workflow cache-first block.

## Baseline

- Current live Umbrel release: `3.9.20`
- Current live server commit: `d8398a1baf14b3b0441ec18d1af83804340c4796`
- Current unreleased server head: `9789dc531` (`fix: constrain generated workflow safety surface`)
- Release decision: do not bump Umbrel until server tests, review, QA, live non-mutating smoke, and metrics evidence are complete.

## Pre-Release Local Gate

Run from `/data/.openclaw/workspace/slavegate/server`:

```bash
npm run build
npm run test -- generated-workflow-canary workflow.blocking generated-workflow-cache generated-workflow-execution-smoke generated-workflow-prompt
npm run test -- workflows workflow-compiler
```

Required evidence:

- Build passes.
- Generated workflow targeted tests pass.
- Workflow/workflow-compiler regression tests pass.
- ECHO review is GO.
- LENS QA is GO.

## Live Verification Inputs

Set these locally before calling live endpoints:

```bash
export PHONE_NETWORK_BASE_URL="https://<umbrel-phone-network-base-url>"
export PHONE_NETWORK_API_TOKEN="<token>"
export DEVICE_ID="<edge-capable-device-id>"
```

Headers:

```bash
AUTH_HEADER=(-H "x-api-key: ${PHONE_NETWORK_API_TOKEN}" -H "content-type: application/json")
```

## Live Health Gate

```bash
curl -fsS "${AUTH_HEADER[@]}" "${PHONE_NETWORK_BASE_URL}/api/health"
curl -fsS "${AUTH_HEADER[@]}" "${PHONE_NETWORK_BASE_URL}/api/edge/status"
```

Required evidence:

- `/api/health` reports the expected `appVersion` and `buildCommit`.
- At least one edge-capable device is online.
- Selected `DEVICE_ID` is online and edge-capable.

## Cache-First Prompt Gate

Create a request key without executing:

```bash
curl -fsS "${AUTH_HEADER[@]}" \
  -X POST "${PHONE_NETWORK_BASE_URL}/api/workflows/generated/prompt" \
  --data '{
    "platform":"reddit",
    "appId":"com.reddit.frontpage",
    "goal":"Open Reddit home feed, wait for home to load, and checkpoint only. Do not vote, comment, post, join, follow, message, login, or change settings.",
    "clientContext":"release-checklist non-mutating smoke"
  }'
```

Required evidence:

- Response includes `requestKey`.
- On cache miss: `cacheHit=false`, `cacheMiss=true`, `canExecuteFromCache=false`.
- On cache hit: `cacheHit=true`, `cacheMiss=false`, `canExecuteFromCache=true`.

## Cache Persist Gate

Persist a non-mutating generated workflow with dry-run:

```bash
curl -fsS "${AUTH_HEADER[@]}" \
  -X POST "${PHONE_NETWORK_BASE_URL}/api/workflows/generated" \
  --data '{
    "dryRun": true,
    "persist": true,
    "requestKey": "<requestKey-from-prompt>",
    "workflow": {
      "id": "release_reddit_home_smoke_v1",
      "name": "Release Reddit home smoke",
      "platform": "reddit",
      "description": "Non-mutating release smoke: open Reddit, wait, checkpoint only.",
      "version": "1.0.0",
      "defaultVerificationStrategy": "local_with_screenshot",
      "dataRetentionDays": 1,
      "steps": [
        {
          "type": "action",
          "id": "open_reddit",
          "action": "open_app",
          "params": { "packageName": "com.reddit.frontpage" },
          "expectedScreen": "REDDIT_HOME_FEED",
          "timeoutMs": 15000
        },
        {
          "type": "wait",
          "id": "wait_for_home",
          "condition": "app_launched",
          "timeoutMs": 10000
        },
        {
          "type": "checkpoint",
          "id": "home_loaded",
          "reason": "Home feed reached or launch validated"
        }
      ]
    }
  }'
```

Required evidence:

- Response includes `cacheKey`, `requestKey`, `compiledPlan`.
- `compiledPlan.llmBudget.happyPathRequests=0`.
- `canExecuteFromCache=true`.
- No mutating actions are present in the persisted workflow.

## Cache-Only Dry-Run Gate

```bash
curl -fsS "${AUTH_HEADER[@]}" \
  -X POST "${PHONE_NETWORK_BASE_URL}/api/workflows/generated" \
  --data '{
    "dryRun": true,
    "requestKey": "<requestKey-from-prompt-or-persist>"
  }'
```

Required evidence:

- No `workflow` payload is supplied.
- Response has `cacheHit=true`.
- Response has `canExecuteFromCache=true`.
- Response has `compiledPlan.llmBudget.happyPathRequests=0`.

## Real-Device Non-Mutating Smoke

Only run after the cache-only dry-run gate passes:

```bash
curl -fsS "${AUTH_HEADER[@]}" \
  -X POST "${PHONE_NETWORK_BASE_URL}/api/workflows/generated" \
  --data '{
    "requestKey": "<requestKey-from-prompt-or-persist>",
    "deviceId": "'"${DEVICE_ID}"'"
  }'
```

Required evidence:

- Request has `requestKey` or `cacheKey` and `deviceId`.
- Request does not include a `workflow` payload.
- Response is accepted (`202`).
- Response has `generated=true`, `cacheHit=true`, `canExecuteFromCache=true`.
- Response has `compiledPlan.llmBudget.happyPathRequests=0`.
- Device receives existing `WORKFLOW_START` with cached workflow and workflow id.
- No vote/comment/post/join/follow/message/login/settings mutation is executed.

## Metrics Gate

Scrape metrics after the accepted cached execution:

```bash
curl -fsS "${PHONE_NETWORK_BASE_URL}/metrics" | grep 'phone_network_generated_workflow'
```

Required evidence:

- `phone_network_generated_workflow_cache_lookup_total{endpoint="execute",result="hit"}` increments.
- `phone_network_generated_workflow_executions_total{platform="reddit",cache_hit="true",source="request_key"}` or `source="cache_key"` increments.
- `phone_network_generated_workflow_llm_avoided_total{platform="reddit",reason="cache_hit"}` increments.
- No metric label includes `cacheKey`, `requestKey`, `templateId`, `deviceId`, prompt text, or client context.
- Offline, busy, cache-miss, or validation-failure requests do not increment `llm_avoided`.

## Safety Gate

Verify rejected generated workflows:

- Action `pm_uninstall` is rejected.
- Action `reboot` is rejected.
- Action `ota_update` is rejected.
- Action `screenshot_for_vlm` is rejected.
- Action `cascade_tap` is rejected.
- Action `file_delete` is rejected.
- Action `type_text` is rejected.
- Unknown platform such as `client-123` is rejected.

## Rollback Note

If release verification fails after Umbrel update:

- Do not continue real-device workflow execution.
- Roll Umbrel back to previous working release `3.9.20`.
- Preserve failed request/response bodies with secrets redacted.
- Keep the generated workflow cache keys/request keys for reproduction, but do not expose them as metric labels.
