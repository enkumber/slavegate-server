package com.phonenetwork.capture

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * CaptureController — screenshot via root `su -c screencap`.
 *
 * Devices are rooted — MediaProjection (which requires a user-facing confirmation
 * dialog) has been replaced with a silent root screencap approach.
 *
 * Used by:
 * - JobExecutor: "screenshot" job type → JPEG base64
 * - VerificationCascade (L2): takeScreenshotBitmap() → Bitmap for pixel diff
 * - VisionClient (Phase 3): takeScreenshotForVlm() → resized Bitmap for VISION_REQUEST
 *
 * Flow:
 *   su -c screencap -p /data/local/tmp/pn_sc_<ts>.png
 *   → read PNG bytes → BitmapFactory.decode → compress JPEG / return Bitmap
 *   → su -c rm -f <tmpFile>  (cleanup, waitFor() — previne zombie processes la captură frecventă)
 */
class CaptureController {
    companion object {
        private const val TAG          = "PhoneNet/Capture"
        private const val JPEG_QUALITY = 80          // % — balance quality vs transfer size
        private const val TMP_DIR      = "/data/local/tmp"

        // Max dimensions for VLM screenshots (resize on device to reduce upload size + token cost)
        // Target: 540x1200 max → ~150-250KB vs 2-5MB full res
        private const val VLM_MAX_WIDTH   = 540
        private const val VLM_MAX_HEIGHT  = 1200
        private const val VLM_JPEG_QUALITY = 85
    }

    // ─── Public interface (called by JobExecutor + VerificationCascade) ───────

    /**
     * Capture screenshot as JPEG base64 JSON.
     * Returns: {"format","base64","width","height"} on success,
     *          {"format","base64":"","width":0,"height":0,"error":"…"} on failure.
     */
    suspend fun takeScreenshot(quality: Int = JPEG_QUALITY): JSONObject = withContext(Dispatchers.IO) {
        val tmpFile = "$TMP_DIR/pn_sc_${System.currentTimeMillis()}.png"
        var proc: Process? = null
        try {
            proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "screencap -p $tmpFile"))
            val exitCode = proc.waitFor()
            if (exitCode != 0) return@withContext errorJson("screencap failed (exit $exitCode)")

            val file = java.io.File(tmpFile)
            if (!file.exists()) return@withContext errorJson("screencap output not found")

            val pngBytes = file.readBytes()
            val bitmap = BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.size)
                ?: return@withContext errorJson("BitmapFactory decode failed")

            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            val w = bitmap.width
            val h = bitmap.height
            bitmap.recycle()

            JSONObject().apply {
                put("format", "jpeg")
                put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                put("width", w)
                put("height", h)
            }
        } finally {
            proc?.destroy()
            Runtime.getRuntime().exec(arrayOf("su", "-c", "rm -f $tmpFile")).also { it.waitFor() }
        }
    }

    /**
     * Capture screenshot as Bitmap.
     * Used by VerificationCascade L2 (pixel diff) and VisionClient (L3 VLM).
     * Returns null on any error.
     */
    suspend fun takeScreenshotBitmap(): Bitmap? = withContext(Dispatchers.IO) {
        val tmpFile = "$TMP_DIR/pn_sc_${System.currentTimeMillis()}.png"
        var proc: Process? = null
        try {
            proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "screencap -p $tmpFile"))
            val exitCode = proc.waitFor()
            if (exitCode != 0) {
                Log.w(TAG, "takeScreenshotBitmap: screencap failed (exit $exitCode)")
                return@withContext null
            }
            val file = java.io.File(tmpFile)
            if (!file.exists()) {
                Log.w(TAG, "takeScreenshotBitmap: output not found")
                return@withContext null
            }
            val pngBytes = file.readBytes()
            BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.size).also {
                if (it == null) Log.w(TAG, "takeScreenshotBitmap: BitmapFactory decode failed")
            }
        } finally {
            proc?.destroy()
            Runtime.getRuntime().exec(arrayOf("su", "-c", "rm -f $tmpFile")).also { it.waitFor() }
        }
    }

    /**
     * Capture screenshot resized to max VLM_MAX_WIDTH for VLM upload.
     * Reduces token cost and upload time significantly.
     */
    suspend fun takeScreenshotForVlm(): Bitmap? = withContext(Dispatchers.IO) {
        val full = takeScreenshotBitmap() ?: return@withContext null
        resizeForVlm(full)
    }

    /**
     * Screenshot resized pentru VLM — returnează JSON cu base64 + dimensiuni.
     * Target: 540x1200 max (păstrează aspect ratio).
     * Output: ~150-250KB vs 2-5MB full res.
     */
    suspend fun takeScreenshotForVlmJson(): JSONObject = withContext(Dispatchers.IO) {
        val full = takeScreenshotBitmap()
            ?: return@withContext JSONObject().apply {
                put("error", "screenshot_capture_failed")
            }

        val originalWidth = full.width
        val originalHeight = full.height

        // Resize păstrând aspect ratio
        val scale = minOf(
            VLM_MAX_WIDTH.toFloat() / full.width,
            VLM_MAX_HEIGHT.toFloat() / full.height
        )
        val newW = (full.width * scale).toInt()
        val newH = (full.height * scale).toInt()

        val resized = if (scale < 1.0f) {
            Bitmap.createScaledBitmap(full, newW, newH, true).also { full.recycle() }
        } else {
            full  // nu mări dacă e deja mai mic
        }

        // Compress JPEG
        val out = ByteArrayOutputStream()
        resized.compress(Bitmap.CompressFormat.JPEG, VLM_JPEG_QUALITY, out)
        val finalW = resized.width
        val finalH = resized.height
        resized.recycle()

        JSONObject().apply {
            put("image_base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
            put("width", finalW)
            put("height", finalH)
            put("original_width", originalWidth)
            put("original_height", originalHeight)
            put("format", "jpeg")
            put("quality", VLM_JPEG_QUALITY)
        }
    }

    /**
     * Record screen for durationMs — stub (deferred).
     */
    suspend fun recordScreen(durationMs: Long, @Suppress("UNUSED_PARAMETER") bitrateMbps: Int = 2): JSONObject {
        Log.w(TAG, "recordScreen: not yet implemented — stub")
        delay(minOf(durationMs, 5_000L))
        return JSONObject().apply {
            put("format", "mp4")
            put("durationMs", durationMs)
            put("base64", "")
            put("note", "screen_record not yet implemented")
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private fun errorJson(msg: String) = JSONObject().apply {
        put("format", "jpeg")
        put("base64", "")
        put("width", 0)
        put("height", 0)
        put("error", msg)
    }

    /**
     * Resize bitmap to fit within VLM_MAX_WIDTH × VLM_MAX_HEIGHT preserving aspect ratio.
     * Uses same logic as takeScreenshotForVlmJson() for consistency.
     */
    private fun resizeForVlm(bitmap: Bitmap): Bitmap {
        val scale = minOf(
            VLM_MAX_WIDTH.toFloat() / bitmap.width,
            VLM_MAX_HEIGHT.toFloat() / bitmap.height
        )
        if (scale >= 1.0f) return bitmap  // Nu mări dacă e deja mai mic
        
        val newW = (bitmap.width * scale).toInt()
        val newH = (bitmap.height * scale).toInt()
        val resized = Bitmap.createScaledBitmap(bitmap, newW, newH, true)
        bitmap.recycle()
        return resized
    }
}
