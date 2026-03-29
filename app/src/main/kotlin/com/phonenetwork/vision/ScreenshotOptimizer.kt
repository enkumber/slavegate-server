package com.phonenetwork.vision

import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * ScreenshotOptimizer — resize + compress Bitmap before sending to VLM.
 *
 * Why:
 * - Full 1080×1920 JPEG ≈ 500KB+ — slow upload, expensive tokens
 * - Resized 720×1280 JPEG at 80% ≈ 80-120KB — VLM accuracy unaffected
 * - Max width 1280px matches VLM_MAX_WIDTH on server
 *
 * Usage:
 *   val b64 = ScreenshotOptimizer.optimizeForVlm(bitmap)
 *   val b64Full = ScreenshotOptimizer.optimizeForL2(bitmap)  // larger, for pixel diff only
 */
object ScreenshotOptimizer {
    private const val TAG = "PhoneNet/ScreenOpt"

    const val VLM_MAX_WIDTH   = 1280
    const val VLM_JPEG_QUALITY = 80
    const val L2_MAX_WIDTH    = 1080  // L2 pixel diff — full width but still compress
    const val L2_JPEG_QUALITY = 90

    /**
     * Resize + compress for VLM (L3).
     * Output: base64-encoded JPEG, max 1280px wide.
     */
    fun optimizeForVlm(bitmap: Bitmap): String =
        encodeToBase64(resize(bitmap, VLM_MAX_WIDTH), VLM_JPEG_QUALITY)

    /**
     * Compress for L2 pixel diff.
     * Keeps full resolution but applies JPEG compression for bandwidth.
     */
    fun optimizeForL2(bitmap: Bitmap): String =
        encodeToBase64(resize(bitmap, L2_MAX_WIDTH), L2_JPEG_QUALITY)

    // ─── Internals ────────────────────────────────────────────────────────────

    private fun resize(bitmap: Bitmap, maxWidth: Int): Bitmap {
        if (bitmap.width <= maxWidth) return bitmap
        val scale  = maxWidth.toFloat() / bitmap.width
        val newW   = maxWidth
        val newH   = (bitmap.height * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, newW, newH, true).also {
            if (it !== bitmap) {
                Log.d(TAG, "Resized ${bitmap.width}×${bitmap.height} → ${newW}×${newH}")
            }
        }
    }

    private fun encodeToBase64(bitmap: Bitmap, quality: Int): String {
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
        val bytes = stream.toByteArray()
        Log.d(TAG, "Encoded: ${bytes.size / 1024}KB (quality=$quality)")
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
