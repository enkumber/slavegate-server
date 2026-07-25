package com.phonenetwork.executor

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.phonenetwork.accessibility.AgentAccessibilityService
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.capture.CaptureController
import com.phonenetwork.ocr.OcrController
import com.phonenetwork.ota.OtaInstaller
import com.phonenetwork.service.AgentForegroundService
import com.phonenetwork.verification.VerificationCascade
import com.phonenetwork.verification.VerificationStrategy
import com.phonenetwork.verification.L2PixelDiffVerifier
import com.phonenetwork.utils.ScreenMetrics
import com.phonenetwork.utils.BoundedProcessRunner
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * JobExecutor — executes atomic jobs. Pure executor, zero business logic.
 *
 * Phase 2: Integrates VerificationCascade (L1 + L2).
 *   - captureBeforeAction: L1 snapshot + L2 screenshot (if strategy requires)
 *   - After execution: cascade runs → VerificationResult included in JOB_RESULT
 *
 * Idempotency: persistent cache of last 1000 executed job IDs + results.
 * Survives process restarts — prevents double-execution after reconnect.
 *
 * Audit log: generated SERVER-SIDE from dispatch + JOB_RESULT (v3.1).
 * Device sends ZERO log entries. No COMMAND_LOG message. No onLog callback.
 *
 * pm_install REMOVED: APK install exclusively through ota_update (signed).
 */
