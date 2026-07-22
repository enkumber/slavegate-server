package com.phonenetwork.automation

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.phonenetwork.utils.ScreenMetrics
import com.phonenetwork.utils.BoundedProcessRunner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.random.Random

/**
 * AutomationController — all UI automation via AccessibilityService.
 *
 * Actions:
 *   tap(x, y)                       — single tap gesture at screen coordinates
 *   swipe(startX,startY,endX,endY)  — swipe gesture with configurable duration
 *   typeText(text, exact)           — type text into focused field
 *   scroll(direction, distancePx)   — scroll gesture (up/down/left/right)
 *   openApp(packageName)            — launch via getLaunchIntentForPackage
 *   closeApp(packageName)           — GLOBAL_ACTION_HOME + killBackgroundProcesses
 *   uiTreeDump(packageName?)        — dump accessibility node tree as JSON
 *
 * All gesture-based methods use GestureDescription (API 24+, our minSdk=29).
 * typeText can set/paste exact generated text, or humanize text entry when requested.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §4 (Automation)
 */
class AutomationController(private val service: AccessibilityService?) {

    companion object {
        private const val TAG = "PhoneNet/Automation"
        private const val GESTURE_TIMEOUT_MS = 5_000L
    }

    // ─── Tap ──────────────────────────────────────────────────────────────────

    suspend fun tap(x: Int, y: Int) {
        Log.d(TAG, "tap($x, $y)")
        val gestureCompleted = dispatchGesture(
            Path().apply { moveTo(x.toFloat(), y.toFloat()) },
            durationMs = 60L,
        )
        if (gestureCompleted) {
            Log.d(TAG, "tap: completed via Accessibility gesture")
            return
        }

        Log.w(TAG, "tap: Accessibility gesture unavailable/cancelled; trying bounded root fallback")
        val shellCompleted = runShellCommand("input tap $x $y")
        if (!shellCompleted) throw IllegalStateException("Tap failed: Accessibility and bounded root fallback unavailable")
        Log.d(TAG, "tap: completed via bounded root fallback")
    }

    // ─── Swipe ────────────────────────────────────────────────────────────────

    suspend fun swipe(
        startX: Int, startY: Int,
        endX:   Int, endY:   Int,
        durationMs: Long = 300L
    ) {
        Log.d(TAG, "swipe($startX,$startY → $endX,$endY, ${durationMs}ms)")
        val gestureCompleted = dispatchGesture(
            Path().apply {
                moveTo(startX.toFloat(), startY.toFloat())
                lineTo(endX.toFloat(), endY.toFloat())
            },
            durationMs = durationMs.coerceAtLeast(1L),
        )
        if (gestureCompleted) {
            Log.d(TAG, "swipe: completed via Accessibility gesture")
            return
        }

        Log.w(TAG, "swipe: Accessibility gesture unavailable/cancelled; trying bounded root fallback")
        val shellCompleted = withContext(Dispatchers.IO) {
            runShellCommand("input swipe $startX $startY $endX $endY $durationMs")
        }
        if (!shellCompleted) throw IllegalStateException("Swipe failed: Accessibility and bounded root fallback unavailable")
        Log.d(TAG, "swipe: completed via bounded root fallback")
    }

