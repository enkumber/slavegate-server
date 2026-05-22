# Reddit Account Health Scan Live Evidence

- capturedAt: 2026-05-22T11:57:53.070Z
- live appVersion: 3.9.22
- live buildCommit: fee20898441aa3bfb78b4a21bf02ceb4689c26c5
- selectedDevice: acasa (d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd), edgeCapable=true, agentVersion=4.0.22
- accountId: ac20c2ef-b2c5-476a-b5b1-2a27d1ebc722
- requestKey: 7a3df17898fbc8f17954bda7
- cacheKey: ec8c5d11f064b0b9f854be4a
- workflowId: 2095a4d0-0f80-4260-942c-a13b1c00ae60
- finalStatus: completed

## Execution Request

Used requestKey + full UUID deviceId + accountId only. No workflow payload in execution request.

## Response Contract

- generated: true
- cacheHit: true
- canExecuteFromCache: true
- happyPathRequests: 0

## Final Execution Stats

```json
{
  "mode": "edge",
  "vlmCalls": 0,
  "failedSteps": 0,
  "batchedSteps": 0,
  "retriedSteps": 0,
  "compileLlmCalls": 0,
  "runtimeLlmCalls": 0,
  "creativeLlmCalls": 0,
  "recoveryLlmCalls": 0,
  "deterministicSteps": 4
}
```

## Output Fields

Exact requested output fields were used in schema and request variables: loggedIn, homeFeedVisible, searchSurfaceAvailable, challengeDetected, loginWallDetected, accountSwitcherVisible, observedUsername, error. Live edge checkpoint returned variables as an empty object, so final output field materialization remains a live agent/reporting gap.

## Safety

Actions: open_app, ui_tree_dump, screenshot, checkpoint. Mutation detected in workflow: false.

## Metrics Delta

```json
{
  "phone_network_generated_workflow_cache_lookup_total{endpoint=\"execute\",result=\"canonical_hit\",service=\"phone-network\"}": {
    "before": 2,
    "after": 4,
    "delta": 2
  },
  "phone_network_generated_workflow_cache_lookup_total{endpoint=\"prompt\",result=\"miss\",service=\"phone-network\"}": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "phone_network_generated_workflow_cache_lookup_total{endpoint=\"resolve\",result=\"miss\",service=\"phone-network\"}": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "phone_network_generated_workflow_cache_lookup_total{endpoint=\"resolve\",result=\"compiled_new\",service=\"phone-network\"}": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "phone_network_generated_workflow_executions_total{platform=\"reddit\",cache_hit=\"true\",source=\"request_key\",service=\"phone-network\"}": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "phone_network_generated_workflow_llm_avoided_total{platform=\"reddit\",reason=\"cache_hit\",service=\"phone-network\"}": {
    "before": 0,
    "after": 1,
    "delta": 1
  }
}
```

## Task Runner Blocker

Live /api/health reports buildCommit fee20898441aa3bfb78b4a21bf02ceb4689c26c5 and /api/workflows/generated/schema lacks generated_workflow task-runner contract. To avoid unsafe fallback to generic LLM orchestrator, no live task-runner execution was attempted before a deployment containing the generated_workflow task-runner handler.
