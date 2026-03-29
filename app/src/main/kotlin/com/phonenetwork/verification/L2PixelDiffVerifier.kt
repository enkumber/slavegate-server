package com.phonenetwork.verification

import android.graphics.Bitmap
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * L2PixelDiffVerifier — zero-cost screenshot-based verification.
 * Takes before/after screenshots and computes pixel diff in ROI.
 *
 * Activated when L1 is inconclusive (no UI tree change detected).
 * Catches custom views, animations, and UI elements without A11y metadata.
 *
 * Coverage: +10-15% above L1 (total ~85-95% before needing VLM).
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §5.3
 */
class L2PixelDiffVerifier {
    companion object {
        private const val TAG = "PhoneNet/L2"

        // Thresholds from v3 §5.3
        private const val DIFF_THRESHOLD_HIGH  = 0.05f  // > 5% → action succeeded
        private const val DIFF_THRESHOLD_LOW   = 0.01f  // < 1% → nothing changed
        // 1-5% = ambiguous → escalate to L3
    }

    data class RoiBounds(
        val x: Int, val y: Int, val width: Int, val height: Int
    ) {
        fun expand(px: Int, imageWidth: Int, imageHeight: Int): RoiBounds = RoiBounds(
            x      = maxOf(0, x - px),
            y      = maxOf(0, y - px),
            width  = minOf(imageWidth - maxOf(0, x - px), width + px * 2),
            height = minOf(imageHeight - maxOf(0, y - px), height + px * 2)
        )
    }

    /**
     * Verify by comparing before/after screenshots.
     *
     * @param beforeBitmap   Screenshot taken BEFORE action (by VerificationCascade)
     * @param captureAfter   Lambda that captures a new screenshot (called after settle time)
     * @param roi            Region of interest (target element bounds). If null: full screen.
     * @param l2SettleMs     Time to wait after action before taking afterScreenshot
     * @param l1Result       L1 result to carry forward (cascade levels used)
     */
    suspend fun verify(
        beforeBitmap:   Bitmap,
        captureAfter:   suspend () -> Bitmap?,
        roi:            RoiBounds? = null,
        l2SettleMs:     Long = 500L,
        l1CascadeLevels: Int = 1
    ): VerificationResult = withContext(Dispatchers.Default) {
        val startTime = System.currentTimeMillis()

        // Wait for UI to settle
        delay(l2SettleMs)

        val afterBitmap = captureAfter()
        if (afterBitmap == null) {
            Log.w(TAG, "L2: failed to capture afterScreenshot — inconclusive")
            return@withContext VerificationResult(
                verified           = false,
                verifiedBy         = VerifiedBy.NONE,
                cascadeLevelsUsed  = l1CascadeLevels + 1,
                confidence         = 0f,
                llmTokensUsed      = 0,
                verificationTimeMs = System.currentTimeMillis() - startTime,
                note               = "L2 screenshot capture failed"
            )
        }

        // Ensure same dimensions
        val before = if (beforeBitmap.width == afterBitmap.width &&
                        beforeBitmap.height == afterBitmap.height) {
            beforeBitmap
        } else {
            Bitmap.createScaledBitmap(beforeBitmap, afterBitmap.width, afterBitmap.height, false)
        }

        // Compute diff in ROI (or full screen)
        val diffScore = computePixelDiff(before, afterBitmap, roi)
        val elapsed   = System.currentTimeMillis() - startTime

        Log.d(TAG, "L2 diff score: ${String.format("%.3f", diffScore)} (ROI: ${roi != null})")

        val result = when {
            diffScore > DIFF_THRESHOLD_HIGH -> {
                // > 5%: something changed — action likely succeeded
                VerificationResult(
                    verified           = true,
                    verifiedBy         = VerifiedBy.PIXEL_DIFF,
                    cascadeLevelsUsed  = l1CascadeLevels + 1,
                    confidence         = mapDiffToConfidence(diffScore),
                    llmTokensUsed      = 0,
                    verificationTimeMs = elapsed,
                    note               = "L2 diff=%.3f (>5%% threshold)".format(diffScore)
                )
            }
            diffScore < DIFF_THRESHOLD_LOW -> {
                // < 1%: nothing changed — action likely failed
                VerificationResult(
                    verified           = false,
                    verifiedBy         = VerifiedBy.PIXEL_DIFF,
                    cascadeLevelsUsed  = l1CascadeLevels + 1,
                    confidence         = 0.80f,
                    llmTokensUsed      = 0,
                    verificationTimeMs = elapsed,
                    note               = "L2 diff=%.3f (<1%% — no change)".format(diffScore)
                )
            }
            else -> {
                // 1-5%: ambiguous → needs L3 (VLM) in Phase 3
                VerificationResult(
                    verified           = false,
                    verifiedBy         = VerifiedBy.NONE,
                    cascadeLevelsUsed  = l1CascadeLevels + 1,
                    confidence         = 0f,
                    llmTokensUsed      = 0,
                    verificationTimeMs = elapsed,
                    note               = "L2 diff=%.3f (1-5%% ambiguous — L3 needed)".format(diffScore)
                )
            }
        }

        // Free after bitmap (before is owned by caller)
        afterBitmap.recycle()
        result
    }

