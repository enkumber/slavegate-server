package com.phonenetwork.vision

import android.graphics.Bitmap
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * VisionClient — sends VISION_REQUEST to server, awaits VISION_RESULT.
 *
 * Flow:
 *   1. Caller: visionClient.requestVerification(bitmap, jobId, actionType)
 *   2. VisionClient optimizes screenshot + sends VISION_REQUEST via sendMessage callback
 *   3. Server routes to VLM provider, sends back VISION_RESULT (1-10s)
 *   4. WsClient receives VISION_RESULT → calls visionClient.handleResult(payload)
 *   5. CompletableDeferred<JSONObject> resolves → verifyAfterAction() returns
 *
 * Timeout: 15s (VLM can be slow; 15s >> p95 latency for cloud providers)
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §5.4 (L3)
 */
class VisionClient(
    /** Lambda to send a WS message — provided by WsClient at init time */
    private val sendMessage: (type: String, payload: JSONObject) -> Unit
) {
    companion object {
        private const val TAG         = "PhoneNet/VisionClient"
        private const val TIMEOUT_MS  = 15_000L
    }

    // jobId → pending deferred waiting for VISION_RESULT
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Request VLM verification for an action.
     * Optimizes screenshot, sends VISION_REQUEST, waits for VISION_RESULT.
     *
     * @param screenshot  Bitmap after action execution
     * @param jobId       Job ID (correlates request with result)
     * @param actionType  e.g. "tap_like", "tap_follow" — server selects prompt template
     * @param requestType "verify_action" (default) | "element_find" | "screen_understand"
     * @return            VISION_RESULT payload JSON, or null on timeout/error
     */
    suspend fun requestVerification(
        screenshot:  Bitmap,
        jobId:       String,
        actionType:  String,
        requestType: String = "verify_action"
    ): JSONObject? {
        val b64 = ScreenshotOptimizer.optimizeForVlm(screenshot)
        return sendAndAwait(jobId, requestType, actionType, b64)
    }

    /**
     * Request element location (L3 find fallback).
     * Used when AccessibilityService can't locate an element.
     */
    suspend fun requestElementFind(
        screenshot:  Bitmap,
        jobId:       String,
        actionType:  String
    ): JSONObject? {
        val b64 = ScreenshotOptimizer.optimizeForVlm(screenshot)
        return sendAndAwait(jobId, "element_find", actionType, b64)
    }

    /**
     * Called by WsClient when VISION_RESULT arrives.
     * Resolves the pending deferred for the matching jobId.
     */
    fun handleResult(payload: JSONObject) {
        val jobId = payload.optString("jobId", "")
        val deferred = pending.remove(jobId)
        if (deferred != null) {
            deferred.complete(payload)
            Log.d(TAG, "VISION_RESULT resolved for job=$jobId")
        } else {
            Log.w(TAG, "VISION_RESULT for unknown jobId=$jobId (timed out or duplicate)")
        }
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    private suspend fun sendAndAwait(
        jobId:        String,
        requestType:  String,
        actionType:   String,
        screenshotB64: String
    ): JSONObject? {
        val deferred = CompletableDeferred<JSONObject>()
        pending[jobId] = deferred

        val payload = JSONObject().apply {
            put("jobId",            jobId)
            put("requestType",      requestType)
            put("actionType",       actionType)
            put("screenshotBase64", screenshotB64)
        }

        return try {
            sendMessage("VISION_REQUEST", payload)
            Log.d(TAG, "VISION_REQUEST sent: job=$jobId type=$requestType action=$actionType")

            withTimeout(TIMEOUT_MS) {
                deferred.await()
            }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            Log.w(TAG, "VISION_RESULT timeout for job=$jobId (${TIMEOUT_MS}ms)")
            pending.remove(jobId)
            null
        } catch (e: Exception) {
            Log.e(TAG, "VisionClient error for job=$jobId: ${e.message}")
            pending.remove(jobId)
            null
        }
    }
}
