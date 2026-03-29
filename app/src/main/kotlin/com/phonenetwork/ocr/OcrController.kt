package com.phonenetwork.ocr

import android.graphics.Bitmap
import android.graphics.Rect
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Result from OCR text search.
 *
 * @param found        Whether the searched text was located on screen.
 * @param x            Normalized X coordinate (0.0–1.0) of matched text center, in screen space.
 * @param y            Normalized Y coordinate (0.0–1.0) of matched text center, in screen space.
 * @param pixelX       Absolute pixel X of matched text center, in screen space.
 * @param pixelY       Absolute pixel Y of matched text center, in screen space.
 * @param matchedText  The actual text matched (useful for partial matches).
 * @param bounds       Pixel bounding box of matched text block, in screen space.
 * @param confidence   ML Kit confidence score (0.0–1.0). May be 0 if ML Kit doesn't expose it.
 * @param totalBlocks  Total number of text blocks detected on screen (useful for debugging).
 */
data class OcrFindResult(
    val found: Boolean,
    val x: Float = 0f,
    val y: Float = 0f,
    val pixelX: Int = 0,
    val pixelY: Int = 0,
    val matchedText: String = "",
    val bounds: Rect? = null,
    val confidence: Float = 0f,
    val totalBlocks: Int = 0
)

/**
 * OcrController — ML Kit Text Recognition wrapper for cascade-tap Level 3.
 *
 * Usage:
 * ```kotlin
 * val result = ocr.findText(
 *     bitmap = capture.takeScreenshotBitmap(),
 *     searchText = "Follow",
 *     partialMatch = false,
 *     screenWidth = metrics.widthPixels,
 *     screenHeight = metrics.heightPixels
 * )
 * if (result.found) {
 *     automation.tap(result.pixelX, result.pixelY)
 * }
 * ```
 *
 * Thread safety: [findText] is a suspend function — safe to call from any coroutine dispatcher.
 * The underlying ML Kit callback runs on a background thread internally.
 *
 * Lifecycle: share a single instance per JobExecutor (lazy init via `by lazy {}`).
 */
class OcrController {

    /**
     * ML Kit text recognizer — uses bundled Latin model (offline, no internet required).
     * Latin covers English, Romanian, and most Western European UI text.
     */
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    /**
     * Search for [searchText] within a screenshot [bitmap].
     *
     * Coordinates in the returned [OcrFindResult] are normalized to the PHYSICAL screen
     * dimensions ([screenWidth] × [screenHeight]), not the bitmap dimensions. This handles
     * cases where [capture.takeScreenshotBitmap()] returns a downscaled bitmap.
     *
     * Search order: iterates text blocks top-to-bottom, lines top-to-bottom within each block.
     * Returns the FIRST match found (topmost on screen).
     *
     * @param bitmap        Screenshot to scan (any resolution — coordinates are auto-scaled).
     * @param searchText    Text to search for.
     * @param partialMatch  If true, uses [String.contains]; if false, uses [String.equals].
     *                      Both comparisons are case-insensitive.
     * @param screenWidth   Actual physical screen width in pixels (for coordinate normalization).
     * @param screenHeight  Actual physical screen height in pixels (for coordinate normalization).
     */
    suspend fun findText(
        bitmap: Bitmap,
        searchText: String,
        partialMatch: Boolean = false,
        screenWidth: Int,
        screenHeight: Int
    ): OcrFindResult = suspendCancellableCoroutine { cont ->

        val image = InputImage.fromBitmap(bitmap, 0)

        recognizer.process(image)
            .addOnSuccessListener { visionText ->
                val totalBlocks = visionText.textBlocks.size

                // Scale factors: bitmap space → screen space
                // Needed when screenshot is captured at lower resolution than display.
                val scaleX = screenWidth.toFloat() / bitmap.width.coerceAtLeast(1)
                val scaleY = screenHeight.toFloat() / bitmap.height.coerceAtLeast(1)

                // Iterate blocks and lines top-to-bottom; return first match
                for (block in visionText.textBlocks) {
                    for (line in block.lines) {
                        val lineText = line.text.trim()
                        val matches = if (partialMatch) {
                            lineText.contains(searchText, ignoreCase = true)
                        } else {
                            lineText.equals(searchText, ignoreCase = true)
                        }

                        if (matches) {
                            val bb = line.boundingBox ?: continue

                            // Center of bounding box in bitmap space
                            val bitmapCenterX = (bb.left + bb.right) / 2f
                            val bitmapCenterY = (bb.top + bb.bottom) / 2f

                            // Map to screen space
                            val screenCenterX = (bitmapCenterX * scaleX).toInt()
                            val screenCenterY = (bitmapCenterY * scaleY).toInt()

                            // Normalize to 0.0–1.0 range
                            val normX = screenCenterX.toFloat() / screenWidth.coerceAtLeast(1)
                            val normY = screenCenterY.toFloat() / screenHeight.coerceAtLeast(1)

                            // Scale bounding box to screen space
                            val screenBounds = Rect(
                                (bb.left   * scaleX).toInt(),
                                (bb.top    * scaleY).toInt(),
                                (bb.right  * scaleX).toInt(),
                                (bb.bottom * scaleY).toInt()
                            )

                            // ML Kit exposes confidence at element level (may be null)
                            val confidence = line.elements.firstOrNull()?.confidence ?: 0f

                            cont.resume(
                                OcrFindResult(
                                    found       = true,
                                    x           = normX,
                                    y           = normY,
                                    pixelX      = screenCenterX,
                                    pixelY      = screenCenterY,
                                    matchedText = lineText,
                                    bounds      = screenBounds,
                                    confidence  = confidence,
                                    totalBlocks = totalBlocks
                                )
                            )
                            return@addOnSuccessListener
                        }
                    }
                }

                // No match found
                cont.resume(OcrFindResult(found = false, totalBlocks = totalBlocks))
            }
            .addOnFailureListener { e ->
                if (cont.isActive) cont.resumeWithException(e)
            }
    }

