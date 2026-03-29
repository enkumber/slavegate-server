package com.phonenetwork.verification

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * L1UiTreeVerifier — zero-cost verification via AccessibilityService UI tree diff.
 *
 * Strategy:
 * 1. Capture UI tree snapshot BEFORE action (called by VerificationCascade)
 * 2. After action: poll for UI tree changes for up to l1TimeoutMs
 * 3. If tree changed meaningfully → verified (confidence 0.9+)
 * 4. If no change in timeout → inconclusive → escalate to L2
 *
 * Covers ~70-80% of verifications (buttons, inputs, navigation, toggles).
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §5.2
 */
class L1UiTreeVerifier(
    private val accessibilityService: AccessibilityService
) {
    companion object {
        private const val TAG            = "PhoneNet/L1"
        private const val POLL_INTERVAL  = 100L   // ms between polls
        private const val MAX_NODES      = 200     // cap traversal — Instagram has 2000+ nodes
    }

    data class UiSnapshot(
        val nodeCount:     Int,
        val textNodes:     Set<String>,  // All text content (for change detection)
        val checkedNodes:  Set<String>,  // Checked/toggled states (like button, checkbox)
        val focusedNode:   String?,      // Focused element resource-id
        val scrollPosition: Int,         // Estimated scroll offset
        val windowTitle:   String?       // Current window/activity title
    )

    // ─── Snapshot ────────────────────────────────────────────────────────────

    /**
     * Capture current UI tree snapshot. Fast (<50ms).
     * Call BEFORE action execution.
     */
    suspend fun captureSnapshot(): UiSnapshot = withContext(Dispatchers.IO) {
        // rootInActiveWindow is a Binder IPC call — can block indefinitely if the
        // window isn't ready. runInterruptible cannot interrupt Binder calls on Android,
        // so we use a daemon thread + CountDownLatch with a hard wall-clock timeout.
        val latch = CountDownLatch(1)
        var root: AccessibilityNodeInfo? = null
        Thread {
            try {
                root = accessibilityService.rootInActiveWindow
            } catch (_: Exception) {
            } finally {
                latch.countDown()
            }
        }.also { it.isDaemon = true; it.start() }

        latch.await(500L, TimeUnit.MILLISECONDS)  // non-blocking for the coroutine dispatcher

        val captured = root
        if (captured != null) buildSnapshot(captured).also { captured.recycle() }
        else UiSnapshot(0, emptySet(), emptySet(), null, 0, null)
    }

    private fun buildSnapshot(root: AccessibilityNodeInfo): UiSnapshot {
        val textNodes     = mutableSetOf<String>()
        val checkedNodes  = mutableSetOf<String>()
        var nodeCount     = 0
        var focusedNode: String? = null
        var scrollOffset  = 0

        // IMPORTANT: AccessibilityNodeInfo obtained via getChild() must be recycled by the
        // caller after use. Failure to recycle causes memory leaks in the A11y framework pool.
        // Convention: `traverse()` does NOT recycle its `node` parameter — caller recycles.
        // Root is recycled in buildSnapshot's `.also { root.recycle() }` call.
        fun traverse(node: AccessibilityNodeInfo) {
            if (nodeCount >= MAX_NODES) return  // hard cap — prevents minutes-long traversal
            nodeCount++
            val text = node.text?.toString()?.trim()
            val desc = node.contentDescription?.toString()?.trim()
            if (!text.isNullOrBlank())  textNodes.add(text)
            if (!desc.isNullOrBlank())  textNodes.add(desc)
            if (node.isChecked) {
                val id = node.viewIdResourceName ?: desc ?: text
                if (id != null) checkedNodes.add(id)
            }
            if (node.isFocused && focusedNode == null) {
                focusedNode = node.viewIdResourceName ?: text
            }
            if (node.isScrollable) {
                scrollOffset = node.extras.getInt("AccessibilityNodeInfo.scrollY", 0)
            }
            for (i in 0 until node.childCount) {
                if (nodeCount >= MAX_NODES) break   // stop iterating siblings too
                val child = node.getChild(i) ?: continue
                try {
                    traverse(child)
                } finally {
                    child.recycle()
                }
            }
        }

        traverse(root)
        return UiSnapshot(
            nodeCount      = nodeCount,
            textNodes      = textNodes,
            checkedNodes   = checkedNodes,
            focusedNode    = focusedNode,
            scrollPosition = scrollOffset,
            windowTitle    = root.packageName?.toString()
        )
    }

    // ─── Verification ─────────────────────────────────────────────────────────

    /**
     * Verify action by comparing UI tree before and after.
     * Polls until change detected or timeout.
     *
     * @param before        Snapshot taken BEFORE action
     * @param l1TimeoutMs   Max time to wait for change (from JOB_DISPATCH)
     * @return VerificationResult with L1 outcome
     */
    suspend fun verify(
        before: UiSnapshot,
        l1TimeoutMs: Long = 2000L
    ): VerificationResult {
        val startTime = System.currentTimeMillis()

        val result = withTimeoutOrNull(l1TimeoutMs) {
            while (true) {
                delay(POLL_INTERVAL)
                val after = captureSnapshot()
                val change = detectChange(before, after)
                if (change != null) {
                    val elapsed = System.currentTimeMillis() - startTime
                    Log.d(TAG, "L1 confirmed: $change in ${elapsed}ms")
                    return@withTimeoutOrNull VerificationResult(
                        verified           = change.isPositive,
                        verifiedBy         = VerifiedBy.UI_TREE,
                        cascadeLevelsUsed  = 1,
                        confidence         = change.confidence,
                        llmTokensUsed      = 0,
                        verificationTimeMs = elapsed,
                        note               = change.description
                    )
                }
            }
            @Suppress("UNREACHABLE_CODE")
            null
        }

        // Timeout — inconclusive → L1 did not confirm
        val elapsed = System.currentTimeMillis() - startTime
        Log.d(TAG, "L1 inconclusive after ${elapsed}ms — escalate to L2")
        return VerificationResult(
            verified           = false,
            verifiedBy         = VerifiedBy.NONE,
            cascadeLevelsUsed  = 1,
            confidence         = 0f,
            llmTokensUsed      = 0,
            verificationTimeMs = elapsed,
            note               = "L1 timeout — no UI change detected"
        )
    }

    // ─── Change detection ──────────────────────────────────────────────────

    data class UiChange(
        val isPositive:  Boolean,
        val confidence:  Float,
        val description: String
    )

    private fun detectChange(before: UiSnapshot, after: UiSnapshot): UiChange? {
        // 1. Checked state toggle (like button, checkbox, follow toggle)
        val newChecked  = after.checkedNodes  - before.checkedNodes
        val newUnchecked = before.checkedNodes - after.checkedNodes
        if (newChecked.isNotEmpty()) {
            return UiChange(true,  0.95f, "Node toggled ON: ${newChecked.first()}")
        }
        if (newUnchecked.isNotEmpty()) {
            return UiChange(true,  0.90f, "Node toggled OFF: ${newUnchecked.first()}")
        }

        // 2. New text appeared (post comment succeeded, username visible on profile)
        val newText = after.textNodes - before.textNodes
        if (newText.size >= 2) {  // Threshold: at least 2 new text nodes (avoids noise)
            return UiChange(true, 0.85f, "New text nodes: ${newText.take(3)}")
        }

        // 3. Text disappeared (input cleared after submit)
        val goneText = before.textNodes - after.textNodes
        if (goneText.size >= 2) {
            return UiChange(true, 0.80f, "Text cleared: ${goneText.take(3)}")
        }

        // 4. Node count significantly changed (window/activity transition)
        val nodeCountDelta = Math.abs(after.nodeCount - before.nodeCount)
        if (nodeCountDelta > before.nodeCount * 0.3 && nodeCountDelta > 10) {
            return UiChange(true, 0.88f, "Node count changed by $nodeCountDelta (screen transition)")
        }

        // 5. Scroll position changed (scroll action confirmed)
        if (Math.abs(after.scrollPosition - before.scrollPosition) > 50) {
            return UiChange(true, 0.92f, "Scroll position changed")
        }

        // 6. Window/package changed (app navigation)
        if (after.windowTitle != before.windowTitle && after.windowTitle != null) {
            return UiChange(true, 0.93f, "Window changed to: ${after.windowTitle}")
        }

        return null  // No meaningful change detected
    }
}
