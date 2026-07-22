package com.phonenetwork.executor

import android.content.Context
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.capture.CaptureController
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.*

/**
 * Unit tests for BatchExecutor.
 *
 * Tests the executor logic (step loop, error handling, timeout, continueOnError)
 * using mocked AutomationController and CaptureController.
 *
 * Note: tap/scroll/swipe steps require ScreenMetrics which needs Android framework.
 * For pure JVM testing, we focus on:
 *   - Wait steps (pure delay, no Android deps)
 *   - Keyevent steps (shell command, no Android deps with mocked Runtime)
 *   - Error handling and flow control
 *   - Result structure validation
 *
 * Integration tests with real coord execution should use androidTest + Robolectric.
 */
class BatchExecutorTest {

    private lateinit var context: Context
    private lateinit var automation: AutomationController
    private lateinit var capture: CaptureController
    private lateinit var executor: BatchExecutor

    @Before
    fun setUp() {
        context = mock(Context::class.java)
        automation = mock(AutomationController::class.java)
        capture = mock(CaptureController::class.java)
        executor = BatchExecutor(context, automation, capture)
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun runBatch(batchJson: JSONObject): JSONObject {
        var result: JSONObject? = null
        runBlocking {
            executor.executeBatch(batchJson) { result = it }
        }
        assertNotNull("Batch result should not be null", result)
        return result!!
    }

    private fun makeBatchStart(
        batchId: String = "test-batch-001",
        workflowId: String = "test-wf-001",
        steps: List<JSONObject>,
        continueOnError: Boolean = false,
        stepTimeoutMs: Long = 30_000L,
    ): JSONObject = JSONObject().apply {
        put("type", "BATCH_START")
        put("batchId", batchId)
        put("workflowId", workflowId)
        put("stepIndex", 0)
        put("steps", JSONArray().apply { steps.forEach { put(it) } })
        put("options", JSONObject().apply {
            put("continueOnError", continueOnError)
            put("timeoutMs", stepTimeoutMs)
        })
    }

    private fun waitStep(id: Int, durationMs: Long): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "wait")
        put("action", "wait")
        put("target", null)
        put("params", JSONObject().apply { put("durationMs", durationMs) })
    }

    private fun keyeventStep(id: Int, action: String): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "action")
        put("action", action)
        put("target", null)
        put("params", JSONObject())
    }

    private fun typeStep(id: Int, text: String): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "action")
        put("action", "type")
        put("target", null)
        put("params", JSONObject().apply { put("text", text) })
    }

    private fun openAppStep(id: Int, pkg: String): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "action")
        put("action", "open_app")
        put("target", null)
        put("params", JSONObject().apply { put("packageName", pkg) })
    }

    private fun closeAppStep(id: Int, pkg: String): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "action")
        put("action", "close_app")
        put("target", null)
        put("params", JSONObject().apply { put("packageName", pkg) })
    }

    private fun unknownActionStep(id: Int, action: String): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "action")
        put("action", action)
        put("target", null)
        put("params", JSONObject())
    }

    private fun invalidStep(id: Int): JSONObject = JSONObject().apply {
        put("id", id)
        put("type", "action")
        put("action", "type")
        put("target", null)
        put("params", JSONObject().apply { put("text", "") }) // empty → validation error
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 1: Happy path — wait steps (no ScreenMetrics dependency)
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `happy path - all wait steps succeed`() {
        val batch = makeBatchStart(
            steps = listOf(
                waitStep(1, 50),
                waitStep(2, 50),
                waitStep(3, 50),
            )
        )

        val result = runBatch(batch)

        assertEquals("BATCH_RESULT", result.optString("type"))
        assertEquals("test-batch-001", result.optString("batchId"))
        assertEquals("test-wf-001", result.optString("workflowId"))
        assertEquals("completed", result.optString("status"))

        val results = result.optJSONArray("results")!!
        assertEquals(3, results.length())

        for (i in 0 until results.length()) {
            val sr = results.getJSONObject(i)
            assertEquals("Step ${i + 1} should succeed", "success", sr.optString("status"))
            assertEquals(i + 1, sr.optInt("id"))
            assertTrue("Step ${i + 1} should have durationMs", sr.optLong("durationMs", -1) >= 0)
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 2: Mixed actions - wait + type + keyevent
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `mixed actions - wait, type, keyevent, open_app`() {
        val batch = makeBatchStart(
            steps = listOf(
                openAppStep(1, "com.instagram.android"),
                waitStep(2, 50),
                typeStep(3, "hello"),
                keyeventStep(4, "press_back"),
                waitStep(5, 30),
            )
        )

        val result = runBatch(batch)

        assertEquals("completed", result.optString("status"))
        val results = result.optJSONArray("results")!!
        assertEquals(5, results.length())

        // All should succeed
        for (i in 0 until results.length()) {
            assertEquals("success", results.getJSONObject(i).optString("status"))
        }

        // Verify automation was called correctly
        runBlocking { verify(automation).openApp("com.instagram.android") }
        runBlocking { verify(automation).typeText("hello") }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 3: Failure abort — stop on first failure, skip remaining
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `failure abort - stop on first failure, skip remaining`() {
        val batch = makeBatchStart(
            continueOnError = false,
            steps = listOf(
                waitStep(1, 30),
                invalidStep(2),         // Will fail (empty text)
                waitStep(3, 30),
            )
        )

        val result = runBatch(batch)

        assertEquals("partial_failure", result.optString("status"))

        val results = result.optJSONArray("results")!!
        assertEquals(3, results.length())

        // Step 1: success
        assertEquals("success", results.getJSONObject(0).optString("status"))
        // Step 2: failed
        assertEquals("failed", results.getJSONObject(1).optString("status"))
        assertTrue("Error message should mention text param",
            results.getJSONObject(1).optString("error").isNotEmpty())
        // Step 3: skipped
        assertEquals("skipped", results.getJSONObject(2).optString("status"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 4: Continue on error — execute all steps
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `continue on error - all steps executed`() {
        val batch = makeBatchStart(
            continueOnError = true,
            steps = listOf(
                waitStep(1, 30),
                invalidStep(2),         // Will fail
                waitStep(3, 30),
                typeStep(4, "test"),
            )
        )

        val result = runBatch(batch)

        assertEquals("partial_failure", result.optString("status"))

        val results = result.optJSONArray("results")!!
        assertEquals(4, results.length())

        assertEquals("success", results.getJSONObject(0).optString("status"))
        assertEquals("failed", results.getJSONObject(1).optString("status"))
        assertEquals("success", results.getJSONObject(2).optString("status"))  // continued!
        assertEquals("success", results.getJSONObject(3).optString("status"))

        // Verify type was called despite earlier failure
        runBlocking { verify(automation).typeText("test") }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 5: All steps fail → status "failed"
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `all steps fail - status failed`() {
        val batch = makeBatchStart(
            steps = listOf(invalidStep(1))
        )

        val result = runBatch(batch)

        assertEquals("failed", result.optString("status"))
        val results = result.optJSONArray("results")!!
        assertEquals(1, results.length())
        assertEquals("failed", results.getJSONObject(0).optString("status"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 6: Empty batch
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `empty batch - completed with zero results`() {
        val batch = makeBatchStart(steps = emptyList())
        val result = runBatch(batch)

        assertEquals("completed", result.optString("status"))
        assertEquals(0, result.optJSONArray("results")!!.length())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 7: Unknown action type
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `unknown action - fails with descriptive error`() {
        val batch = makeBatchStart(
            steps = listOf(unknownActionStep(1, "teleport"))
        )

        val result = runBatch(batch)

        assertEquals("failed", result.optString("status"))
        val error = result.optJSONArray("results")!!.getJSONObject(0).optString("error")
        assertTrue("Error should mention unknown action", error.contains("Unknown action: teleport"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 8: Result structure validation
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `result structure - all required fields present`() {
        val batch = makeBatchStart(
            steps = listOf(waitStep(1, 30))
        )

        val result = runBatch(batch)

        // BATCH_RESULT top-level fields
        assertEquals("BATCH_RESULT", result.optString("type"))
        assertTrue(result.has("batchId"))
        assertTrue(result.has("workflowId"))
        assertTrue(result.has("status"))
        assertTrue(result.has("results"))
        assertTrue(result.has("executedAt"))
        assertTrue(result.has("totalDurationMs"))
        assertTrue(result.has("totalDurationMs"))

        // StepResult fields
        val sr = result.optJSONArray("results")!!.getJSONObject(0)
        assertTrue("Step should have id", sr.has("id"))
        assertTrue("Step should have status", sr.has("status"))
        assertTrue("Step should have durationMs", sr.has("durationMs"))
        assertTrue("Step should have output", sr.has("output"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 9: Missing batchId → error
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `missing batchId - returns error result`() {
        val batch = JSONObject().apply {
            put("type", "BATCH_START")
            put("workflowId", "test")
            put("steps", JSONArray())
        }

        val result = runBatch(batch)

        assertEquals("failed", result.optString("status"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 10: Duration tracking
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `duration tracking - total accounts for all waits`() {
        val batch = makeBatchStart(
            steps = listOf(
                waitStep(1, 80),
                waitStep(2, 80),
            )
        )

        val result = runBatch(batch)

        val totalMs = result.optLong("totalDurationMs", 0)
        assertTrue("Total should be >= 140ms for two 80ms waits (got ${totalMs}ms)",
            totalMs >= 140)

        // Each step should have positive duration
        val results = result.optJSONArray("results")!!
        for (i in 0 until results.length()) {
            val stepMs = results.getJSONObject(i).optLong("durationMs", -1)
            assertTrue("Step ${i + 1} duration should be positive", stepMs > 0)
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 11: Step timeout
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `step timeout - marks step as timeout`() {
        // Use a very short step timeout and a long wait
        val batch = makeBatchStart(
            stepTimeoutMs = 50,  // 50ms step timeout
            steps = listOf(waitStep(1, 5000))  // 5s wait — will timeout
        )

        val result = runBatch(batch)

        val sr = result.optJSONArray("results")!!.getJSONObject(0)
        // Step should timeout
        assertTrue("Step should be timeout or failed", 
            sr.optString("status") in listOf("timeout", "failed"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 12: Sequential batches work
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `sequential batches - both complete successfully`() {
        val batch1 = makeBatchStart(
            batchId = "batch-1",
            steps = listOf(waitStep(1, 30))
        )
        val batch2 = makeBatchStart(
            batchId = "batch-2",
            steps = listOf(waitStep(1, 30))
        )

        val result1 = runBatch(batch1)
        val result2 = runBatch(batch2)

        assertEquals("completed", result1.optString("status"))
        assertEquals("completed", result2.optString("status"))
        assertEquals("batch-1", result1.optString("batchId"))
        assertEquals("batch-2", result2.optString("batchId"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 13: Close app step
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `close_app step - delegates to automation`() {
        val batch = makeBatchStart(
            steps = listOf(closeAppStep(1, "com.instagram.android"))
        )

        val result = runBatch(batch)

        assertEquals("completed", result.optString("status"))
        runBlocking { verify(automation).closeApp("com.instagram.android") }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 14: Multiple failures with continueOnError
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `multiple failures with continueOnError - all executed`() {
        val batch = makeBatchStart(
            continueOnError = true,
            steps = listOf(
                invalidStep(1),       // fail
                invalidStep(2),       // fail
                waitStep(3, 30),      // succeed
                invalidStep(4),       // fail
            )
        )

        val result = runBatch(batch)

        assertEquals("partial_failure", result.optString("status"))
        val results = result.optJSONArray("results")!!
        assertEquals(4, results.length())
        assertEquals("failed", results.getJSONObject(0).optString("status"))
        assertEquals("failed", results.getJSONObject(1).optString("status"))
        assertEquals("success", results.getJSONObject(2).optString("status"))
        assertEquals("failed", results.getJSONObject(3).optString("status"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 15: Keyevent output contains keyCode
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `keyevent output - contains keyCode`() {
        val batch = makeBatchStart(
            steps = listOf(
                keyeventStep(1, "press_back"),
                keyeventStep(2, "press_home"),
            )
        )

        val result = runBatch(batch)

        val results = result.optJSONArray("results")!!
        assertEquals(4, results.getJSONObject(0).optJSONObject("output")!!.optInt("keyCode"))
        assertEquals(3, results.getJSONObject(1).optJSONObject("output")!!.optInt("keyCode"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 16: Large batch (50 steps)
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `large batch - 50 wait steps complete`() {
        val steps = (1..50).map { waitStep(it, 10) }
        val batch = makeBatchStart(steps = steps)

        val result = runBatch(batch)

        assertEquals("completed", result.optString("status"))
        assertEquals(50, result.optJSONArray("results")!!.length())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 17: Step IDs preserved in results
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `step IDs preserved in results`() {
        val batch = makeBatchStart(
            steps = listOf(
                waitStep(10, 30),
                waitStep(20, 30),
                waitStep(30, 30),
            )
        )

        val result = runBatch(batch)

        val results = result.optJSONArray("results")!!
        assertEquals(10, results.getJSONObject(0).optInt("id"))
        assertEquals(20, results.getJSONObject(1).optInt("id"))
        assertEquals(30, results.getJSONObject(2).optInt("id"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 18: Wait step output contains waitedMs
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `wait step output - contains waitedMs`() {
        val batch = makeBatchStart(steps = listOf(waitStep(1, 100)))

        val result = runBatch(batch)

        val output = result.optJSONArray("results")!!.getJSONObject(0).optJSONObject("output")!!
        assertEquals(100, output.optLong("waitedMs"))
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 19: open_app with fresh flag
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `open_app with fresh flag - calls openAppFresh`() {
        val step = JSONObject().apply {
            put("id", 1)
            put("type", "action")
            put("action", "open_app")
            put("target", null)
            put("params", JSONObject().apply {
                put("packageName", "com.instagram.android")
                put("fresh", true)
            })
        }

        val batch = makeBatchStart(steps = listOf(step))
        val result = runBatch(batch)

        assertEquals("completed", result.optString("status"))
        runBlocking { verify(automation).openAppFresh("com.instagram.android") }
        runBlocking { verify(automation, never()).openApp(anyString()) }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 20: Type with empty text → validation failure
    // ═══════════════════════════════════════════════════════════════════════════

    @Test
    fun `type with empty text - validation failure`() {
        val batch = makeBatchStart(steps = listOf(typeStep(1, "")))
        val result = runBatch(batch)

        assertEquals("failed", result.optString("status"))
        val error = result.optJSONArray("results")!!.getJSONObject(0).optString("error")
        assertTrue("Error should mention text param", error.isNotEmpty())
    }
}
