# US-WORKFLOW-SCREEN-VERIFY

## Story: Integrare automată Screen Detection după fiecare workflow step

**Epic:** Workflow Engine Hardening  
**Sprint:** S-2026-04-A  
**Priority:** P1 (reliability feature)  
**Owner:** FORGE 🔨  
**Status:** ✅ Done — 2026-03-29 (VOLT ⚡)

---

## 📋 Context

Modulul Screen Detection Cascade există și funcționează:
- **Service:** `src/modules/screen-detection/screen-detection.service.ts`
- **Cascade:** L1 (UI Tree) → L2 (OCR) → L3 (VLM)
- **Feature flag:** `SCREEN_DETECTION_CASCADE_ENABLED=true`
- **APK:** v2.6.4 cu `ocr_full` handler

**Problema:** Workflow executor-ul execută pași fără să verifice dacă device-ul a ajuns pe ecranul așteptat. Dacă un tap eșuează silențios sau app-ul navighează greșit, workflow-ul continuă orb.

---

## 🎯 Cerință

După **fiecare pas** dintr-un workflow, sistemul trebuie să:

1. **Detectează ecranul curent** via `screenDetectionService.detectScreen()`
2. **Compară** cu `expectedScreen` definit în step sau template
3. **Decide:** continue / retry / abort

---

## 🔧 Technical Design

### 1. Type Extensions

**`src/modules/workflows/types.ts`** — extinde `ActionStep`:

```typescript
export interface ActionStep {
  // ... existing fields ...
  
  /**
   * Expected screen after action completes.
   * If set, workflow executor verifies via Screen Detection Cascade.
   * Supports single screen or array (for ambiguous transitions).
   */
  expectedScreen?: ScreenId | ScreenId[];
  
  /**
   * Minimum confidence threshold for screen match (default: 0.75).
   * Lower = more lenient, higher = stricter verification.
   */
  screenConfidenceThreshold?: number;
  
  /**
   * Retry config for screen mismatch.
   * Default: { maxRetries: 2, delayMs: 500, action: 'retry_step' }
   */
  screenMismatchPolicy?: ScreenMismatchPolicy;
}

export interface ScreenMismatchPolicy {
  maxRetries: number;           // How many times to retry the step
  delayMs: number;              // Delay before retry
  action: 'retry_step' | 'abort' | 'continue_with_warning';
}
```

### 2. Screen Verification Module

**Nou fișier:** `src/modules/workflows/screen-verifier.ts`

