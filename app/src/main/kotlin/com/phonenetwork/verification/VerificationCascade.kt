package com.phonenetwork.verification

import android.graphics.Bitmap
import android.util.Log
import com.phonenetwork.accessibility.AgentAccessibilityService
import com.phonenetwork.vision.VisionClient
import com.phonenetwork.vision.ScreenElementMapper

/**
 * VerificationCascade — orchestrates L1 → L2 → L3 verification.
 *
 * Phase 2: L1 (UI tree diff) + L2 (pixel diff)
 * Phase 3: adds L3 (VLM via VISION_REQUEST)
 *
 * Responsibilities:
 * - Capture beforeSnapshot (L1) / beforeScreenshot (L2) BEFORE action
 * - After action: run cascade from cheapest to most expensive
 * - Stop at first conclusive result
 * - Return VerificationResult for JOB_RESULT payload
 *
 * Usage:
 *   val cascade = VerificationCascade(a11yService, strategy, l1TimeoutMs, l2SettleMs)
 *   val ctx = cascade.prepareBeforeAction()      // capture pre-action state
 *   // ... execute action ...
 *   val result = cascade.verifyAfterAction(ctx)  // run cascade
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §5
 */
class VerificationCascade(
    private val a11yService:   AgentAccessibilityService,
    private val strategy:      VerificationStrategy,
    private val l1TimeoutMs:   Long = 2000L,
    private val l2SettleMs:    Long = 500L,
    /** Lambda to capture screenshot — provided by CaptureController */
    private val captureScreen: suspend () -> Bitmap? = { null },
    /** VisionClient for L3 VLM calls — null means L3 not available */
    private val visionClient:  VisionClient? = null,
    /** Job ID for correlating VISION_REQUEST/RESULT */
    private val jobId:         String = "",
    /** Action type for VLM prompt template selection */
    private val actionType:    String = ""
) {
    companion object {
        private const val TAG = "PhoneNet/Cascade"
    }

    private val l1Verifier = L1UiTreeVerifier(a11yService)
    private val l2Verifier = L2PixelDiffVerifier()

    // ─── Pre-action context ───────────────────────────────────────────────────

    data class PreActionContext(
        val l1Snapshot:      L1UiTreeVerifier.UiSnapshot?,
        val l2BeforeBitmap:  Bitmap?,          // Non-null only when L2 is in strategy
        val capturedAt:      Long = System.currentTimeMillis()
    )

    /**
     * Capture pre-action state. Call immediately BEFORE executing the job.
     * Fast: L1 snapshot is <50ms. L2 screenshot adds ~200ms.
     */
    suspend fun prepareBeforeAction(): PreActionContext {
        if (strategy == VerificationStrategy.LOCAL_ONLY || strategy == VerificationStrategy.LOCAL_WITH_SCREENSHOT) {
            val l1Snapshot = if (strategy != VerificationStrategy.VLM_REQUIRED) {
                l1Verifier.captureSnapshot()
            } else null

            val l2Bitmap = if (strategy == VerificationStrategy.LOCAL_WITH_SCREENSHOT ||
                               strategy == VerificationStrategy.FULL_CASCADE) {
                captureScreen()
            } else null

            return PreActionContext(l1Snapshot, l2Bitmap)
        }

        // For unsupported strategies (full_cascade, vlm_required) in Phase 2 — capture both
        val snapshot = l1Verifier.captureSnapshot()
        val bitmap   = captureScreen()
        return PreActionContext(snapshot, bitmap)
    }

    /**
     * Run verification cascade after action execution.
     *
     * @param ctx       Pre-action context from prepareBeforeAction()
     * @param targetRoi Target element bounds for L2 ROI comparison (optional)
     */
    suspend fun verifyAfterAction(
        ctx:       PreActionContext,
        targetRoi: L2PixelDiffVerifier.RoiBounds? = null
    ): VerificationResult {
        Log.d(TAG, "Starting cascade (strategy=${strategy.value})")

        return when (strategy) {
            VerificationStrategy.LOCAL_ONLY -> {
                runL1(ctx)
            }

            VerificationStrategy.LOCAL_WITH_SCREENSHOT -> {
                val l1Result = runL1(ctx)
                if (l1Result.verified || l1Result.confidence > 0.7f) {
                    l1Result
                } else {
                    // L1 inconclusive → try L2
                    runL2(ctx, l1Result.cascadeLevelsUsed, targetRoi)
                }
            }

            VerificationStrategy.FULL_CASCADE,
            VerificationStrategy.VLM_REQUIRED -> {
                // Phase 3: Full cascade — L1 → L2 → L3 (VLM)
                val l1Result = runL1(ctx)
                if (l1Result.verified && l1Result.confidence >= 0.85f) {
                    return l1Result
                }
                val l2Result = runL2(ctx, l1Result.cascadeLevelsUsed, targetRoi)
                if (l2Result.verified && l2Result.confidence >= 0.7f) {
                    return l2Result
                }
                // L1+L2 inconclusive or failed — escalate to L3 VLM
                runL3(ctx, l2Result.cascadeLevelsUsed)
            }
        }
    }

    // ─── Level runners ────────────────────────────────────────────────────────

    private suspend fun runL1(ctx: PreActionContext): VerificationResult {
        if (ctx.l1Snapshot == null) {
            return VerificationResult.none().copy(note = "L1 snapshot not available")
        }
        return l1Verifier.verify(ctx.l1Snapshot, l1TimeoutMs)
    }

    private suspend fun runL3(
        ctx:          PreActionContext,
        prevLevels:   Int
    ): VerificationResult {
        val client = visionClient
        if (client == null) {
            Log.w(TAG, "L3 requested but VisionClient not available")
            return VerificationResult(
                verified           = false,
                verifiedBy         = VerifiedBy.NONE,
                cascadeLevelsUsed  = prevLevels + 1,
                confidence         = 0f,
                llmTokensUsed      = 0,
                verificationTimeMs = 0,
                note               = "L3 unavailable — VisionClient not configured"
            )
        }
        val start = System.currentTimeMillis()
        // Capture fresh screenshot for VLM (post-action state)
        val bitmap = captureScreen()
        if (bitmap == null) {
            Log.w(TAG, "L3: screenshot capture failed — cannot run VLM")
            return VerificationResult(
                verified           = false,
                verifiedBy         = VerifiedBy.NONE,
                cascadeLevelsUsed  = prevLevels + 1,
                confidence         = 0f,
                llmTokensUsed      = 0,
                verificationTimeMs = System.currentTimeMillis() - start,
                note               = "L3 failed — screenshot not available"
            )
        }
        val effectiveJobId = jobId.ifEmpty { "cascade_${System.currentTimeMillis()}" }
        // recycle bitmap in finally — ScreenshotOptimizer già ha encoded to base64, bitmap non più necessario
        val result = try {
            client.requestVerification(bitmap, effectiveJobId, actionType)
        } finally {
            bitmap.recycle()
        }
        val elapsed = System.currentTimeMillis() - start

        if (result == null) {
            Log.w(TAG, "L3 timeout — no VISION_RESULT received")
            return VerificationResult(
                verified           = false,
                verifiedBy         = VerifiedBy.NONE,
                cascadeLevelsUsed  = prevLevels + 1,
                confidence         = 0f,
                llmTokensUsed      = 0,
                verificationTimeMs = elapsed,
                note               = "L3 timeout"
            )
        }

        val success    = result.optBoolean("success", false)
        val confidence = result.optDouble("confidence", 0.5).toFloat().coerceIn(0f, 1f)
        val tokens     = result.optInt("tokensUsed", 0)
        val note       = result.optString("observation", "")

        Log.d(TAG, "L3 result: success=$success confidence=$confidence tokens=$tokens")
        return VerificationResult(
            verified           = success,
            verifiedBy         = if (success) VerifiedBy.VLM else VerifiedBy.NONE,
            cascadeLevelsUsed  = prevLevels + 1,
            confidence         = confidence,
            llmTokensUsed      = tokens,
            verificationTimeMs = elapsed,
            note               = note.ifEmpty { null }
        )
    }

    private suspend fun runL2(
        ctx:             PreActionContext,
        l1LevelsUsed:    Int,
        targetRoi:       L2PixelDiffVerifier.RoiBounds?
    ): VerificationResult {
        if (ctx.l2BeforeBitmap == null) {
            Log.d(TAG, "L2 skipped — no beforeBitmap captured (strategy may not require it)")
            return VerificationResult(
                verified           = false,
                verifiedBy         = VerifiedBy.NONE,
                cascadeLevelsUsed  = l1LevelsUsed + 1,
                confidence         = 0f,
                llmTokensUsed      = 0,
                verificationTimeMs = 0,
                note               = "L2 skipped — screenshot not captured for strategy"
            )
        }

        return l2Verifier.verify(
            beforeBitmap    = ctx.l2BeforeBitmap,
            captureAfter    = captureScreen,
            roi             = targetRoi,
            l2SettleMs      = l2SettleMs,
            l1CascadeLevels = l1LevelsUsed
        )
    }
}