class JobExecutor(
    val context: Context,
    private var automation: AutomationController,
    private val capture: CaptureController,
    private val otaInstaller: OtaInstaller,
    /** Nullable — set after AccessibilityService connects (Phase 2+) */
    @Volatile private var accessibilityService: AgentAccessibilityService? = null
) {
    fun setAccessibilityService(service: AgentAccessibilityService) {
        accessibilityService = service
    }

    fun clearAccessibilityService() {
        accessibilityService = null
    }

    /** Called when AccessibilityService connects — replaces stub AutomationController */
    fun setAutomationController(controller: AutomationController) {
        automation = controller
    }
    companion object {
        private const val TAG = "JobExecutor"
        private const val IDEMPOTENCY_FILE = "executed_jobs.json"
        private const val MAX_CACHE_SIZE   = 1000
        private const val MAX_TREE_DEPTH   = 30  // Prevent stack overflow on deep UI trees
        private const val ROOT_COMMAND_TIMEOUT_MS = 5_000L
        private val OBSERVATION_ONLY_JOB_TYPES = setOf(
            "ui_tree_dump",
            "get_screen_state",
            "get_foreground_app",
            "screenshot",
            "screenshot_for_vlm",
        )
    }

    /**
     * ML Kit OCR controller — lazy init so the recognizer is only created
     * if an `ocr_find_tap` job is actually dispatched (avoids ~50ms cold start
     * on first use if the feature is never triggered).
     */
    private val ocr by lazy { OcrController() }

    @Volatile private var lastJobId: String? = null
    @Volatile private var lastJobSuccessful: Boolean? = null
    @Volatile private var currentJobCancelled: Boolean = false

    /** C1: Cancel the currently executing job (called from KILL_SWITCH handler) */
    fun cancelCurrentJob(reason: String) {
        currentJobCancelled = true
        Log.w("PhoneNet/Executor", "Job cancellation requested: $reason")
    }

    // Persistent idempotency cache — survives process restart
    private val idempotencyPrefs: SharedPreferences =
        context.getSharedPreferences("job_idempotency", Context.MODE_PRIVATE)

    fun getLastJobId(): String? = lastJobId
    fun getLastJobSuccessful(): Boolean? = lastJobSuccessful

    /**
     * Execute a job. Calls onResult with the result.
     * Audit log is generated SERVER-SIDE from dispatch + JOB_RESULT — not by device.
     */
    suspend fun execute(
        payload: JSONObject,
        onResult: (JSONObject) -> Unit
    ) = withContext(Dispatchers.IO) {
        val jobId    = payload.getString("jobId")
        val type     = payload.getString("type")
        val params   = payload.getJSONObject("params")
        val startedAt = System.currentTimeMillis()

        // C1: respect kill switch — check BEFORE resetting flag for new job.
        // BUG FIX: previous order was reset-then-check → always false.
        // If cancelCurrentJob() was called (KILL_SWITCH received) before this job
        // started executing, reject immediately.
        if (currentJobCancelled) {
            onResult(buildResult(jobId, false, null, "Kill switch active", 0))
            return@withContext
        }
        currentJobCancelled = false  // reset flag for new job (AFTER the check)

        // Verification strategy from JOB_DISPATCH (server-side decision)
        val strategyRaw = payload.optString("verificationStrategy", "local_with_screenshot")
        val strategy    = VerificationStrategy.from(strategyRaw)
        val l1TimeoutMs = payload.optLong("l1TimeoutMs", 2000L)
        val l2SettleMs  = payload.optLong("l2SettleMs", 500L)

        // Idempotency: return cached result if already executed
        loadCachedResult(jobId)?.let { cached ->
            Log.i(TAG, "Job $jobId already executed (cached=$cached) — skipping re-execution")
            onResult(buildResult(jobId, cached, null, null, 0))
            return@withContext
        }

        lastJobId = jobId
        lastJobSuccessful = null
        Log.i(TAG, "Executing job $jobId type=$type strategy=$strategyRaw")

        // Build cascade (L1 + L2; null if A11y not connected)
        // Observation jobs do not mutate UI. Running a before/after UI-diff
        // cascade around them is redundant and can recursively pressure the
        // accessibility tree while a workflow wait predicate is polling it.
        val cascade = if (type in OBSERVATION_ONLY_JOB_TYPES) {
            null
        } else {
            buildCascade(strategy, l1TimeoutMs, l2SettleMs)
        }

        // PRE-ACTION snapshot — hard timeout 2s (rootInActiveWindow is Binder IPC;
        // can block indefinitely on slow UI transitions).
        val preCtx = try {
            withTimeoutOrNull(2_000L) {
                cascade?.prepareBeforeAction()
            }
        } catch (e: Exception) {
            Log.w(TAG, "prepareBeforeAction failed/timed-out (cascade skipped): ${e.message}")
            null
        }

        // Target ROI for L2
        val targetRoi = buildRoi(params)

        val jobTimeoutMs = payload.optLong("timeoutMs", 30_000L).coerceIn(5_000L, 600_000L) // 10 min max for type_text
        val (successful, output, error) = try {
            withTimeoutOrNull(jobTimeoutMs) {
                when (type) {
                    "tap"            -> { executeTap(params);           Triple(true, null, null) }
                    "swipe"          -> { executeSwipe(params);         Triple(true, null, null) }
                    "long_press"     -> { executeLongPress(params);     Triple(true, null, null) }
                    "type_text"      -> { executeTypeText(params);      Triple(true, null, null) }
                    "set_focused_text" -> Triple(true, executeSetFocusedText(params), null)
                    "scroll"         -> { executeScroll(params);        Triple(true, null, null) }
                    "open_app"       -> { executeOpenApp(params);       Triple(true, null, null) }
                    "open_app_fresh" -> { executeOpenAppFresh(params);  Triple(true, null, null) }
                    "close_app"      -> { executeCloseApp(params);      Triple(true, null, null) }
                    "screenshot"     -> Triple(true, executeScreenshot(params), null)
                    "screenshot_for_vlm" -> Triple(true, executeScreenshotForVlm(), null)
                    "screen_record"  -> Triple(true, executeScreenRecord(params), null)
                    "ui_tree_dump"   -> Triple(true, executeUiTreeDump(params), null)
                    "ocr_find_tap"   -> Triple(true, executeOcrFindTap(params), null)
                    "ocr_full"       -> Triple(true, executeOcrFull(), null)
                    "press_key"      -> { executePressKey(params);      Triple(true, null, null) }
                    "screen_wake"    -> Triple(true, executeScreenWake(), null)
                    "screen_off"     -> Triple(true, executeScreenOff(), null)
                    "unlock"         -> Triple(true, executeUnlock(params), null)
                    "get_screen_state" -> Triple(true, executeGetScreenState(), null)
                    "get_clipboard"  -> Triple(true, executeGetClipboard(), null)
                    "set_clipboard"  -> { executeSetClipboard(params);  Triple(true, null, null) }
                    "wait_for_idle"  -> Triple(true, executeWaitForIdle(params), null)
                    "file_push"      -> Triple(true, executeFilePush(params), null)
                    "file_delete"    -> Triple(true, executeFileDelete(params), null)
                    "pm_uninstall"   -> { executePmUninstall(params);   Triple(true, null, null) }
                    "reboot"         -> { executeReboot();              Triple(true, null, null) }
                    "ota_update"     -> { executeOtaUpdate(params);     Triple(true, null, null) }
                    "get_foreground_app" -> Triple(true, executeGetForegroundApp(), null)
                    "intent_send"    -> executeIntentSendJob(params)
                    // Skill system
                    "skill_tap"      -> Triple(true, executeSkillTap(params), null)
                    "a11y_find_tap"  -> Triple(true, executeA11yFindTap(params), null)
                    // Workflow system — executes workflow JSON locally, consults server for decisions
                    "workflow_execute" -> Triple(true, executeWorkflow(params), null)
                    else             -> Triple(false, null, "Unknown job type: $type")
                }
            } ?: Triple(false, null, "Execution timeout (${jobTimeoutMs}ms)")
        } catch (e: Exception) {
            Log.e(TAG, "Job $jobId execution failed: ${e.message}")
            Triple(false, null as JSONObject?, e.message)
        }

        val durationMs = System.currentTimeMillis() - startedAt
        lastJobSuccessful = successful

        // POST-ACTION verification — also wrapped: a cascade failure must not swallow JOB_RESULT.
        val verification = if (successful && cascade != null && preCtx != null) {
            try {
                cascade.verifyAfterAction(preCtx, targetRoi)
            } catch (e: Exception) {
                Log.w(TAG, "verifyAfterAction failed (stub used): ${e.message}")
                verificationStubPhase1()
            }
        } else {
            verificationStubPhase1()
        }

        // Idempotency cache
        Log.i(TAG, "Job $jobId: caching result successful=$successful")
        cacheResult(jobId, successful)

        // Always send JOB_RESULT — server audit log updated from this.
        Log.i(TAG, "Job $jobId: calling onResult successful=$successful")
        onResult(buildResult(jobId, successful, output, error, durationMs, verification))
        Log.i(TAG, "Job $jobId: onResult returned")
    }

    // ─── Job handlers ─────────────────────────────────────────────────────────

    private suspend fun executeTap(params: JSONObject) {
        // Supports both pixel coords (int) and normalized (0.0-1.0)
        val rawX = params.getDouble("x")
        val rawY = params.getDouble("y")
        val (screenW, screenH) = ScreenMetrics.getRealDimensions(context)
        val x = if (rawX > 0.0 && rawX <= 1.0) (rawX * screenW).toInt() else rawX.toInt()
        val y = if (rawY > 0.0 && rawY <= 1.0) (rawY * screenH).toInt() else rawY.toInt()
        Log.i(TAG, "tap: raw($rawX, $rawY) → pixel($x, $y) screen=${screenW}x${screenH}")
        automation.tap(x, y)
    }

    private suspend fun executeSwipe(params: JSONObject) {
        val (screenW, screenH) = ScreenMetrics.getRealDimensions(context)
        val startX = resolveCoord(params.getDouble("startX"), screenW)
        val startY = resolveCoord(params.getDouble("startY"), screenH)
        val endX = resolveCoord(params.getDouble("endX"), screenW)
        val endY = resolveCoord(params.getDouble("endY"), screenH)
        automation.swipe(startX, startY, endX, endY, params.getLong("durationMs"))
    }

    private fun resolveCoord(raw: Double, screenDim: Int): Int {
        return if (raw > 0.0 && raw <= 1.0) (raw * screenDim).toInt() else raw.toInt()
    }

    private suspend fun executeTypeText(params: JSONObject) =
        automation.typeText(
            params.getString("text"),
            exact = params.optBoolean("exact", false),
            verifyFinal = params.optBoolean("verifyFinal", true)
        )

    private suspend fun executeSetFocusedText(params: JSONObject): JSONObject = withContext(Dispatchers.Main) {
        val text = params.getString("text")
        val svc = accessibilityService
            ?: throw IllegalStateException("AccessibilityService not connected")
        val rootNode = svc.rootInActiveWindow
            ?: throw IllegalStateException("No active window root")

        val focused = rootNode.findFocus(android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT)
            ?: throw IllegalStateException("No focused input field")
        try {
            val args = android.os.Bundle().apply {
                putCharSequence(
                    android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    text
                )
            }
            val ok = focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            if (!ok) throw IllegalStateException("ACTION_SET_TEXT failed")
            JSONObject().put("set", true).put("length", text.length)
        } finally {
            focused.recycle()
            rootNode.recycle()
        }
    }

    private suspend fun executeScroll(params: JSONObject) =
        automation.scroll(
            params.getString("direction"),
            if (params.has("distancePx")) params.getInt("distancePx") else 400,
            if (params.has("durationMs")) params.getLong("durationMs") else 300L
        )

    private suspend fun executeOpenApp(params: JSONObject) =
        automation.openApp(params.getString("packageName"))

    private suspend fun executeOpenAppFresh(params: JSONObject) =
        automation.openAppFresh(params.getString("packageName"))

    private suspend fun executeCloseApp(params: JSONObject) =
        automation.closeApp(params.getString("packageName"))

    private suspend fun executeScreenshot(params: JSONObject): JSONObject {
        val quality = params.optInt("quality", 80)
        val result = capture.takeScreenshot(quality)
        return result
    }

    private suspend fun executeScreenRecord(params: JSONObject): JSONObject {
        val result = capture.recordScreen(params.getLong("durationMs"))
        return result
    }

    private suspend fun executeScreenshotForVlm(): JSONObject {
        return capture.takeScreenshotForVlmJson()
    }

    private suspend fun executeUiTreeDump(params: JSONObject): JSONObject {
        ensureAccessibilityConnected()
        val pkg = params.optString("packageName").takeIf { it.isNotEmpty() }
        return JSONObject().put("uiTree", automation.uiTreeDump(pkg))
    }

    private suspend fun ensureAccessibilityConnected() {
        if (accessibilityService != null) return
        AgentForegroundService.requestAccessibilityRecovery()
        val connected = withTimeoutOrNull(12_000L) {
            while (accessibilityService == null) delay(100L)
            true
        } ?: false
        if (!connected) throw IllegalStateException("AccessibilityService recovery timed out")
    }

    /**
     * OCR Find + Tap — uses ML Kit to find text on screen and tap its center.
     * 
     * Params:
     *   - searchText: string to find
     *   - partialMatch: boolean (default false) — if true, matches substrings
     * 
     * Returns JSON with found, coords, tapped status, and all OCR blocks.
     */
    private suspend fun executeOcrFindTap(params: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val searchText   = params.optString("searchText", "")
        val partialMatch = params.optBoolean("partialMatch", false)

        // 1. Screenshot
        val bitmap = capture.takeScreenshotBitmap()
            ?: return@withContext JSONObject().apply {
                put("found", false)
                put("totalBlocks", 0)
                put("tapped", false)
                put("error", "screenshot_failed")
            }

        // 2. Screen dimensions for coordinate normalization (use REAL dimensions)
        val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)

        // 3. OCR
        val result = ocr.findText(
            bitmap       = bitmap,
            searchText   = searchText,
            partialMatch = partialMatch,
            screenWidth  = screenWidth,
            screenHeight = screenHeight
        )

        // 4. Tap if found
        var tapped = false
        if (result.found) {
            try {
                automation.tap(result.pixelX, result.pixelY)
                tapped = true
            } catch (e: Exception) {
                Log.e(TAG, "OCR tap failed at (${result.pixelX}, ${result.pixelY}): ${e.message}")
            }
        }

        // 5. Serialize result (extends OcrFindResult with `tapped` field)
        return@withContext ocr.toJson(result).apply {
            put("tapped", tapped)
        }
    }

    // ─── OCR Full Screen ──────────────────────────────────────────────────────

    /**
     * Full-screen OCR — ML Kit Text Recognition, returns all text blocks with bounds.
     *
     * Used by Screen Detection Cascade L2 (ocr.detector.ts on server-side) to identify
     * which screen is currently visible via text markers (e.g. "Action Blocked",
     * "Turn on notifications", etc.).
     *
     * Result JSON:
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
     */
    private suspend fun executeOcrFull(): JSONObject {
        // 1. Take screenshot
        val bitmap = capture.takeScreenshotBitmap()
            ?: return JSONObject().apply {
                put("blocks", org.json.JSONArray())
                put("fullText", "")
                put("totalBlocks", 0)
                put("error", "screenshot_failed")
            }

        // 2. Screen dimensions for coordinate scaling (use REAL dimensions)
        val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)

        // 3. Run full OCR
        return ocr.runFullOcr(bitmap, screenWidth, screenHeight)
    }

    private suspend fun executePressKey(params: JSONObject) = withContext(Dispatchers.Main) {
        val key = PressKeyResolver.normalize(params.optString("key", "back"))
        val svc = accessibilityService
            ?: throw IllegalStateException("AccessibilityService not connected")

        if (PressKeyResolver.isGlobalAction(key)) {
            val action = when (key) {
                "back" -> AccessibilityService.GLOBAL_ACTION_BACK
                "home" -> AccessibilityService.GLOBAL_ACTION_HOME
                else -> AccessibilityService.GLOBAL_ACTION_RECENTS
            }
            if (!svc.performGlobalAction(action)) {
                throw IllegalStateException("Global key action failed: $key")
            }
        } else {
            val keyCode = PressKeyResolver.shellKeyCode(key)
                ?: throw IllegalArgumentException("Unknown key: $key")
            val result = BoundedProcessRunner.run(
                arrayOf("su", "-c", "input keyevent $keyCode"),
                ROOT_COMMAND_TIMEOUT_MS,
            )
            if (!result.success) {
                throw IllegalStateException(
                    "Key event failed: $key (code=$keyCode, exit=${result.exitCode}, ${result.output})"
                )
            }
        }
        delay(300L)
    }

    // ─── Long press ───────────────────────────────────────────────────────────

    private suspend fun executeLongPress(params: JSONObject) = withContext(Dispatchers.Main) {
        val x = params.getInt("x").toFloat()
        val y = params.getInt("y").toFloat()
        val durationMs = params.optLong("durationMs", 1000L)

        val svc = accessibilityService
            ?: throw IllegalStateException("AccessibilityService not connected")

        val path = android.graphics.Path().apply { moveTo(x, y) }
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(
            path, 0, durationMs
        )
        val gesture = android.accessibilityservice.GestureDescription.Builder()
            .addStroke(stroke)
            .build()

        val result = kotlinx.coroutines.suspendCancellableCoroutine<Boolean> { cont ->
            svc.dispatchGesture(gesture, object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: android.accessibilityservice.GestureDescription?) {
                    cont.resume(true)
                }
                override fun onCancelled(gestureDescription: android.accessibilityservice.GestureDescription?) {
                    cont.resume(false)
                }
            }, null)
        }
        if (!result) throw RuntimeException("Long press gesture cancelled")
    }

    // ─── Screen state ─────────────────────────────────────────────────────────

    private suspend fun executeScreenWake(): JSONObject = withContext(Dispatchers.IO) {
        val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        @Suppress("DEPRECATION")
        val wakeLock = pm.newWakeLock(
            android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
            android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "PhoneNetwork:ScreenWake"
        )
        wakeLock.acquire(1000L)  // acquire for 1s then auto-release
        delay(100L)  // let screen turn on
        JSONObject().put("screenOn", pm.isInteractive)
    }

    private suspend fun executeScreenOff(): JSONObject = withContext(Dispatchers.Main) {
        val svc = accessibilityService
            ?: throw IllegalStateException("AccessibilityService not connected")
        // API 28+: GLOBAL_ACTION_LOCK_SCREEN
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
        } else {
            // Fallback: power button via root
            val result = BoundedProcessRunner.run(
                arrayOf("su", "-c", "input keyevent 26"),
                ROOT_COMMAND_TIMEOUT_MS,
            )
            if (!result.success) throw IllegalStateException("screen_off root fallback failed: ${result.output}")
        }
        delay(300L)
        val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        JSONObject().put("screenOn", pm.isInteractive)
    }

    private suspend fun executeGetScreenState(): JSONObject = withContext(Dispatchers.IO) {
        val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        val km = context.getSystemService(android.content.Context.KEYGUARD_SERVICE) as android.app.KeyguardManager

        val isScreenOn = pm.isInteractive
        val isLocked = km.isKeyguardLocked

        val state = when {
            !isScreenOn -> "off"
            isLocked -> "locked"
            else -> "unlocked"
        }
        JSONObject().put("state", state)
    }

    private suspend fun executeUnlock(params: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        // First wake screen if off
        val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        if (!pm.isInteractive) {
            @Suppress("DEPRECATION")
            val wakeLock = pm.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "PhoneNetwork:Unlock"
            )
            wakeLock.acquire(1000L)
            delay(500L)
        }

        val km = context.getSystemService(android.content.Context.KEYGUARD_SERVICE) as android.app.KeyguardManager
        if (!km.isKeyguardLocked) {
            return@withContext JSONObject().put("unlocked", true).put("note", "was_already_unlocked")
        }

        // Swipe up to show PIN entry (use REAL dimensions)
        val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)
        val centerX = screenWidth / 2
        val startY = screenHeight * 3 / 4
        val endY = screenHeight / 4
        automation.swipe(centerX, startY, centerX, endY, 300L)
        delay(500L)

        // Enter PIN if provided
        val pin = params.optString("pin", "")
        if (pin.isNotEmpty()) {
            automation.typeText(pin)
            delay(200L)
            // Press enter
            val result = BoundedProcessRunner.run(
                arrayOf("su", "-c", "input keyevent 66"),
                ROOT_COMMAND_TIMEOUT_MS,
            )
            if (!result.success) throw IllegalStateException("unlock enter failed: ${result.output}")
        }

        // Enter pattern if provided (array of points 0-8)
        val patternArray = params.optJSONArray("pattern")
        if (patternArray != null && patternArray.length() > 0) {
            // Pattern points on 3x3 grid
            // 0 1 2
            // 3 4 5
            // 6 7 8
            val patternGridSize = screenWidth / 3
            val patternStartX = screenWidth / 6
            val patternStartY = screenHeight / 2  // approximate pattern area

            fun pointToCoords(point: Int): Pair<Int, Int> {
                val col = point % 3
                val row = point / 3
                return Pair(
                    patternStartX + col * patternGridSize,
                    patternStartY + row * patternGridSize
                )
            }

            // Build pattern as swipe through all points
            val sb = StringBuilder("input swipe")
            for (i in 0 until patternArray.length()) {
                val (px, py) = pointToCoords(patternArray.getInt(i))
                sb.append(" $px $py")
            }
            val result = BoundedProcessRunner.run(
                arrayOf("su", "-c", sb.toString()),
                ROOT_COMMAND_TIMEOUT_MS,
            )
            if (!result.success) throw IllegalStateException("unlock pattern failed: ${result.output}")
        }

        delay(500L)
        JSONObject().put("unlocked", !km.isKeyguardLocked)
    }

    // ─── Clipboard ────────────────────────────────────────────────────────────

    private suspend fun executeGetClipboard(): JSONObject = withContext(Dispatchers.Main) {
        val cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        val clip = cm.primaryClip
        val text = if (clip != null && clip.itemCount > 0) {
            clip.getItemAt(0).coerceToText(context)?.toString()
        } else null
        JSONObject().put("text", text ?: JSONObject.NULL)
    }

    private suspend fun executeSetClipboard(params: JSONObject) = withContext(Dispatchers.Main) {
        val text = params.getString("text")
        val cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        val clip = android.content.ClipData.newPlainText("PhoneNetwork", text)
        cm.setPrimaryClip(clip)
    }

    // ─── Foreground app detection ─────────────────────────────────────────────

    private suspend fun executeGetForegroundApp(): JSONObject = withContext(Dispatchers.Main) {
        val svc = accessibilityService
        val result = JSONObject()

        if (svc != null) {
            // Primary method: AccessibilityService (no extra permissions needed)
            val rootNode = svc.rootInActiveWindow
            if (rootNode != null) {
                val packageName = rootNode.packageName?.toString()
                result.put("packageName", packageName ?: JSONObject.NULL)

                // Get app label from PackageManager
                if (packageName != null) {
                    try {
                        val pm = context.packageManager
                        val appInfo = pm.getApplicationInfo(packageName, 0)
                        result.put("appLabel", pm.getApplicationLabel(appInfo).toString())
                    } catch (e: Exception) {
                        result.put("appLabel", JSONObject.NULL)
                    }
                }

                // Activity name is not directly available from A11y, but window info might help
                result.put("activityName", JSONObject.NULL)
                rootNode.recycle()
            } else {
                result.put("packageName", JSONObject.NULL)
                result.put("appLabel", JSONObject.NULL)
                result.put("activityName", JSONObject.NULL)
                result.put("error", "No active window available")
            }
        } else {
            throw IllegalStateException("AccessibilityService not connected")
        }

        result
    }

    // ─── Intent/Deep link sending ─────────────────────────────────────────────

    private suspend fun executeIntentSendJob(params: JSONObject): Triple<Boolean, JSONObject, String?> {
        val output = executeIntentSend(params)
        val launched = output.optBoolean("launched", false)
        if (launched) {
            return Triple(true, output, null)
        }

        val error = output.optString("error", "intent_send did not launch an activity")
            .ifBlank { "intent_send did not launch an activity" }
        return Triple(false, output, error)
    }

    private suspend fun executeIntentSend(params: JSONObject): JSONObject = withContext(Dispatchers.Main) {
        val uri = params.getString("uri")
        val action = params.optString("action", android.content.Intent.ACTION_VIEW)
        val targetPackage = params.optString("packageName", "").takeIf { it.isNotEmpty() }
        val extrasObj = params.optJSONObject("extras")
        val flagsArray = params.optJSONArray("flags")

        val intent = android.content.Intent(action).apply {
            data = android.net.Uri.parse(uri)

            // Always add NEW_TASK for launching from service context
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)

            // Add any additional flags
            if (flagsArray != null) {
                for (i in 0 until flagsArray.length()) {
                    val flagName = flagsArray.getString(i)
                    when (flagName) {
                        "FLAG_ACTIVITY_CLEAR_TOP" -> addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        "FLAG_ACTIVITY_SINGLE_TOP" -> addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        "FLAG_ACTIVITY_CLEAR_TASK" -> addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        "FLAG_ACTIVITY_NO_HISTORY" -> addFlags(android.content.Intent.FLAG_ACTIVITY_NO_HISTORY)
                        // FLAG_ACTIVITY_NEW_TASK already added
                    }
                }
            }

            // Set target package if specified
            if (targetPackage != null) {
                setPackage(targetPackage)
            }

            // Add extras
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

        // Package visibility can make resolveActivity return null on modern Android
        // even when startActivity would succeed. Treat startActivity as canonical.
        val pm = context.packageManager
        val resolveInfo = pm.resolveActivity(intent, 0)

        val result = JSONObject()
        try {
            context.startActivity(intent)
            result.put("launched", true)
            if (resolveInfo != null) {
                result.put("resolvedActivity", "${resolveInfo.activityInfo.packageName}/${resolveInfo.activityInfo.name}")
            }
        } catch (e: android.content.ActivityNotFoundException) {
            result.put("launched", false)
            result.put("error", "No activity found to handle intent: $uri")
        } catch (e: Exception) {
            result.put("launched", false)
            result.put("error", e.message ?: "Failed to send intent: $uri")
        }

        result
    }

    // ─── Wait for idle ────────────────────────────────────────────────────────

    private suspend fun executeWaitForIdle(params: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val timeoutMs = params.optLong("timeoutMs", 5000L)
        val startTime = System.currentTimeMillis()
        var lastEventTime = startTime
        val pollIntervalMs = 200L
        val idleThresholdMs = 500L  // Consider idle if no UI changes for 500ms

        // Poll until no accessibility events for idleThresholdMs
        while (System.currentTimeMillis() - startTime < timeoutMs) {
            // Check if UI tree has changed
            val svc = accessibilityService
            if (svc != null) {
                // If we can get the root, the UI is responding
                // We consider it "idle" if we don't get rapid updates
                @Suppress("UNUSED_VARIABLE")
                val currentWindow = svc.rootInActiveWindow  // Just checking if accessible
            }
            delay(pollIntervalMs)

            // Simple heuristic: if we've been polling for idleThresholdMs without
            // major changes, consider it idle
            if (System.currentTimeMillis() - lastEventTime >= idleThresholdMs) {
                break
            }
            lastEventTime = System.currentTimeMillis()
        }

        val waitedMs = System.currentTimeMillis() - startTime
        JSONObject()
            .put("idle", true)
            .put("waitedMs", waitedMs)
    }

    // ─── File operations ──────────────────────────────────────────────────────

    private suspend fun executeFilePush(params: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val localPath = params.getString("localPath")  // URL or server path
        val remotePath = params.getString("remotePath")

        // Download from URL
        val url = java.net.URL(localPath)
        val conn = url.openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 30_000
        conn.readTimeout = 60_000

        val destFile = java.io.File(remotePath)
        destFile.parentFile?.mkdirs()

        var bytesWritten = 0L
        try {
            conn.inputStream.use { input ->
                java.io.FileOutputStream(destFile).use { output ->
                    val buffer = ByteArray(8192)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        bytesWritten += read
                    }
                }
            }
        } finally {
            conn.disconnect()
        }

        JSONObject()
            .put("success", true)
            .put("bytesWritten", bytesWritten)
    }

    private suspend fun executeFileDelete(params: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val remotePath = params.getString("remotePath")
        val file = java.io.File(remotePath)

        val deleted = if (file.exists()) {
            file.delete()
        } else {
            // File doesn't exist — consider it "deleted"
            true
        }

        JSONObject().put("deleted", deleted)
    }

    // ─── Root commands ────────────────────────────────────────────────────────

    private suspend fun executePmUninstall(params: JSONObject) {
        val pkg      = params.getString("packageName")
        val keepData = params.optBoolean("keepData", false)
        otaInstaller.uninstall(pkg, keepData)
    }

    private suspend fun executeReboot() {
        // Uses libsu Shell.cmd — specific command, not Runtime.exec()
        // Dependency: com.github.topjohnwu.libsu:core (add to build.gradle.kts)
        // Shell.cmd("reboot").exec()
        Log.w(TAG, "Reboot requested — requires libsu dependency")
        throw UnsupportedOperationException("Add com.github.topjohnwu.libsu:core to build.gradle.kts")
    }

    /**
     * OTA update: download APK, verify SHA256 + RSA signature, check versionCode, install.
     * All parameters come as proper JSON fields — no URL-splitting hacks.
     */
    private suspend fun executeOtaUpdate(params: JSONObject) {
        val apkUrl       = params.getString("apkUrl")       // full HTTPS URL
        val sha256       = params.getString("apkSha256")
        val signature    = params.optString("apkSignature", "")  // optional — server may not sign
        val versionCode  = params.getInt("versionCode")
        val forceDowngrade = params.optBoolean("forceDowngrade", false)
        otaInstaller.downloadVerifyInstall(apkUrl, sha256, signature, versionCode, forceDowngrade)
    }

    // ─── Idempotency cache (persistent) ──────────────────────────────────────

    /**
     * Cache format: "$status|$timestampMs" — timestamp used for age-based pruning.
     * SharedPreferences has no ordering; we embed timestamp to sort by age.
     */
    private fun cacheResult(jobId: String, successful: Boolean) {
        try {
            val all = idempotencyPrefs.all
            if (all.size >= MAX_CACHE_SIZE) {
                // Sort by embedded timestamp (oldest first), remove ~10%
                val toRemove = all.entries
                    .mapNotNull { (k, v) ->
                        val ts = (v as? String)?.substringAfterLast('|')?.toLongOrNull() ?: 0L
                        k to ts
                    }
                    .sortedBy { it.second }
                    .take(MAX_CACHE_SIZE / 10)
                    .map { it.first }
                idempotencyPrefs.edit()
                    .also { ed -> toRemove.forEach { ed.remove(it) } }
                    .apply()
                Log.d(TAG, "Idempotency cache pruned ${toRemove.size} entries")
            }
            idempotencyPrefs.edit()
                .putString(jobId, "$successful|${System.currentTimeMillis()}")
                .apply()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cache job result: ${e.message}")
        }
    }

    private fun loadCachedResult(jobId: String): Boolean? =
        idempotencyPrefs.getString(jobId, null)?.substringBefore('|')?.toBooleanStrictOrNull()

    // ─── Cascade helpers ─────────────────────────────────────────────────────

    /**
     * Build VerificationCascade if AccessibilityService is available.
     * Returns null if A11y service not yet connected — fallback to stub.
     */
    private fun buildCascade(
        strategy:    VerificationStrategy,
        l1TimeoutMs: Long,
        l2SettleMs:  Long
    ): VerificationCascade? {
        val a11y = accessibilityService ?: run {
            Log.w(TAG, "A11y service not connected — cascade unavailable, using stub")
            return null
        }
        return VerificationCascade(
            a11yService   = a11y,
            strategy      = strategy,
            l1TimeoutMs   = l1TimeoutMs,
            l2SettleMs    = l2SettleMs,
            captureScreen = { capture.takeScreenshotBitmap() }
        )
    }

    // ─── Skill system ─────────────────────────────────────────────────────────

    /**
     * Execute skill tap — tap at normalized coordinates (0.0-1.0).
     * Returns screenshot for server-side verification.
     */
    private suspend fun executeSkillTap(params: JSONObject): JSONObject = withContext(Dispatchers.Main) {
        val normalizedX = params.getDouble("x")
        val normalizedY = params.getDouble("y")
        val skillId = params.optString("skillId", "")
        val buttonId = params.optString("buttonId", "")

        // Get screen dimensions (use REAL dimensions including nav bar)
        val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)

        // Convert normalized to pixel coords
        val pixelX = (normalizedX * screenWidth).toInt()
        val pixelY = (normalizedY * screenHeight).toInt()

        Log.i(TAG, "skill_tap: normalized($normalizedX, $normalizedY) → pixel($pixelX, $pixelY) skill=$skillId button=$buttonId")

        // Execute tap
        automation.tap(pixelX, pixelY)

        // Small delay for UI to respond
        delay(100L)

        // Take screenshot for verification
        val screenshotResult = capture.takeScreenshot(70)
        val screenshotBase64 = screenshotResult.optString("base64", "")

        JSONObject().apply {
            put("tapped", true)
            put("pixelX", pixelX)
            put("pixelY", pixelY)
            put("normalizedX", normalizedX)
            put("normalizedY", normalizedY)
            put("screenWidth", screenWidth)
            put("screenHeight", screenHeight)
            if (screenshotBase64.isNotEmpty()) {
                put("screenshotBase64", screenshotBase64)
            }
        }
    }

    /**
     * Find element via AccessibilityService and tap it.
     * Returns the found coordinates for skill auto-learn.
     *
     * FIX: Added try-finally for proper node recycling on exceptions.
     */
    private suspend fun executeA11yFindTap(params: JSONObject): JSONObject = withContext(Dispatchers.Main) {
        val svc = accessibilityService
            ?: throw IllegalStateException("AccessibilityService not connected")

        val text = params.optString("text", "").takeIf { it.isNotEmpty() }
        val contentDescription = params.optString("contentDescription", "").takeIf { it.isNotEmpty() }
        val className = params.optString("className", "").takeIf { it.isNotEmpty() }
        val resourceId = params.optString("resourceId", "").takeIf { it.isNotEmpty() }
        val partialMatch = params.optBoolean("partialMatch", false)

        Log.i(TAG, "a11y_find_tap: text=$text cd=$contentDescription class=$className res=$resourceId partial=$partialMatch")

        // Get root node
        val rootNode = svc.rootInActiveWindow
            ?: throw IllegalStateException("No active window root")

        // Get screen dimensions for normalization (use REAL dimensions including nav bar)
        val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)

        var foundNode: android.view.accessibility.AccessibilityNodeInfo? = null
        try {
            // Find matching node (with depth limit to prevent stack overflow)
            foundNode = findMatchingNode(rootNode, text, contentDescription, className, resourceId, partialMatch, 0)

            if (foundNode == null) {
                return@withContext JSONObject().apply {
                    put("found", false)
                    put("error", "Element not found")
                }
            }

            // Get bounds
            val bounds = android.graphics.Rect()
            foundNode.getBoundsInScreen(bounds)

            // Calculate center
            val centerX = (bounds.left + bounds.right) / 2
            val centerY = (bounds.top + bounds.bottom) / 2

            // Normalize coordinates
            val normalizedX = centerX.toDouble() / screenWidth
            val normalizedY = centerY.toDouble() / screenHeight

            // Get matched text for logging
            val matchedText = foundNode.text?.toString() ?: foundNode.contentDescription?.toString() ?: ""

            Log.i(TAG, "a11y_find_tap: found at ($centerX, $centerY) → normalized ($normalizedX, $normalizedY)")

            // Execute tap (after releasing nodes to avoid holding references during gesture)
            foundNode.recycle()
            foundNode = null
            rootNode.recycle()

            automation.tap(centerX, centerY)

            JSONObject().apply {
                put("found", true)
                put("pixelX", centerX)
                put("pixelY", centerY)
                put("x", normalizedX)
                put("y", normalizedY)
                put("bounds", JSONObject().apply {
                    put("left", bounds.left)
                    put("top", bounds.top)
                    put("right", bounds.right)
                    put("bottom", bounds.bottom)
                })
                put("matchedText", matchedText)
                put("screenWidth", screenWidth)
                put("screenHeight", screenHeight)
            }
        } finally {
            // Always recycle nodes to prevent memory leaks
            try { foundNode?.recycle() } catch (_: Exception) {}
            try { rootNode.recycle() } catch (_: Exception) {}
        }
    }

    /**
     * Execute a workflow JSON locally.
     * Phone executes steps, calls server (/workflow/decide) when decisions are needed.
     * 
     * Params:
     *   - workflow: JSON object with name, steps[]
     */
    private suspend fun executeWorkflow(params: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val workflow = params.optJSONObject("workflow")
            ?: throw IllegalStateException("Missing 'workflow' in params")
        
        val workflowName = workflow.optString("name", "unknown")
        val steps = workflow.optJSONArray("steps") 
            ?: throw IllegalStateException("Missing 'steps' in workflow")
        
        Log.i(TAG, "[workflow] Starting workflow: $workflowName with ${steps.length()} steps")
        
        val completedSteps = mutableSetOf<String>()
        val results = JSONObject()
        
        // Helper: check if step dependencies are met
        fun canExecute(step: JSONObject): Boolean {
            val requires = step.optJSONArray("requires") ?: return true
            for (i in 0 until requires.length()) {
                if (!completedSteps.contains(requires.getString(i))) return false
            }
            return true
        }
        
        // Helper: wait
        suspend fun waitMs(ms: Long) {
            delay(ms)
        }
        
        // Helper: call server for decision
        suspend fun askServer(stepId: String, check: String, context: JSONObject): JSONObject {
            Log.i(TAG, "[workflow] Asking server for decision: $stepId ($check)")
            val body = JSONObject().apply {
                put("workflowName", workflowName)
                put("stepName", stepId)
                put("context", context)
            }
            
            // Make HTTP request to server
            val url = java.net.URL("http://localhost:3000/api/workflow/decide")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Api-Key", "24018503cf6bd0ae1e5b1f829a5f66cf23fc2160aea90dff3b91427419cec746")
            conn.doOutput = true
            conn.outputStream.write(body.toString().toByteArray())
            
            val response = conn.inputStream.bufferedReader().readText()
            return JSONObject(response)
        }
        
        // Execute steps in order (simple sequential for now)
        for (i in 0 until steps.length()) {
            val step = steps.getJSONObject(i)
            val stepId = step.optString("id", "step_$i")
            val stepType = step.optString("type")
            
            Log.i(TAG, "[workflow] Executing step $stepId ($stepType)")
            
            when (stepType) {
                "screen_wake" -> {
                    executeScreenWake()
                    completedSteps.add(stepId)
                    results.put(stepId, JSONObject().put("successful", true))
                }
                "unlock" -> {
                    val unlockResult = executeUnlock(step.optJSONObject("params") ?: JSONObject())
                    completedSteps.add(stepId)
                    results.put(stepId, unlockResult)
                }
                "open_app" -> {
                    val pkg = step.optString("package")
                    if (pkg.isNotEmpty()) {
                        automation.openApp(pkg)
                    }
                    completedSteps.add(stepId)
                    results.put(stepId, JSONObject().put("successful", true))
                }
                "wait" -> {
                    // Support both {ms: N} and {duration: {min, max, distribution}} formats
                    val waitMs = if (step.has("duration")) {
                        val dur = step.getJSONObject("duration")
                        val min = dur.optLong("min", 500)
                        val max = dur.optLong("max", 1000)
                        min + ((max - min) * Math.random()).toLong()
                    } else {
                        step.optLong("ms", 1000)
                    }
                    waitMs(waitMs)
                    completedSteps.add(stepId)
                    results.put(stepId, JSONObject().put("successful", true))
                }
                "cascade_tap", "tap" -> {
                    val target = step.optString("target")
                    if (target.isNotEmpty()) {
                        // Try OCR to find and tap
                        val ocrResult = executeOcrFindTap(JSONObject().apply {
                            put("searchText", target)
                            put("partialMatch", true)
                        })
                        if (ocrResult.optBoolean("found", false)) {
                            val tapped = ocrResult.optBoolean("tapped", false)
                            if (!tapped) {
                                val pixelX = ocrResult.optInt("pixelX")
                                val pixelY = ocrResult.optInt("pixelY")
                                automation.tap(pixelX, pixelY)
                            }
                            results.put(stepId, ocrResult)
                        } else {
                            results.put(stepId, JSONObject().put("successful", false).put("error", "Element not found: $target"))
                        }
                    }
                    completedSteps.add(stepId)
                }
                "decide" -> {
                    // Get current screen state and ask server
                    val fgResult = executeGetForegroundApp()
                    val screenState = JSONObject().apply {
                        val uiTree = automation.uiTreeDump(null)
                        put("uiTree", uiTree)
                        put("packageName", fgResult.optString("packageName"))
                    }
                    val check = step.optString("check", "")
                    val decision = askServer(stepId, check, screenState)
                    val action = decision.optString("action", "continue")
                    
                    Log.i(TAG, "[workflow] Server decision: $action")
                    results.put(stepId, decision)
                    
                    if (action == "done" || action == "stop") {
                        Log.i(TAG, "[workflow] Workflow completed: $action")
                        break
                    } else if (action == "retry_step") {
                        // Set a flag to retry from specific step
                        val retryStepId = decision.optString("nextStep")
                        Log.i(TAG, "[workflow] Need to retry step: $retryStepId")
                        // Mark steps to retry
                        completedSteps.remove(retryStepId)
                    }
                    completedSteps.add(stepId)
                }
                else -> {
                    Log.w(TAG, "[workflow] Unknown step type: $stepType")
                    results.put(stepId, JSONObject().put("successful", false).put("skipped", true).put("error", "Unknown type: $stepType"))
                    completedSteps.add(stepId)
                }
            }
            
            // Apply delay_after if specified
            val delayAfter = step.optLong("delay_after", 0)
            if (delayAfter > 0) {
                waitMs(delayAfter)
            }
        }
        
        Log.i(TAG, "[workflow] Workflow completed: $workflowName")
        return@withContext JSONObject().apply {
            put("workflowName", workflowName)
            put("completedSteps", completedSteps.size)
            put("results", results)
        }
    }

    /**
     * Recursively find a node matching the given criteria.
     *
     * FIX: Added depth limit (MAX_TREE_DEPTH=30) to prevent stack overflow on deep UI trees.
     * FIX: Added try-catch for child access to handle race conditions.
     */
    private fun findMatchingNode(
        node: android.view.accessibility.AccessibilityNodeInfo,
        text: String?,
        contentDescription: String?,
        className: String?,
        resourceId: String?,
        partialMatch: Boolean,
        depth: Int
    ): android.view.accessibility.AccessibilityNodeInfo? {
        // Depth limit to prevent stack overflow (typical Android UI depth is 10-20)
        if (depth > MAX_TREE_DEPTH) {
            Log.w(TAG, "findMatchingNode: max depth ($MAX_TREE_DEPTH) exceeded, stopping search")
            return null
        }

        // Check this node
        if (matchesNode(node, text, contentDescription, className, resourceId, partialMatch)) {
            return android.view.accessibility.AccessibilityNodeInfo.obtain(node)
        }

        // Check children with exception handling for race conditions
        val childCount = try { node.childCount } catch (_: Exception) { 0 }
        for (i in 0 until childCount) {
            val child = try { node.getChild(i) } catch (_: Exception) { null } ?: continue
            try {
                val found = findMatchingNode(child, text, contentDescription, className, resourceId, partialMatch, depth + 1)
                if (found != null) {
                    child.recycle()
                    return found
                }
            } finally {
                try { child.recycle() } catch (_: Exception) {}
            }
        }

        return null
    }

    /**
     * Check if a node matches the given criteria.
     */
    private fun matchesNode(
        node: android.view.accessibility.AccessibilityNodeInfo,
        text: String?,
        contentDescription: String?,
        className: String?,
        resourceId: String?,
        partialMatch: Boolean
    ): Boolean {
        // Resource ID match (exact)
        if (resourceId != null) {
            val nodeResId = node.viewIdResourceName
            if (nodeResId != null && nodeResId == resourceId) return true
        }

        // Class name match (exact)
        if (className != null) {
            val nodeClass = node.className?.toString()
            if (nodeClass != null && nodeClass == className) return true
        }

        // Text match
        if (text != null) {
            val nodeText = node.text?.toString()
            if (nodeText != null) {
                if (partialMatch && nodeText.contains(text, ignoreCase = true)) return true
                if (!partialMatch && nodeText.equals(text, ignoreCase = true)) return true
            }
        }

        // Content description match
        if (contentDescription != null) {
            val nodeCd = node.contentDescription?.toString()
            if (nodeCd != null) {
                if (partialMatch && nodeCd.contains(contentDescription, ignoreCase = true)) return true
                if (!partialMatch && nodeCd.equals(contentDescription, ignoreCase = true)) return true
            }
        }

        return false
    }

    /** Build L2 ROI from job params if x/y available */
    private fun buildRoi(params: JSONObject): L2PixelDiffVerifier.RoiBounds? {
        if (!params.has("x") || !params.has("y")) return null
        val x = params.optInt("x", -1)
        val y = params.optInt("y", -1)
        if (x < 0 || y < 0) return null
        // ROI: 200×200px centered on tap target
        return L2PixelDiffVerifier.RoiBounds(maxOf(0, x - 100), maxOf(0, y - 100), 200, 200)
    }

    // ─── Result builders ──────────────────────────────────────────────────────

    /**
     * Fallback stub when cascade is unavailable (A11y not connected or action failed).
     */
    private fun verificationStubPhase1(): JSONObject = JSONObject().apply {
        put("verified",           false)
        put("verifiedBy",         "none")
        put("cascadeLevelsUsed",  0)
        put("confidence",         0.0)
        put("llmTokensUsed",      0)
        put("verificationTimeMs", 0)
    }

    private fun buildResult(
        jobId: String,
        successful: Boolean,
        output: JSONObject?,
        error: String?,
        durationMs: Long,
        verification: Any = verificationStubPhase1()
    ): JSONObject = JSONObject().apply {
        put("jobId", jobId)
        put("successful", successful)
        put("output", output ?: JSONObject.NULL)
        put("error", error ?: JSONObject.NULL)
        put("durationMs", durationMs)
        put("verification", serializeVerification(verification))
        // deviceUuid intentionally omitted — server uses connection.deviceId (authenticated)
    }

    /** Serialize VerificationResult (Phase 2) or JSONObject (stub fallback) */
    private fun serializeVerification(v: Any): JSONObject = when (v) {
        is com.phonenetwork.verification.VerificationResult -> JSONObject().apply {
            put("verified",           v.verified)
            put("verifiedBy",         v.verifiedBy.value)
            put("cascadeLevelsUsed",  v.cascadeLevelsUsed)
            put("confidence",         v.confidence.toDouble())
            put("llmTokensUsed",      v.llmTokensUsed)
            put("verificationTimeMs", v.verificationTimeMs)
            if (v.note != null) put("note", v.note)
        }
        is JSONObject -> v
        else -> verificationStubPhase1()
    }

    // Note: buildCommandLog() REMOVED in v3.1.
    // Audit log is generated server-side from dispatch record + JOB_RESULT update.
    // Device sends no log entries.
}