```typescript
import { screenDetectionService } from '../screen-detection/screen-detection.service';
import type { ScreenId, DetectedScreen } from '../screen-detection/types';
import type { ScreenMismatchPolicy } from './types';
import { getDb } from '../../db/client';

export interface ScreenVerificationResult {
  match: boolean;
  detected: DetectedScreen;
  expected: ScreenId | ScreenId[];
  confidenceMet: boolean;
  shouldRetry: boolean;
  shouldAbort: boolean;
}

const DEFAULT_POLICY: ScreenMismatchPolicy = {
  maxRetries: 2,
  delayMs: 500,
  action: 'retry_step',
};

const DEFAULT_CONFIDENCE = 0.75;

export async function verifyScreenAfterStep(params: {
  deviceId: string;
  platform: string;
  workflowId: string;
  stepIndex: number;
  expectedScreen: ScreenId | ScreenId[];
  confidenceThreshold?: number;
  policy?: ScreenMismatchPolicy;
  currentRetry?: number;
}): Promise<ScreenVerificationResult> {
  const {
    deviceId,
    platform,
    workflowId,
    stepIndex,
    expectedScreen,
    confidenceThreshold = DEFAULT_CONFIDENCE,
    policy = DEFAULT_POLICY,
    currentRetry = 0,
  } = params;

  const start = Date.now();
  
  // Clear cache to ensure fresh detection
  screenDetectionService.clearCache(deviceId);
  
  // Run cascade detection
  const detected = await screenDetectionService.detectScreen({
    deviceId,
    platform,
    timeoutMs: 5_000,
    skipCache: true,
  });

  // Check match
  const expectedArray = Array.isArray(expectedScreen) ? expectedScreen : [expectedScreen];
  const match = expectedArray.includes(detected.screenId);
  const confidenceMet = detected.confidence >= confidenceThreshold;
  
  const result: ScreenVerificationResult = {
    match: match && confidenceMet,
    detected,
    expected: expectedScreen,
    confidenceMet,
    shouldRetry: false,
    shouldAbort: false,
  };

  // Determine action on mismatch
  if (!result.match) {
    if (currentRetry < policy.maxRetries && policy.action === 'retry_step') {
      result.shouldRetry = true;
    } else if (policy.action === 'abort' || currentRetry >= policy.maxRetries) {
      result.shouldAbort = true;
    }
    // 'continue_with_warning' — neither retry nor abort
  }

  // Log to DB for metrics/observability
  await logVerification(workflowId, stepIndex, detected, expectedArray, result.match, Date.now() - start);

  console.log(
    `[screen-verify] ${workflowId} step ${stepIndex}: ` +
    `detected=${detected.screenId} (${detected.confidence.toFixed(2)}), ` +
    `expected=[${expectedArray.join(',')}], match=${result.match}, ` +
    `method=${detected.method}, latency=${detected.latencyMs}ms`
  );

  return result;
}

async function logVerification(
  workflowId: string,
  stepIndex: number,
  detected: DetectedScreen,
  expected: ScreenId[],
  match: boolean,
  totalLatencyMs: number,
): Promise<void> {
  const db = getDb();
  await db.query(
    `INSERT INTO workflow_screen_verifications
       (workflow_id, step_index, detected_screen, detected_confidence, 
        detection_method, expected_screens, match, latency_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      workflowId,
      stepIndex,
      detected.screenId,
      detected.confidence,
      detected.method,
      expected,
      match,
      totalLatencyMs,
    ]
  ).catch(err => {
    console.warn(`[screen-verify] Failed to log verification: ${err.message}`);
  });
}
```

### 3. Workflow Executor Integration

**Modificări în `workflow.executor.ts`:**

```typescript
// În executeActionStep(), DUPĂ action completă și DUPĂ HBE post-delay:

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN VERIFICATION: Verify we landed on expected screen
// ═══════════════════════════════════════════════════════════════════════════
if (step.expectedScreen && process.env.SCREEN_DETECTION_CASCADE_ENABLED === 'true') {
  const verifyResult = await verifyScreenAfterStep({
    deviceId,
    platform,
    workflowId,
    stepIndex,
    expectedScreen: step.expectedScreen,
    confidenceThreshold: step.screenConfidenceThreshold,
    policy: step.screenMismatchPolicy,
    currentRetry: 0,  // Track via step param or checkpoint
  });

  if (verifyResult.shouldAbort) {
    throw new Error(
      `Screen mismatch at step ${stepIndex}: expected [${
        Array.isArray(step.expectedScreen) ? step.expectedScreen.join(',') : step.expectedScreen
      }], got ${verifyResult.detected.screenId} (${verifyResult.detected.confidence.toFixed(2)})`
    );
  }

  if (verifyResult.shouldRetry) {
    console.log(`[workflow] ${workflowId} step ${stepIndex}: screen mismatch, retrying...`);
    await sleep(step.screenMismatchPolicy?.delayMs ?? 500);
    // Recursive retry with incremented counter
    await executeActionStep(
      workflowId, deviceId, template,
      { ...step, _screenRetryCount: (step._screenRetryCount ?? 0) + 1 },
      checkpoint, stepIndex
    );
    return;
  }

  // Continue with warning (logged, but not blocking)
  if (!verifyResult.match) {
    console.warn(
      `[workflow] ${workflowId} step ${stepIndex}: screen mismatch (warning mode), continuing`
    );
  }
}
```

### 4. Database Migration

**`migrations/20260329_workflow_screen_verifications.sql`:**

```sql
CREATE TABLE IF NOT EXISTS workflow_screen_verifications (
  id              SERIAL PRIMARY KEY,
  workflow_id     TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  detected_screen TEXT NOT NULL,
  detected_confidence NUMERIC(4,3) NOT NULL,
  detection_method TEXT NOT NULL,
  expected_screens TEXT[] NOT NULL,
  match           BOOLEAN NOT NULL,
  latency_ms      INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT fk_workflow FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_screen_verify_wf ON workflow_screen_verifications(workflow_id);
CREATE INDEX idx_workflow_screen_verify_match ON workflow_screen_verifications(match);
CREATE INDEX idx_workflow_screen_verify_time ON workflow_screen_verifications(created_at);

-- Metrics view pentru observability
CREATE OR REPLACE VIEW workflow_screen_verification_stats AS
SELECT 
  DATE(created_at) AS date,
  detection_method,
  COUNT(*) AS total_verifications,
  SUM(CASE WHEN match THEN 1 ELSE 0 END) AS matches,
  ROUND(AVG(CASE WHEN match THEN 1 ELSE 0 END) * 100, 2) AS match_rate_pct,
  ROUND(AVG(latency_ms), 2) AS avg_latency_ms,
  ROUND(AVG(detected_confidence) * 100, 2) AS avg_confidence_pct
FROM workflow_screen_verifications
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at), detection_method
ORDER BY date DESC, detection_method;
```

### 5. Skill File Extension

Adaugă `after_screen` la step definitions în skill files:

```yaml
# În instagram.skill — exemplu follow workflow
workflows:
  follow_from_hashtag:
    steps:
      - action: tap
        target: hashtag.open
        expectedScreen: HASHTAG_FEED
        
      - action: tap
        target: profile.first_result
        expectedScreen: PROFILE_OTHER
        screenMismatchPolicy:
          maxRetries: 3
          delayMs: 1000
          action: retry_step
          
      - action: tap
        target: follow_button
        expectedScreen: [PROFILE_OTHER]  # rămâne pe profil