    // ─── Pixel diff algorithm ─────────────────────────────────────────────────

    /**
     * Compute normalized pixel difference score between two bitmaps.
     * Crops to ROI if provided. Returns 0.0-1.0 (fraction of changed pixels).
     *
     * Uses absolute luminance diff per pixel (fast, no color space conversion).
     * Threshold per pixel: > 10 luminance units = "changed".
     */
    private fun computePixelDiff(
        before: Bitmap,
        after:  Bitmap,
        roi:    RoiBounds?
    ): Float {
        val cropBounds = roi?.expand(20, before.width, before.height)

        val bitmapA = if (cropBounds != null) {
            Bitmap.createBitmap(before, cropBounds.x, cropBounds.y, cropBounds.width, cropBounds.height)
        } else before

        val bitmapB = if (cropBounds != null) {
            Bitmap.createBitmap(after, cropBounds.x, cropBounds.y, cropBounds.width, cropBounds.height)
        } else after

        // Downsample for performance (max 320px wide for diff)
        val (sampleA, sampleB) = if (bitmapA.width > 320) {
            val scale = 320f / bitmapA.width
            val w = 320
            val h = (bitmapA.height * scale).toInt()
            Pair(
                Bitmap.createScaledBitmap(bitmapA, w, h, false),
                Bitmap.createScaledBitmap(bitmapB, w, h, false)
            )
        } else {
            Pair(bitmapA, bitmapB)
        }

        val width  = sampleA.width
        val height = sampleA.height
        val pixelsA = IntArray(width * height)
        val pixelsB = IntArray(width * height)
        sampleA.getPixels(pixelsA, 0, width, 0, 0, width, height)
        sampleB.getPixels(pixelsB, 0, width, 0, 0, width, height)

        var changedPixels = 0
        val totalPixels   = width * height

        for (i in 0 until totalPixels) {
            val pA = pixelsA[i]
            val pB = pixelsB[i]
            // Fast luminance: 0.299R + 0.587G + 0.114B ≈ (R*299 + G*587 + B*114) / 1000
            val rA = (pA shr 16) and 0xFF; val gA = (pA shr 8) and 0xFF; val bA = pA and 0xFF
            val rB = (pB shr 16) and 0xFF; val gB = (pB shr 8) and 0xFF; val bB = pB and 0xFF
            val lumA = (rA * 299 + gA * 587 + bA * 114) / 1000
            val lumB = (rB * 299 + gB * 587 + bB * 114) / 1000
            if (Math.abs(lumA - lumB) > 10) changedPixels++
        }

        // Cleanup scaled bitmaps
        if (sampleA !== bitmapA) sampleA.recycle()
        if (sampleB !== bitmapB) sampleB.recycle()
        if (cropBounds != null) {
            bitmapA.recycle()
            bitmapB.recycle()
        }

        return changedPixels.toFloat() / totalPixels
    }

    /** Map diff score to confidence: 0.05→0.7, 0.15→0.85, 0.30+→0.95 */
    private fun mapDiffToConfidence(diffScore: Float): Float {
        return when {
            diffScore >= 0.30f -> 0.95f
            diffScore >= 0.15f -> 0.85f
            diffScore >= 0.08f -> 0.75f
            else               -> 0.70f
        }
    }
}
