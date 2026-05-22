# Story B Cache/Canonical Live Evidence

- capturedAt: 2026-05-22T12:14:40.811Z
- expected server head: a4b9d4f
- live appVersion: 3.9.22
- live buildCommit: fee20898441aa3bfb78b4a21bf02ceb4689c26c5
- device: acasa / d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd
- accountId: ac20c2ef-b2c5-476a-b5b1-2a27d1ebc722
- clientId: null
- requestKey: 7a3df17898fbc8f17954bda7
- cacheKey: ec8c5d11f064b0b9f854be4a
- workflowId: d34da9f4-b7f3-46dc-8741-643f99563cdf
- finalStatus: completed

## Contract

- generated: true
- cacheHit: true
- canExecuteFromCache: true
- canonicalWorkflowId: agent_generated_reddit_account_health_scan_v1
- canonicalWorkflowVersion: 1.0.0
- compiledPlanHash: 7aabef423c9184378a0bbb89def2aac2a6f353ff91fc9c4b459c24bdd6e37b19
- happyPathRequests: 0

## Action List

- open_app
- ui_tree_dump
- screenshot
- checkpoint

## Execution Stats

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

## Metrics Delta

```json
{
  "phone_network_generated_workflow_cache_lookup_total{endpoint=\"execute\",result=\"canonical_hit\",service=\"phone-network\"}": {
    "before": 4,
    "after": 6,
    "delta": 2
  },
  "phone_network_generated_workflow_executions_total{platform=\"reddit\",cache_hit=\"true\",source=\"request_key\",service=\"phone-network\"}": {
    "before": 1,
    "after": 2,
    "delta": 1
  },
  "phone_network_generated_workflow_llm_avoided_total{platform=\"reddit\",reason=\"cache_hit\",service=\"phone-network\"}": {
    "before": 1,
    "after": 2,
    "delta": 1
  }
}
```

## Story C Route

POST /api/agency/workflow-runs returned HTTP 404. Live build is still fee20898441aa3bfb78b4a21bf02ceb4689c26c5, so the Story C API is not deployed; no agency task-runner execution was attempted.

Raw request/response bodies are in 2026-05-22T12-14-40-808Z-story-b-cache-canonical-live-evidence.json.
