# verification — Phase 2 (L1+L2) / Phase 3 (L3)

Action Verification Cascade — 3 levels, cost crescător.

## What goes here

- `VerificationCascade.kt` — orchestrator: runs L1 → L2 → L3 based on strategy
- `L1UiTreeVerifier.kt` — UI tree diff + A11y event listener (zero cost, <100ms)
- `L2PixelDiffVerifier.kt` — screenshot before/after pixel comparison (zero cost, <500ms)
- `L3VlmVerifier.kt` — sends vision_verify_request to server → VLM (costs tokens, 1-5s)
- `VerificationResult.kt` — data class mirroring shared/protocol VerificationResult

## Verification strategies

| Strategy | Levels | When |
|----------|--------|------|
| `local_only` | L1 | scroll, navigate, open app |
| `local_with_screenshot` | L1 + L2 | tap standard elements |
| `full_cascade` | L1 + L2 + L3 | like, comment, follow |
| `vlm_required` | L3 direct | CAPTCHA check, ban detection |

## Phase 1 stub

```kotlin
// Phase 1: returns "none" — cascade not implemented yet
fun verify(jobId: String, strategy: String): VerificationResult = VerificationResult(
    verified = false,
    verifiedBy = "none",
    cascadeLevelsUsed = 0,
    confidence = 0f,
    llmTokensUsed = 0,
    verificationTimeMs = 0
)
```

## L1 implementation (Phase 2)

- Before action: capture UI tree snapshot
- Execute action
- After action (wait 2s max):
  - Check if A11y event received (click, state change, window change)
  - Check if UI tree diff shows expected change
  - If clear signal → return verified=true, verifiedBy="ui_tree"

## L2 implementation (Phase 2)

- Before action: screenshot (Region of Interest: target element + 20px margin)
- Execute action
- Wait `settleTimeMs` (default 500ms)
- After action: screenshot ROI
- Pixel diff > 5% → action had visible effect → confidence 0.7-0.8
- Pixel diff < 1% → no visual change → confidence 0.8 (negative result)
- Pixel diff 1-5% → ambiguous → escalate to L3

## L3 implementation (Phase 3)

- Send `VISION_REQUEST` with requestType="verify_action" to server
- Server routes to configured VLM provider
- VLM answers: did the action succeed?
- Log to vlm_usage_log via server