```

---

## 📊 Observability

### Metrici expuse

1. **`workflow.screen_verify.total`** — counter per workflow
2. **`workflow.screen_verify.match_rate`** — gauge 0-100%
3. **`workflow.screen_verify.latency_ms`** — histogram
4. **`workflow.screen_verify.method_breakdown`** — L1/L2/L3 usage
5. **`workflow.screen_verify.retry_count`** — retries per step

### Dashboard Panels

- Match rate by workflow template
- Latency percentiles (p50, p95, p99)
- Top 10 failing screen transitions
- Method cascade fallback frequency

---

## ✅ Acceptance Criteria

- [ ] **AC1:** După fiecare `ActionStep` cu `expectedScreen`, se apelează `verifyScreenAfterStep()`
- [ ] **AC2:** Log-uri clare cu `detected`, `expected`, `match`, `method`, `latency`
- [ ] **AC3:** Retry logic funcțional (default 2 retries, configurable)
- [ ] **AC4:** Abort pe mismatch persistent (după epuizarea retry-urilor)
- [ ] **AC5:** Tabel `workflow_screen_verifications` cu toate datele
- [ ] **AC6:** View `workflow_screen_verification_stats` pentru metrici
- [ ] **AC7:** Feature flag `SCREEN_DETECTION_CASCADE_ENABLED` respectat
- [ ] **AC8:** Backward compatible — steps fără `expectedScreen` nu sunt afectate

---

## 📁 Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/modules/workflows/types.ts` | MODIFY | Add `expectedScreen`, `screenConfidenceThreshold`, `screenMismatchPolicy` |
| `src/modules/workflows/screen-verifier.ts` | CREATE | Verification logic + logging |
| `src/modules/workflows/workflow.executor.ts` | MODIFY | Integrate verification call |
| `migrations/20260329_workflow_screen_verifications.sql` | CREATE | DB schema |
| `src/modules/skills/templates/instagram.skill` | MODIFY | Add `expectedScreen` to example steps |

---

## 🧪 Test Scenarios

### Unit Tests (`screen-verifier.test.ts`)

1. **Match case:** detected = expected → `match: true`
2. **Array match:** detected în expected[] → `match: true`
3. **Mismatch + retry:** detected ≠ expected, retry < max → `shouldRetry: true`
4. **Mismatch + abort:** detected ≠ expected, retry ≥ max → `shouldAbort: true`
5. **Low confidence:** detected = expected dar confidence < threshold → `match: false`
6. **Continue warning:** policy.action = 'continue_with_warning' → neither retry nor abort

### Integration Tests

1. Workflow cu 3 steps, expectedScreen pe fiecare — verify all pass
2. Workflow cu step care duce la ecran greșit — verify retry happens
3. Workflow cu mismatch persistent — verify abort after retries

---

## 🚀 Rollout Plan

1. **Implement behind feature flag** (deja `SCREEN_DETECTION_CASCADE_ENABLED`)
2. **Soft launch:** `screenMismatchPolicy.action = 'continue_with_warning'` pentru toate
3. **Monitor metrics** 7 zile — target 95%+ match rate
4. **Hard enforcement:** Switch default to `retry_step` apoi `abort`

---

## 👥 Team Assignments

| Role | Agent | Responsibility |
|------|-------|----------------|
| Tech Lead | FORGE 🔨 | Story definition, architecture review |
| Implementation | VOLT ⚡ sau SPARK 💡 | Code changes, tests |
| QA | LENS 🔍 | Test scenarios, edge cases |
| Review | ECHO 📡 | Code review, integration check |

---

## 📎 References

- `US-SCREEN-CASCADE` — Screen Detection Cascade implementation
- `ARCHITECTURE_AUDIT_v3.md §8` — Workflow Engine design
- `HYDRA-CORE.md` — Core rules for screen handling

---

**Created:** 2026-03-29  
**Author:** FORGE 🔨  
**Request:** Dan via Nox
