package com.phonenetwork.vision

import org.json.JSONArray
import org.json.JSONObject

/**
 * ScreenElementMapper — converts server VISION_RESULT elements to ScreenElement.
 *
 * Server returns elements with {type, text, bounds: {x,y,width,height}, confidence}.
 * ScreenElement is the normalized format used by JobExecutor for click targets —
 * same shape as what AgentAccessibilityService provides, so JobExecutor needs no
 * special path for VLM-sourced elements.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §5.4
 */
object ScreenElementMapper {

    data class ScreenElement(
        val type:        String,
        val text:        String?,
        val x:           Int,       // top-left X
        val y:           Int,       // top-left Y
        val width:       Int,
        val height:      Int,
        val centerX:     Int,       // convenience — tap target
        val centerY:     Int,
        val confidence:  Float,
        val source:      Source = Source.VLM
    ) {
        enum class Source { A11Y, VLM }
    }

    /**
     * Map VISION_RESULT payload elements array to ScreenElement list.
     *
     * @param payload  The full VISION_RESULT JSON payload from server
     * @return         List of mapped elements, empty if none / parse error
     */
    fun mapElements(payload: JSONObject): List<ScreenElement> {
        val elements = payload.optJSONArray("elements") ?: return emptyList()
        val result   = mutableListOf<ScreenElement>()
        for (i in 0 until elements.length()) {
            val el = elements.optJSONObject(i) ?: continue
            mapElement(el)?.let { result.add(it) }
        }
        return result
    }

    /**
     * Find the best match for a given element type/text hint.
     * Used by JobExecutor to locate a specific target from VLM output.
     */
    fun findBestMatch(
        elements: List<ScreenElement>,
        type:     String? = null,
        textHint: String? = null
    ): ScreenElement? {
        return elements
            .filter { el ->
                val typeMatch = type == null || el.type.equals(type, ignoreCase = true)
                val textMatch = textHint == null ||
                    (el.text != null && el.text.contains(textHint, ignoreCase = true))
                typeMatch && textMatch
            }
            .maxByOrNull { it.confidence }
    }

    // ─── Private ──────────────────────────────────────────────────────────────

    private fun mapElement(el: JSONObject): ScreenElement? {
        return try {
            val bounds = el.optJSONObject("bounds") ?: return null
            val x      = bounds.optInt("x", 0).coerceAtLeast(0)
            val y      = bounds.optInt("y", 0).coerceAtLeast(0)
            val w      = bounds.optInt("width", 1).coerceAtLeast(1)
            val h      = bounds.optInt("height", 1).coerceAtLeast(1)
            ScreenElement(
                type       = el.optString("type", "unknown"),
                text       = el.optString("text").takeIf { it.isNotEmpty() },
                x          = x,
                y          = y,
                width      = w,
                height     = h,
                centerX    = x + w / 2,
                centerY    = y + h / 2,
                confidence = el.optDouble("confidence", 0.8).toFloat().coerceIn(0f, 1f)
            )
        } catch (e: Exception) {
            null
        }
    }
}