    private suspend fun dispatchGesture(path: Path, durationMs: Long): Boolean {
        val svc = service ?: return false
        return withContext(Dispatchers.Main) {
            withTimeoutOrNull(GESTURE_TIMEOUT_MS) {
                suspendCancellableCoroutine { continuation ->
                    val gesture = GestureDescription.Builder()
                        .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs))
                        .build()
                    val accepted = svc.dispatchGesture(
                        gesture,
                        object : AccessibilityService.GestureResultCallback() {
                            override fun onCompleted(gestureDescription: GestureDescription?) {
                                if (continuation.isActive) continuation.resume(true)
                            }

                            override fun onCancelled(gestureDescription: GestureDescription?) {
                                if (continuation.isActive) continuation.resume(false)
                            }
                        },
                        null,
                    )
                    if (!accepted && continuation.isActive) continuation.resume(false)
                }
            } ?: false
        }
    }

    // ─── Type text ────────────────────────────────────────────────────────────

    /**
     * Type text into the currently focused input field.
     *
     * Generated comments need both humanized entry and final exactness.
     * The default path types character-by-character, then reads the focused
     * field and corrects it if the final value differs from the target text.
     * exact=true skips humanized entry and uses ACTION_SET_TEXT/paste directly.
     *
     * Humanized timing:
     *   - Inter-character delay: none (shell exec latency ~500ms is enough)
     *   - Inter-word pause:      100-250ms
     *   - Typo simulation:       5-10% chance per char (wrong key → pause → backspace → correct key)
     *   - Thinking pause:        ~4% chance, 300-800ms
     */
    suspend fun typeText(text: String, exact: Boolean = false, verifyFinal: Boolean = true) {
        Log.d(TAG, "typeText(${text.take(20)}…, len=${text.length}, exact=$exact)")

        if (exact) {
            if (!setFocusedTextExact(text)) {
                throw IllegalStateException("typeText exact entry failed: unable to set focused field")
            }
            return
        }

        // ── Quick root check ──────────────────────────────────────────────────
        val rootAvailable = withContext(Dispatchers.IO) { isRootAvailable() }

        if (!rootAvailable) {
            Log.w(TAG, "typeText: root unavailable — falling back to instant ACTION_SET_TEXT")
            if (!setFocusedTextExact(text)) {
                throw IllegalStateException("typeText fallback failed: unable to set focused field")
            }
            return
        }

        // ── Character-by-character via root shell ─────────────────────────────
        val words = text.split(" ")
        for ((wordIdx, word) in words.withIndex()) {
            // Space between words (skip before first word)
            if (wordIdx > 0) {
                shellInputText(" ")
                delay(Random.nextLong(100, 250))   // inter-word pause
            }

            for (char in word) {
                // ── Typo simulation (5-10% chance) ────────────────────────────
                val typoChance = Random.nextFloat()
                if (typoChance < Random.nextFloat() * 0.05f + 0.05f) { // 5-10%
                    val wrongChar = generateNearbyTypo(char)
                    if (wrongChar != null) {
                        Log.d(TAG, "typeText: typo '$wrongChar' instead of '$char'")
                        shellInputText(wrongChar.toString())
                        delay(Random.nextLong(80, 200))        // notice the typo
                        shellInputKeyEvent(67)                  // KEYCODE_DEL (backspace)
                        delay(Random.nextLong(60, 150))         // pause before correction
                    }
                }

                // ── Type the correct character ────────────────────────────────
                shellInputText(char.toString())
                // No inter-char delay - shell exec latency is enough
            }
        }

        if (verifyFinal) {
            val actual = readFocusedEditableText()
            if (actual != text) {
                Log.w(TAG, "typeText: final text mismatch; correcting focused field (actualLen=${actual?.length ?: -1}, expectedLen=${text.length})")
                if (!setFocusedTextExact(text)) {
                    throw IllegalStateException("typeText final verification failed: unable to correct focused field")
                }
            }
        }

        Log.d(TAG, "typeText: done (${text.length} chars)")
    }

    // ─── Type text helpers ────────────────────────────────────────────────────

    /**
     * Send a single text string via root `input text`.
     * Properly escapes for shell single-quote context.
     */
    private suspend fun shellInputText(s: String) = withContext(Dispatchers.IO) {
        // Shell-escape: wrap in single quotes, escape embedded single quotes
        val escaped = s.replace("'", "'\\''")
        val result = BoundedProcessRunner.run(
            arrayOf("su", "-c", "input text '$escaped'"),
            GESTURE_TIMEOUT_MS,
        )
        if (!result.success) throw IllegalStateException("input text failed: ${result.output}")
    }

    /**
     * Send a key event via root `input keyevent`.
     */
    private suspend fun shellInputKeyEvent(keyCode: Int) = withContext(Dispatchers.IO) {
        val result = BoundedProcessRunner.run(
            arrayOf("su", "-c", "input keyevent $keyCode"),
            GESTURE_TIMEOUT_MS,
        )
        if (!result.success) throw IllegalStateException("input keyevent failed: ${result.output}")
    }

    /**
     * Check whether `su` is available on this device.
     */
    private fun isRootAvailable(): Boolean {
        return try {
            BoundedProcessRunner.runBlocking(
                arrayOf("su", "-c", "echo ok"),
                GESTURE_TIMEOUT_MS,
            ).success
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Generate a plausible typo for a character (adjacent key on QWERTY layout).
     * Returns null if no good neighbor exists (punctuation, emoji, etc.).
     */
    private fun generateNearbyTypo(char: Char): Char? {
        val qwertyNeighbors = mapOf(
            'q' to "wa",   'w' to "qeas",  'e' to "wrds",  'r' to "etfd",
            't' to "rygf", 'y' to "tuhg",  'u' to "yijh",  'i' to "uokj",
            'o' to "iplk", 'p' to "ol",
            'a' to "qwsz", 's' to "wedxza",'d' to "erfcxs",'f' to "rtgvcd",
            'g' to "tyhbvf",'h' to "yujnbg",'j' to "uikmnh",'k' to "iolmj",
            'l' to "opk",
            'z' to "asx",  'x' to "zsdc",  'c' to "xdfv",  'v' to "cfgb",
            'b' to "vghn", 'n' to "bhjm",  'm' to "njk"
        )
        val lower = char.lowercaseChar()
        val neighbors = qwertyNeighbors[lower] ?: return null
        val typo = neighbors[Random.nextInt(neighbors.length)]
        return if (char.isUpperCase()) typo.uppercaseChar() else typo
    }

    private suspend fun readFocusedEditableText(): String? = withContext(Dispatchers.Main) {
        val svc = requireService()
        val root = svc.rootInActiveWindow
        val focused = findFocusedOrEditableNode(root)
        val value = focused?.text?.toString()
        focused?.recycle()
        root?.recycle()
        value
    }

    /**
     * Exact text entry via ACTION_SET_TEXT with clipboard/paste fallback.
     */
    private suspend fun setFocusedTextExact(text: String): Boolean = withContext(Dispatchers.Main) {
        val svc = requireService()
        val root = svc.rootInActiveWindow
        val focused = findFocusedOrEditableNode(root)
        var success = false

        if (focused != null) {
            val args = Bundle().apply {
                putString(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            val ok = focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            success = ok
            if (!success) {
                // Last resort: clipboard + paste
                val clipboard = svc.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("typed", text))
                focused.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
                success = focused.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            }
            focused.recycle()
        } else {
            Log.w(TAG, "setFocusedTextExact: no focused editable node found")
        }
        root?.recycle()
        success
    }

    // ─── Scroll ───────────────────────────────────────────────────────────────

    suspend fun scroll(
        direction:  String,
        distancePx: Int,
        durationMs: Long = 300L
    ) = withContext(Dispatchers.IO) {
        Log.d(TAG, "scroll($direction, ${distancePx}px)")
        val svc = requireService()

        // Screen center as scroll origin (use REAL dimensions including nav bar)
        val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(svc)
        val cx   = screenWidth / 2
        val cy   = screenHeight / 2
        val half = distancePx / 2

        // "scroll down" = content moves up = finger swipes UP (start low, end high)
        // "scroll up"   = content moves down = finger swipes DOWN (start high, end low)
        val (startX, startY, endX, endY) = when (direction.lowercase()) {
            "up"    -> listOf(cx, cy - half, cx, cy + half)  // swipe down to scroll up
            "down"  -> listOf(cx, cy + half, cx, cy - half)  // swipe up to scroll down
            "left"  -> listOf(cx - half, cy, cx + half, cy)  // swipe right to scroll left
            "right" -> listOf(cx + half, cy, cx - half, cy)  // swipe left to scroll right
            else    -> throw IllegalArgumentException("Unknown scroll direction: $direction")
        }

        // Use root shell input swipe — dispatchGesture callback unreliable on MIUI
        runShellCommand("input swipe $startX $startY $endX $endY $durationMs")
        Log.d(TAG, "scroll: completed via shell ($direction)")
    }

    // ─── Open app ─────────────────────────────────────────────────────────────

    suspend fun openApp(packageName: String) = withContext(Dispatchers.IO) {
        Log.d(TAG, "openApp($packageName)")
        val svc    = requireService()
        val intent = svc.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw IllegalStateException("No launch intent for $packageName — not installed?")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // startActivity can be called from any context with FLAG_ACTIVITY_NEW_TASK
        svc.applicationContext.startActivity(intent)
    }

    /**
     * Open an app fresh — bypasses singleTask activity stack restoration.
     *
     * Problem with openApp(): getLaunchIntentForPackage() + FLAG_ACTIVITY_NEW_TASK
     * is ignored by apps with singleTask launchMode (e.g. Instagram) — they restore
     * the last activity (Reels, Stories, etc.) instead of launching main activity.
     *
     * Solution: `am start --activity-clear-task` via shell clears the entire task
     * stack before launching, guaranteeing main activity is shown fresh.
     *
     * Resolves main activity via PackageManager (same as getLaunchIntentForPackage)
     * to avoid hardcoding activity class names per app version.
     */
    suspend fun openAppFresh(packageName: String) = withContext(Dispatchers.IO) {
        Log.d(TAG, "openAppFresh($packageName)")
        val svc = requireService()

        // Resolve main activity via PackageManager — same source as getLaunchIntentForPackage
        val launchIntent = svc.packageManager.getLaunchIntentForPackage(packageName)
        val mainActivity = launchIntent?.component?.className
            ?: throw IllegalStateException("No launch intent for $packageName — not installed?")

        // force-stop first to kill any foreground singleTask activity (Instagram, TikTok, etc.)
        // then am start --activity-clear-task to ensure main activity starts fresh
        runShellCommand("am force-stop $packageName")
        Thread.sleep(500)
        runShellCommand(
            "am start --activity-clear-task -n $packageName/$mainActivity"
        )
        Log.d(TAG, "openAppFresh: force-stopped + launched $packageName/$mainActivity with clear-task")
    }

    // ─── Close app ────────────────────────────────────────────────────────────

    /**
     * Close an app: navigate home then force-stop via root shell.
     * Uses `am force-stop` via su — no KILL_BACKGROUND_PROCESSES permission needed.
     */
    suspend fun closeApp(packageName: String) = withContext(Dispatchers.IO) {
        Log.d(TAG, "closeApp($packageName)")
        val svc = requireService()
        // Navigate away from app first (on main thread)
        withContext(Dispatchers.Main) {
            svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        }
        // Force-stop via root shell (avoids KILL_BACKGROUND_PROCESSES permission issue)
        runShellCommand("am force-stop $packageName")
        Log.d(TAG, "closeApp: force-stopped $packageName")
    }

    // ─── UI Tree Dump ─────────────────────────────────────────────────────────

    /**
     * Dump the current accessibility node tree as a JSON string.
     * @param packageFilter  Optional — include only nodes from this package.
     *                       Null = dump entire screen.
     * Returns JSON string (not JSONObject) to avoid deep recursion overhead.
     */
    suspend fun uiTreeDump(packageFilter: String? = null): String {
        val svc = requireService()
        val root = getRootInActiveWindowBounded(svc, 2_500L)
        if (root == null) {
            Log.w(TAG, "uiTreeDump: rootInActiveWindow is null")
            return "{\"error\":\"no_root\"}"
        }
        return try {
            // Accessibility traversal performs Binder calls. Keep it off the
            // main thread and make the blocking section interruptible so the
            // workflow/action timeout can actually stop a stalled tree dump.
            val json = runInterruptible(Dispatchers.IO) {
                nodeToJson(root, packageFilter)
            }
            json.toString()
        } finally {
            root.recycle()
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private fun requireService(): AccessibilityService =
        service ?: throw IllegalStateException("AccessibilityService not connected")

    /**
     * rootInActiveWindow is Binder IPC and can ignore coroutine cancellation. Run it
     * on a daemon thread and enforce a wall-clock deadline so a broken framework
     * connection cannot stall the workflow executor.
     */
    private suspend fun getRootInActiveWindowBounded(
        svc: AccessibilityService,
        timeoutMs: Long,
    ): AccessibilityNodeInfo? = withContext(Dispatchers.IO) {
        val latch = CountDownLatch(1)
        val expired = AtomicBoolean(false)
        val result = AtomicReference<AccessibilityNodeInfo?>(null)
        Thread {
            val root = runCatching { svc.rootInActiveWindow }.getOrNull()
            if (expired.get()) root?.recycle() else result.set(root)
            latch.countDown()
        }.also {
            it.name = "PhoneNet-A11yRoot"
            it.isDaemon = true
            it.start()
        }
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            expired.set(true)
            result.getAndSet(null)?.recycle()
            Log.w(TAG, "rootInActiveWindow timed out after ${timeoutMs}ms")
            null
        } else {
            result.getAndSet(null)
        }
    }

    /** Recursively convert AccessibilityNodeInfo to JSONObject */
    /**
     * Recursively convert AccessibilityNodeInfo to JSONObject.
     *
     * All field names use full camelCase for easy parsing by Screen Detection
     * Cascade rule engine (UiTreeDetector). Key fields used by L1 detection:
     *   - `text`               — matched against UiMarker.text rules
     *   - `contentDescription` — matched against UiMarker.contentDescription rules
     *   - `className`          — matched against UiMarker.className rules
     *   - `resourceId`         — matched against UiMarker.resourceId rules
     */
    private fun nodeToJson(node: AccessibilityNodeInfo?, filter: String?): JSONObject {
        val obj = JSONObject()
        if (node == null) return obj
        try {
            val pkg = node.packageName?.toString() ?: ""
            obj.put("packageName",        pkg)
            obj.put("className",          node.className?.toString() ?: "")
            obj.put("resourceId",         node.viewIdResourceName ?: "")
            obj.put("text",               node.text?.toString() ?: "")
            obj.put("contentDescription", node.contentDescription?.toString() ?: "")
            obj.put("checkable",          node.isCheckable)
            obj.put("checked",            node.isChecked)
            obj.put("clickable",          node.isClickable)
            obj.put("editable",           node.isEditable)
            obj.put("enabled",            node.isEnabled)
            obj.put("focused",            node.isFocused)
            obj.put("scrollable",         node.isScrollable)
            obj.put("selected",           node.isSelected)
            obj.put("visible",            node.isVisibleToUser)

            val bounds = android.graphics.Rect()
            node.getBoundsInScreen(bounds)
            obj.put("bounds", JSONObject().apply {
                put("left",   bounds.left)
                put("top",    bounds.top)
                put("right",  bounds.right)
                put("bottom", bounds.bottom)
            })

            val children = JSONArray()
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                try {
                    if (filter == null || child.packageName?.toString() == filter || pkg == filter) {
                        children.put(nodeToJson(child, filter))
                    }
                } finally {
                    child.recycle()
                }
            }
            if (children.length() > 0) obj.put("children", children)
        } catch (e: Exception) {
            obj.put("error", e.message ?: "unknown")
        }
        return obj
    }

    /** Find first focused or editable node in tree (BFS) */
    private fun findFocusedOrEditableNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        root ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isFocused && node.isEditable) return node
            if (node.isEditable) return node
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return null
    }

    // ─── Shell command helper ─────────────────────────────────────────────────

    /**
     * Run a shell command via root (su -c).
     * Blocks until command exits. Throws on non-zero exit or execution error.
     */
    private suspend fun runShellCommand(cmd: String): Boolean {
        Log.d(TAG, "shell: $cmd")
        val result = BoundedProcessRunner.run(arrayOf("su", "-c", cmd), GESTURE_TIMEOUT_MS)
        if (!result.success) {
            Log.w(TAG, "shell failed exit=${result.exitCode} timedOut=${result.timedOut} for: $cmd")
            return false
        }
        return true
    }
}