    /**
     * Full-screen OCR — returns all detected text blocks with coordinates.
     *
     * Used by Screen Detection Cascade L2: server's `ocr.detector.ts` receives
     * this payload and matches text markers against screen detection rules.
     *
     * Result format matches [OcrFullResult] in `shared/protocol/messages.ts`:
     * ```json
     * {
     *   "blocks": [
     *     {
     *       "text": "Action Blocked",
     *       "bounds": { "left": 120, "top": 300, "right": 600, "bottom": 360 },
     *       "confidence": 0.97,
     *       "lines": [
     *         { "text": "Action Blocked", "bounds": {...}, "confidence": 0.97 }
     *       ]
     *     }
     *   ],
     *   "fullText": "Action Blocked\nThis action was blocked...",
     *   "totalBlocks": 3
     * }
     * ```
     *
     * @param bitmap        Screenshot bitmap (any resolution — coordinates auto-scaled to screen).
     * @param screenWidth   Physical screen width in pixels (for coordinate normalization).
     * @param screenHeight  Physical screen height in pixels (for coordinate normalization).
     */
    suspend fun runFullOcr(
        bitmap: Bitmap,
        screenWidth: Int,
        screenHeight: Int
    ): JSONObject = suspendCancellableCoroutine { cont ->

        val image = InputImage.fromBitmap(bitmap, 0)

        recognizer.process(image)
            .addOnSuccessListener { visionText ->
                // Scale factors: bitmap space → screen space
                val scaleX = screenWidth.toFloat() / bitmap.width.coerceAtLeast(1)
                val scaleY = screenHeight.toFloat() / bitmap.height.coerceAtLeast(1)

                val blocksArray = JSONArray()
                val fullTextBuilder = StringBuilder()

                for (block in visionText.textBlocks) {
                    val blockObj = JSONObject()

                    // Block-level text (all lines joined with newline)
                    val blockText = block.text
                    blockObj.put("text", blockText)

                    // Block bounding box in screen space
                    val blockBb = block.boundingBox
                    if (blockBb != null) {
                        blockObj.put("bounds", scaledBoundsJson(blockBb, scaleX, scaleY))
                    }

                    // Average confidence across all lines in this block
                    val lineConfidences = block.lines.mapNotNull { line ->
                        line.elements.firstOrNull()?.confidence
                    }
                    val avgConfidence = if (lineConfidences.isNotEmpty()) {
                        lineConfidences.average().toFloat()
                    } else 0f
                    blockObj.put("confidence", avgConfidence.toDouble())

                    // Individual lines within this block
                    val linesArray = JSONArray()
                    for (line in block.lines) {
                        val lineObj = JSONObject()
                        lineObj.put("text", line.text)

                        val lineBb = line.boundingBox
                        if (lineBb != null) {
                            lineObj.put("bounds", scaledBoundsJson(lineBb, scaleX, scaleY))
                        }

                        val lineConfidence = line.elements.firstOrNull()?.confidence ?: 0f
                        lineObj.put("confidence", lineConfidence.toDouble())

                        linesArray.put(lineObj)
                    }
                    blockObj.put("lines", linesArray)

                    blocksArray.put(blockObj)

                    // Accumulate full text
                    if (fullTextBuilder.isNotEmpty()) fullTextBuilder.append("\n")
                    fullTextBuilder.append(blockText)
                }

                val result = JSONObject().apply {
                    put("blocks",      blocksArray)
                    put("fullText",    fullTextBuilder.toString())
                    put("totalBlocks", visionText.textBlocks.size)
                }

                if (cont.isActive) cont.resume(result)
            }
            .addOnFailureListener { e ->
                if (cont.isActive) cont.resumeWithException(e)
            }
    }

    /**
     * Scale a bounding [Rect] from bitmap space to screen space and serialize to JSON.
     */
    private fun scaledBoundsJson(bb: Rect, scaleX: Float, scaleY: Float): JSONObject =
        JSONObject().apply {
            put("left",   (bb.left   * scaleX).toInt())
            put("top",    (bb.top    * scaleY).toInt())
            put("right",  (bb.right  * scaleX).toInt())
            put("bottom", (bb.bottom * scaleY).toInt())
        }

    /**
     * Serialize [OcrFindResult] to [JSONObject] for transmission to server.
     *
     * Schema matches [OcrFindTapResult] in `shared/protocol/messages.ts`:
     * ```json
     * {
     *   "found": true,
     *   "x": 0.5,
     *   "y": 0.3,
     *   "pixelX": 540,
     *   "pixelY": 648,
     *   "matchedText": "Follow",
     *   "confidence": 0.98,
     *   "bounds": { "left": 490, "top": 630, "right": 590, "bottom": 666 },
     *   "totalBlocks": 12
     * }
     * ```
     */
    fun toJson(result: OcrFindResult): JSONObject = JSONObject().apply {
        put("found", result.found)
        if (result.found) {
            put("x",           result.x.toDouble())
            put("y",           result.y.toDouble())
            put("pixelX",      result.pixelX)
            put("pixelY",      result.pixelY)
            put("matchedText", result.matchedText)
            put("confidence",  result.confidence.toDouble())
            result.bounds?.let { b ->
                put("bounds", JSONObject().apply {
                    put("left",   b.left)
                    put("top",    b.top)
                    put("right",  b.right)
                    put("bottom", b.bottom)
                })
            }
        }
        put("totalBlocks", result.totalBlocks)
    }
}
