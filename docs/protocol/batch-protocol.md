# Batch Protocol Specification

**Version:** 1.0.0
**Date:** 2026-04-20
**Status:** Draft

---

## Overview

The Batch Protocol enables **Fast-Path** workflow execution by sending multiple workflow steps to the device in a single message. The device executes all steps locally and returns results in a single message.

**Primary benefit:** Eliminates 8-10s network latency per step. A 10-step workflow that took 80-100s now takes ~2-3s (execution time only).

---

## Message Flow

```
Server                          Device
  |                                |
  |  1. BATCH_START ──────────────>|
  |      (all steps bundled)        |
  |                                |
  |                    2. Local execution
  |                    (no server contact)
  |                    3. Local verification (if configured)
  |                                |
  |  <───────── BATCH_RESULT ──────|
  |      (all results bundled)     |
  |                                |
  4. Server processes results
     - Persists to DB
     - Schedules next batch or completes workflow
```

---

## BATCH_START (Server → Device)

### Schema

```json
{
  "type": "BATCH_START",
  "batchId": "string (UUID)",
  "workflowId": "string (UUID)",
  "stepIndex": "number (starting step index)",
  "steps": "Step[]",
  "options": {
    "continueOnError": "boolean (default: false)",
    "timeoutMs": "number (per-step timeout, default: 30000)"
  }
}
```

### Step Schema

```json
{
  "id": "number (1-based step number within batch)",
  "type": "action | wait | condition | loop",
  "action": "string (tap|type|swipe|keyevent|press_back|open_app|etc.)",
  "target": "string | null (element name or null for wait/keyevent)",
  "params": {
    "x": "number (0.0-1.0, normalized, for tap)",
    "y": "number (0.0-1.0, normalized, for tap)",
    "text": "string (for type action)",
    "direction": "up|down|left|right (for swipe)",
    "durationMs": "number (for swipe)"
  },
  "verify": "VerificationConfig | null"
}
```

### VerificationConfig Schema

```json
{
  "type": "ui_tree | pixel_diff | vision | none",
  "expectedScreen": "string (screen identifier, optional)",
  "timeoutMs": "number (verification timeout, default: 5000)"
}
```

### Example

```json
{
  "type": "BATCH_START",
  "batchId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "workflowId": "wf-abc123",
  "stepIndex": 5,
  "options": {
    "continueOnError": false,
    "timeoutMs": 30000
  },
  "steps": [
    {
      "id": 1,
      "type": "action",
      "action": "tap",
      "target": "post.like",
      "params": { "x": 0.9, "y": 0.5 },
      "verify": { "type": "ui_tree", "expectedScreen": "post_liked" }
    },
    {
      "id": 2,
      "type": "wait",
      "action": "wait",
      "target": null,
      "params": { "durationMs": 1500 },
      "verify": null
    },
    {
      "id": 3,
      "type": "action",
      "action": "tap",
      "target": "post.comment",
      "params": { "x": 0.8, "y": 0.5 },
      "verify": { "type": "pixel_diff", "template": "comment_box" }
    }
  ]
}
```

---

## BATCH_RESULT (Device → Server)

### Schema

```json
{
  "type": "BATCH_RESULT",
  "batchId": "string (must match BATCH_START.batchId)",
  "workflowId": "string",
  "status": "completed | partial_failure | failed",
  "results": "StepResult[]",
  "executedAt": "ISO8601 timestamp"
}
```

### StepResult Schema

```json
{
  "id": "number (matches step id from BATCH_START)",
  "status": "success | failed | skipped | timeout",
  "durationMs": "number",
  "output": {
    "x": "number (actual coords tapped)",
    "y": "number",
    "screenAfter": "string (screen identifier)",
    "verificationPassed": "boolean"
  },
  "error": "string | null (error message if failed)"
}
```

### Example

