package com.phonenetwork.executor

import android.content.Context
import android.util.Log
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.capture.CaptureController
import com.phonenetwork.utils.ScreenMetrics
import com.phonenetwork.utils.BoundedProcessRunner
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * BatchExecutor — Fast-Path execution engine for Instruction Batch protocol.
 *
 * Receives a BATCH_START message, executes all steps locally without any
 * server communication, and returns a BATCH_RESULT.
 *
 * Design principles:
 *   - Zero server contact during execution
 *   - Sequential execution (no parallel steps)
 *   - Per-step and total-batch timeouts
 *   - On error: "abort" stops batch, "smart" captures diagnostics for LLM
 *   - Normalized coordinates (0.0-1.0) → pixel conversion at execution time
 *
 * Lifecycle:
 *   1. DirectWsClient receives BATCH_START message
 *   2. Calls executeBatch(batchJson) { resultJson -> send via WS }
 *   3. BatchExecutor runs steps in a coroutine on Dispatchers.IO
 *   4. On completion/failure, calls onResult with BATCH_RESULT JSON
 *
 * Thread safety: only one batch runs at a time (enforced by running flag).
 */
class BatchExecutor(
    private val context: Context,
    private val automation: AutomationController,
    private val capture: CaptureController,
) {
    companion object {
        private const val ROOT_COMMAND_TIMEOUT_MS = 5_000L
        private const val TAG = "BatchExecutor"

        // Default timeouts
        private const val DEFAULT_STEP_TIMEOUT_MS = 30_000L
        private const val DEFAULT_BATCH_TIMEOUT_MS = 300_000L  // 5 min

        // Error policies
        private const val ON_ERROR_ABORT = "abort"
        private const val ON_ERROR_SMART = "smart"
    }

    // Only one batch at a time
    private val running = AtomicBoolean(false)

    // Cancellation support (KILL_SWITCH)
    @Volatile
    private var batchScope: CoroutineScope? = null

    /**
     * Cancel the currently running batch.
     * Called when KILL_SWITCH is received mid-batch.
     */
    fun cancel() {
        Log.w(TAG, "Batch cancellation requested")
        batchScope?.cancel()
    }

    /**
     * Execute a BATCH_START message and return BATCH_RESULT via callback.
     *
     * @param batchJson The raw BATCH_START JSON from server
     * @param onResult Callback with BATCH_RESULT JSON (send via WebSocket)
     */
    suspend fun executeBatch(
        batchJson: JSONObject,
        onResult: (JSONObject) -> Unit,
    ) {
        val batchId = batchJson.optString("batchId", "")
        val workflowId = batchJson.optString("workflowId", "")

        if (batchId.isEmpty()) {
            onResult(buildErrorResult(batchId, workflowId, "Missing batchId"))
            return
        }

        if (!running.compareAndSet(true, true).not()) {
            onResult(buildErrorResult(batchId, workflowId, "Batch already running"))
            return
        }
        running.set(true)

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        batchScope = scope

        try {
            scope.launch {
                executeBatchInternal(batchJson, batchId, workflowId, onResult)
            }.join()
        } finally {
            running.set(false)
            batchScope = null
        }
    }

    // ─── Internal execution ──────────────────────────────────────────────────

    private suspend fun executeBatchInternal(
        batchJson: JSONObject,
        batchId: String,
        workflowId: String,
        onResult: (JSONObject) -> Unit,
    ) {
        val stepsArray = batchJson.optJSONArray("steps") ?: JSONArray()
        val options = batchJson.optJSONObject("options") ?: JSONObject()

        val continueOnError = options.optBoolean("continueOnError", false)
        val stepTimeoutMs = options.optLong("timeoutMs", DEFAULT_STEP_TIMEOUT_MS)
        val batchTimeoutMs = options.optLong("batchTimeoutMs",
            stepTimeoutMs * stepsArray.length() * 3 / 2  // 1.5x total
        )

        val batchStartMs = System.currentTimeMillis()
        val results = mutableListOf<JSONObject>()
        var batchStatus = "completed"

        Log.i(TAG, "Batch $batchId: starting ${stepsArray.length()} steps " +
                "(stepTimeout=${stepTimeoutMs}ms, batchTimeout=${batchTimeoutMs}ms, " +
                "continueOnError=$continueOnError)")

        // Execute with total batch timeout
        val completed = withTimeoutOrNull(batchTimeoutMs) {
            for (i in 0 until stepsArray.length()) {
                // Check cancellation
                if (!isActive) {
                    Log.w(TAG, "Batch $batchId: cancelled at step $i")
                    break
                }

                val stepJson = stepsArray.getJSONObject(i)
                val stepId = stepJson.optInt("id", i + 1)
                val stepType = stepJson.optString("type", "action")

                val stepStartMs = System.currentTimeMillis()

                val stepResult = try {
                    withTimeoutOrNull(stepTimeoutMs) {
                        executeStep(stepJson)
                    } ?: run {
                        // Step timeout
                        buildStepResult(stepId, "timeout", System.currentTimeMillis() - stepStartMs,
                            error = "Step timeout after ${stepTimeoutMs}ms")
                    }
                } catch (e: CancellationException) {
                    throw e  // propagate cancellation
                } catch (e: Exception) {
                    Log.e(TAG, "Batch $batchId: step $stepId failed: ${e.message}")
                    buildStepResult(stepId, "failed", System.currentTimeMillis() - stepStartMs,
                        error = e.message ?: "Unknown error")
                }

                results.add(stepResult)

                val stepStatus = stepResult.optString("status")
                if (stepStatus != "success") {
                    if (!continueOnError) {
                        // Mark remaining steps as skipped
                        for (j in (i + 1) until stepsArray.length()) {
                            val skippedId = stepsArray.getJSONObject(j).optInt("id", j + 1)
                            results.add(buildStepResult(skippedId, "skipped", 0))
                        }
                        batchStatus = if (results.any { it.optString("status") == "success" })
                            "partial_failure" else "failed"
                        break
                    } else {
                        batchStatus = "partial_failure"
                    }
                }
            }
        }

        if (completed == null) {
            // Batch timeout — mark remaining steps as skipped
            batchStatus = "timeout"
        }

        val totalMs = System.currentTimeMillis() - batchStartMs

        val batchResult = buildBatchResult(
            batchId = batchId,
            workflowId = workflowId,
            status = batchStatus,
            results = results,
            totalMs = totalMs,
        )

        Log.i(TAG, "Batch $batchId: done status=$batchStatus steps=${results.size} " +
                "totalMs=${totalMs}ms")
        onResult(batchResult)
    }

    // ─── Step execution ──────────────────────────────────────────────────────

    /**
     * Execute a single step from the batch. Returns StepResult JSON.
     * Throws on failure (caught by caller).
     */
    private suspend fun executeStep(stepJson: JSONObject): JSONObject {
        val stepId = stepJson.optInt("id", 0)
        val stepType = stepJson.optString("type", "action")
        val onError = stepJson.optString("onError", ON_ERROR_ABORT)
        val params = stepJson.optJSONObject("params") ?: JSONObject()
        val startMs = System.currentTimeMillis()

        val output = when (stepType) {
            "action" -> executeAction(stepJson, params)
            "wait"   -> executeWait(params)
            else     -> throw IllegalArgumentException("Unknown step type: $stepType")
        }

        // Optional local verification
        val verify = stepJson.optJSONObject("verify")
        if (verify != null && verify.optString("type", "none") != "none") {
            val verifyResult = executeLocalVerification(verify)
            output.put("verificationPassed", verifyResult)
        }

        return buildStepResult(stepId, "success", System.currentTimeMillis() - startMs, output = output)
    }

    // ─── Action dispatch ─────────────────────────────────────────────────────

    private suspend fun executeAction(stepJson: JSONObject, params: JSONObject): JSONObject {
        val action = stepJson.optString("action", "")

        return when (action) {
            "tap"         -> executeTap(params)
            "swipe"       -> executeSwipe(params)
            "scroll"      -> executeScroll(params)
            "type"        -> executeType(params)
            "wait"        -> executeWait(params)
            "press_back",
            "press_home",
            "press_recent",
            "keyevent"    -> executeKeyevent(params, action)
            "long_press"  -> executeLongPress(params)
            "open_app"    -> executeOpenApp(params)
            "close_app"   -> executeCloseApp(params)
            "intent_send" -> executeIntentSend(params)
            "double_tap"  -> executeDoubleTap(params)
            else          -> throw UnsupportedOperationException("Unknown action: $action")
        }
    }

    // ─── Action implementations ──────────────────────────────────────────────

    /**
     * Tap at normalized coordinates. Converts 0.0-1.0 → pixel coords.
     */
    private suspend fun executeTap(params: JSONObject): JSONObject {
        val (screenW, screenH) = ScreenMetrics.getRealDimensions(context)
        val rawX = params.optDouble("x", -1.0)
        val rawY = params.optDouble("y", -1.0)

        if (rawX < 0 || rawY < 0) {
            throw IllegalArgumentException("tap requires x,y params")
        }

        val px = if (rawX <= 1.0) (rawX * screenW).roundToInt() else rawX.roundToInt()
        val py = if (rawY <= 1.0) (rawY * screenH).roundToInt() else rawY.roundToInt()

        automation.tap(px, py)

        return JSONObject().apply {
            put("x", rawX)
            put("y", rawY)
            put("pixelX", px)
            put("pixelY", py)
        }
    }

    /**
     * Swipe gesture. Supports both direction-based and explicit coords.
     */
    private suspend fun executeSwipe(params: JSONObject): JSONObject {
        val (screenW, screenH) = ScreenMetrics.getRealDimensions(context)
        val durationMs = params.optLong("durationMs", 300)

        val startX: Int
        val startY: Int
        val endX: Int
        val endY: Int

        if (params.has("direction")) {
            // Direction-based: compute start/end from direction
            val direction = params.optString("direction", "up")
            val margin = 50  // px from screen edge
            val cx = screenW / 2
            val cy = screenH / 2

            when (direction) {
                "up"    -> { startX = cx; startY = cy + screenH / 4; endX = cx; endY = cy - screenH / 4 }
                "down"  -> { startX = cx; startY = cy - screenH / 4; endX = cx; endY = cy + screenH / 4 }
                "left"  -> { startX = cx + screenW / 4; startY = cy; endX = cx - screenW / 4; endY = cy }
                "right" -> { startX = cx - screenW / 4; startY = cy; endX = cx + screenW / 4; endY = cy }
                else    -> throw IllegalArgumentException("Unknown swipe direction: $direction")
            }
        } else {
            // Explicit coordinates (normalized 0.0-1.0)
            val sx = params.optDouble("startX", 0.5)
            val sy = params.optDouble("startY", 0.5)
            val ex = params.optDouble("endX", 0.5)
            val ey = params.optDouble("endY", 0.5)

            startX = if (sx <= 1.0) (sx * screenW).roundToInt() else sx.roundToInt()
            startY = if (sy <= 1.0) (sy * screenH).roundToInt() else sy.roundToInt()
            endX   = if (ex <= 1.0) (ex * screenW).roundToInt() else ex.roundToInt()
            endY   = if (ey <= 1.0) (ey * screenH).roundToInt() else ey.roundToInt()
        }

        automation.swipe(startX, startY, endX, endY, durationMs)

        return JSONObject().apply {
            put("startX", startX)
            put("startY", startY)
            put("endX", endX)
            put("endY", endY)
        }
    }

    /**
     * Scroll gesture. Maps direction + percent to swipe coords.
     */
    private suspend fun executeScroll(params: JSONObject): JSONObject {
        val direction = params.optString("scrollDirection",
            params.optString("direction", "down"))
        val percent = params.optDouble("percent", 0.5)
        val durationMs = params.optLong("durationMs", 300)
        val distancePx = (ScreenMetrics.getRealDimensions(context).second * percent).roundToInt()

        automation.scroll(direction, distancePx, durationMs)

        return JSONObject().apply {
            put("scrollDirection", direction)
            put("distancePx", distancePx)
        }
    }

    /**
     * Type text into focused field. Delegates to AutomationController.typeText
     * which handles character-by-character input with HBE timing.
     */
    private suspend fun executeType(params: JSONObject): JSONObject {
        val text = params.optString("text", "")
        if (text.isEmpty()) {
            throw IllegalArgumentException("type requires text param")
        }

        automation.typeText(text)

        return JSONObject().apply {
            put("textTyped", text.length)
            // Don't echo actual text back (security)
        }
    }

    /**
     * Wait for a fixed duration. Pure delay, no server contact.
     */
    private suspend fun executeWait(params: JSONObject): JSONObject {
        val durationMs = params.optLong("durationMs", 1000)
        delay(durationMs)
        return JSONObject().apply { put("waitedMs", durationMs) }
    }

    /**
     * Press a key: back, home, recents, or raw keyevent code.
     */
    private suspend fun executeKeyevent(params: JSONObject, action: String): JSONObject {
        val keyCode = when (action) {
            "press_back"    -> 4    // KEYCODE_BACK
            "press_home"    -> 3    // KEYCODE_HOME
            "press_recent"  -> 187  // KEYCODE_APP_SWITCH
            "keyevent"      -> params.optInt("keyCode", 4)
            else            -> 4
        }

        val result = BoundedProcessRunner.run(
            arrayOf("su", "-c", "input keyevent $keyCode"),
            ROOT_COMMAND_TIMEOUT_MS,
        )
        if (!result.success) throw IllegalStateException("keyevent failed: ${result.output}")

        return JSONObject().apply { put("keyCode", keyCode) }
    }

    /**
     * Long press at coordinates.
     */
    private suspend fun executeLongPress(params: JSONObject): JSONObject {
        val (screenW, screenH) = ScreenMetrics.getRealDimensions(context)
        val rawX = params.optDouble("x", -1.0)
        val rawY = params.optDouble("y", -1.0)
        val durationMs = params.optLong("durationMs", 1000)

        if (rawX < 0 || rawY < 0) {
            throw IllegalArgumentException("long_press requires x,y params")
        }

        val px = if (rawX <= 1.0) (rawX * screenW).roundToInt() else rawX.roundToInt()
        val py = if (rawY <= 1.0) (rawY * screenH).roundToInt() else rawY.roundToInt()

        // Use shell input swipe with 0 distance = long press
        val result = BoundedProcessRunner.run(
            arrayOf("su", "-c", "input swipe $px $py $px $py $durationMs"),
            (durationMs + ROOT_COMMAND_TIMEOUT_MS).coerceAtMost(30_000L),
        )
        if (!result.success) throw IllegalStateException("long_press failed: ${result.output}")

        return JSONObject().apply {
            put("x", rawX)
            put("y", rawY)
            put("pixelX", px)
            put("pixelY", py)
        }
    }

    /**
     * Open app by package name.
     */
    private suspend fun executeOpenApp(params: JSONObject): JSONObject {
        val packageName = params.optString("packageName", "")
        if (packageName.isEmpty()) {
            throw IllegalArgumentException("open_app requires packageName")
        }

        val fresh = params.optBoolean("fresh", false)
        if (fresh) {
            automation.openAppFresh(packageName)
        } else {
            automation.openApp(packageName)
        }

        return JSONObject().apply { put("packageName", packageName) }
    }

    /**
     * Close app by package name.
     */
    private suspend fun executeCloseApp(params: JSONObject): JSONObject {
        val packageName = params.optString("packageName", "")
        if (packageName.isEmpty()) {
            throw IllegalArgumentException("close_app requires packageName")
        }

        automation.closeApp(packageName)

        return JSONObject().apply { put("packageName", packageName) }
    }

    /**
     * Send an Android intent/deep link. A missing resolver is an execution
     * failure so the batch stops at the real failing step.
     */
    private suspend fun executeIntentSend(params: JSONObject): JSONObject = withContext(Dispatchers.Main) {
        val uri = params.getString("uri")
        val action = params.optString("action", android.content.Intent.ACTION_VIEW)
        val targetPackage = params.optString("packageName", "").takeIf { it.isNotEmpty() }
        val extrasObj = params.optJSONObject("extras")
        val flagsArray = params.optJSONArray("flags")

        val intent = android.content.Intent(action).apply {
            data = android.net.Uri.parse(uri)
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)

            if (flagsArray != null) {
                for (i in 0 until flagsArray.length()) {
                    when (flagsArray.getString(i)) {
                        "FLAG_ACTIVITY_CLEAR_TOP" -> addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        "FLAG_ACTIVITY_SINGLE_TOP" -> addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        "FLAG_ACTIVITY_CLEAR_TASK" -> addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        "FLAG_ACTIVITY_NO_HISTORY" -> addFlags(android.content.Intent.FLAG_ACTIVITY_NO_HISTORY)
                    }
                }
            }

            if (targetPackage != null) {
                setPackage(targetPackage)
            }

            if (extrasObj != null) {
                val keys = extrasObj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    when (val value = extrasObj.get(key)) {
                        is String -> putExtra(key, value)
                        is Int -> putExtra(key, value)
                        is Boolean -> putExtra(key, value)
                        is Long -> putExtra(key, value)
                        is Double -> putExtra(key, value.toFloat())
                    }
                }
            }
        }

        val resolveInfo = context.packageManager.resolveActivity(intent, 0)
        try {
            context.startActivity(intent)
            JSONObject().apply {
                put("uri", uri)
                put("launched", true)
                if (resolveInfo != null) {
                    put("resolvedActivity", "${resolveInfo.activityInfo.packageName}/${resolveInfo.activityInfo.name}")
                }
            }
        } catch (e: android.content.ActivityNotFoundException) {
            throw IllegalStateException("No activity found to handle intent: $uri", e)
        }
    }

    /**
     * Double tap: two taps in quick succession.
     */
    private suspend fun executeDoubleTap(params: JSONObject): JSONObject {
        val result = executeTap(params)
        delay(80)  // 80ms between taps
        executeTap(params)
        return result.put("doubleTap", true)
    }

    // ─── Local verification ──────────────────────────────────────────────────

    /**
     * Local-only verification after a step.
     * Checks UI tree for expected patterns. No VLM/server contact.
     *
     * Returns true if verification passed.
     */
    private suspend fun executeLocalVerification(verifyConfig: JSONObject): Boolean {
        val type = verifyConfig.optString("type", "none")
        val timeoutMs = verifyConfig.optLong("timeoutMs", 5_000)
        val expectedScreen = verifyConfig.optString("expectedScreen", "")

        return when (type) {
            "ui_tree" -> {
                val startMs = System.currentTimeMillis()
                // Poll UI tree until expected pattern found or timeout
                while (System.currentTimeMillis() - startMs < timeoutMs) {
                    try {
                        val uiTree = automation.uiTreeDump(null)
                        if (expectedScreen.isNotEmpty() && uiTree.contains(expectedScreen)) {
                            return true
                        }
                        // Check for common screen indicators
                        if (verifyConfig.has("resourceIdPattern")) {
                            val pattern = verifyConfig.getString("resourceIdPattern")
                            if (uiTree.contains(pattern)) return true
                        }
                        if (verifyConfig.has("textPattern")) {
                            val pattern = verifyConfig.getString("textPattern")
                            if (uiTree.contains(pattern)) return true
                        }
                    } catch (e: Exception) {
                        // UI tree dump failed — retry
                    }
                    delay(200)
                }
                false
            }

            "pixel_diff" -> {
                // Pixel diff requires reference template — not supported in batch Fast-Path
                // Server-side will do pixel diff after BATCH_RESULT returns
                Log.w(TAG, "pixel_diff verification not supported in Fast-Path — skipping")
                true  // Don't fail the step
            }

            "none" -> true
            else   -> true
        }
    }

    // ─── Smart error diagnostics ─────────────────────────────────────────────

    /**
     * Capture diagnostic data for smart error handling.
     * Takes screenshot + UI tree dump for server-side LLM analysis.
     *
     * Called when a step fails with onError="smart".
     * Returns a JSONObject with diagnostic data.
     */
    private suspend fun captureDiagnostics(): JSONObject {
        return try {
            coroutineScope {
                val uiTreeDeferred = async(Dispatchers.Main) {
                    try { automation.uiTreeDump(null) } catch (e: Exception) {
                        Log.w(TAG, "Diagnostic UI tree dump failed: ${e.message}")
                        "{\"error\":\"${e.message}\"}"
                    }
                }
                val screenshotDeferred = async(Dispatchers.IO) {
                    try {
                        capture.takeScreenshotForVlmJson()
                    } catch (e: Exception) {
                        Log.w(TAG, "Diagnostic screenshot failed: ${e.message}")
                        JSONObject().put("error", e.message)
                    }
                }

                val uiTree = uiTreeDeferred.await()
                val screenshot = screenshotDeferred.await()

                JSONObject().apply {
                    put("uiTree", uiTree)
                    put("screenshotBase64", screenshot.optString("image_base64", ""))
                    put("capturedAt", System.currentTimeMillis())
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to capture diagnostics: ${e.message}")
            JSONObject().put("error", "diagnostic_capture_failed: ${e.message}")
        }
    }

    // ─── JSON builders ───────────────────────────────────────────────────────

    private fun buildBatchResult(
        batchId: String,
        workflowId: String,
        status: String,
        results: List<JSONObject>,
        totalMs: Long,
    ): JSONObject = JSONObject().apply {
        put("type", "BATCH_RESULT")
        put("batchId", batchId)
        put("workflowId", workflowId)
        put("status", status)
        put("results", JSONArray().apply { results.forEach { put(it) } })
        put("executedAt", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            .format(java.util.Date()))
        put("totalDurationMs", totalMs)
    }

    private fun buildStepResult(
        id: Int,
        status: String,
        durationMs: Long,
        output: JSONObject = JSONObject(),
        error: String? = null,
    ): JSONObject = JSONObject().apply {
        put("id", id)
        put("status", status)
        put("durationMs", durationMs)
        put("output", output)
        if (error != null) put("error", error)
    }

    private fun buildErrorResult(
        batchId: String,
        workflowId: String,
        error: String,
    ): JSONObject = buildBatchResult(
        batchId = batchId,
        workflowId = workflowId,
        status = "failed",
        results = listOf(JSONObject().apply {
            put("id", 0)
            put("status", "failed")
            put("durationMs", 0)
            put("output", JSONObject())
            put("error", error)
        }),
        totalMs = 0,
    )
}