```json
{
  "type": "BATCH_RESULT",
  "batchId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "workflowId": "wf-abc123",
  "status": "partial_failure",
  "executedAt": "2026-04-20T15:30:00.000Z",
  "results": [
    {
      "id": 1,
      "status": "success",
      "durationMs": 245,
      "output": {
        "x": 0.9,
        "y": 0.5,
        "screenAfter": "post_liked",
        "verificationPassed": true
      },
      "error": null
    },
    {
      "id": 2,
      "status": "success",
      "durationMs": 1500,
      "output": {},
      "error": null
    },
    {
      "id": 3,
      "status": "failed",
      "durationMs": 5000,
      "output": {},
      "error": "Element 'post.comment' not found after 3 attempts"
    }
  ]
}
```

---

## Error Handling

### ContinueOnError = false (default)
- Batch stops at first failure
- Returns `status: "partial_failure"` or `"failed"`
- Server marks workflow as failed and pauses for manual review

### ContinueOnError = true
- Batch continues through remaining steps
- Failed steps recorded with error details
- Returns `status: "partial_failure"` at end
- Server continues workflow (or marks for retry based on retry config)

---

## Timeout Behavior

| Scenario | Behavior |
|----------|----------|
| Single step timeout | Step marked `failed`, batch continues or stops based on `continueOnError` |
| Batch timeout (total) | All remaining steps marked `skipped`, batch ends |
| No response from device | Server marks batch as `failed` after `timeoutMs * steps.length * 1.5` |

---

## Verification Integration

### Pre-execution (L0 from DB)
Device checks `coordCacheService.getCoord()` before executing each tap step.
- If coords found and element is "fixed" → use cached coords directly
- If not found → use cascade (L1→L2→L3) BEFORE batch starts

### Post-execution Verification
After each step completes, device verifies:
- `ui_tree`: Check expected element exists in accessibility tree
- `pixel_diff`: Compare screenshot to template
- `vision`: Send to VLM for analysis (server-side, after batch returns)
- `none`: No verification

**Note:** Verification happens LOCAL on device during batch execution. This is different from cascade where verification is server-side.

---

## Security Considerations

1. **Device trust:** Device must validate `batchId` and `workflowId` match local state
2. **Auth:** BATCH_START requires valid WebSocket connection (already authenticated)
3. **Rate limiting:** Batch execution counts as 1 message for rate limit purposes
4. **Timeouts:** Server should not wait indefinitely for BATCH_RESULT

---

## Compatibility

### With Existing DirectWs Protocol
BATCH_START is a new message type added to the existing protocol:
```json
{ "type": "BATCH_START", ... }
```

The existing JOB / JOB_RESULT messages remain functional for non-batch workflows.

### With Cascade Tap
Cascade happens BEFORE batch execution (server-side):
1. Server determines batch of steps
2. For each tap step, server runs cascade to resolve coords
3. Resolved coords embedded in BATCH_START.steps[].params
4. Device executes batch with pre-resolved coords

### With Workflow Executor
- Workflow executor groups steps into batches (configurable batch size)
- Default: 1 batch = 10 steps or until first conditional/loop
- Checkpoint saved BEFORE sending batch
- On resume: re-send remaining steps from checkpoint

---

## Implementation Notes

### Server-Side (TypeScript)
```typescript
interface BatchProtocol {
  createBatch(steps: WorkflowStep[], startIndex: number): BATCH_START
  parseBatchResult(raw: unknown): BATCH_RESULT
  validateBatchResult(result: BATCH_RESULT): boolean
}
```

### Client-Side (Kotlin/Android)
```kotlin
class BatchExecutor {
    suspend fun executeBatch(batch: BATCH_START): BATCH_RESULT
    fun validateStep(step: Step): Boolean
    fun verifyStep(step: Step, screenshot: Bitmap): Boolean
}
```

---

## Future Enhancements

1. **Streaming results:** Device sends step results as it completes (reduce latency further)
2. **Parallel execution:** Device executes independent steps in parallel (requires dependency graph)
3. **Batch persistence:** Device checkpoints batch progress locally (survive device restart mid-batch)
