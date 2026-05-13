package com.phonenetwork.workflow

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.capture.CaptureController
import com.phonenetwork.executor.JobExecutor
import com.phonenetwork.utils.ScreenMetrics
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.*
import kotlin.math.roundToInt
import kotlin.math.min

/**
 * WorkflowEngine — edge execution engine for workflow templates.
 *
 * Receives a complete workflow template JSON, executes all steps locally on device.
 * Zero server contact for local actions (tap, swipe, type, scroll, wait, etc.).
 * Only contacts server for LLM/VLM calls (analyze post, generate comment).
 *
 * Architecture (ADR-001):
 *   - Reuses existing JobExecutor for atomic device operations
 *   - Reuses existing BatchExecutor's action implementations (via JobExecutor)
 *   - Adds control flow: conditions, loops, variables, checkpoints
 *   - HBE timing runs locally (no network latency between actions)
 *
 * Lifecycle:
 *   1. DirectWsClient receives WORKFLOW_START message
 *   2. DirectWsClient calls workflowEngine.executeWorkflow(template)
 *   3. Engine parses steps, executes sequentially
 *   4. Sends WORKFLOW_STATUS updates to server via WebSocket
 *   5. On completion/failure: final status + variables
 *
 * Thread safety: only one workflow runs at a time (enforced by running semaphore).
 *
 * Checkpoint: persisted to SharedPreferences after each step.
 * On device crash/restart, engine resumes from last checkpoint.
 */
class WorkflowEngine(
    private val context: Context,
    private val automation: AutomationController,
    private val capture: CaptureController,
    private val jobExecutor: JobExecutor,
    private val sendStatus: (JSONObject) -> Unit,
    private val requestLLM: suspend (prompt: String, screenshot: String?, model: String) -> String,
) {
    companion object {
        private const val TAG = "WorkflowEngine"
        private const val PREFS_NAME = "workflow_checkpoints"
        private const val MAX_VARIABLES_SIZE = 100_000  // 100KB limit
        private const val MAX_NESTED_DEPTH = 10
        private const val STEP_TIMEOUT_MS = 30_000L
    }

    /** Local template cache for OTA updates */
    private val templateStore = TemplateStore(context)

    // ─── State ────────────────────────────────────────────────────────────────

    private val running = Semaphore(1)
    private var currentScope: CoroutineScope? = null

    private val variables = mutableMapOf<String, Any>()
    private var currentStepIndex = 0
    private var totalSteps = 0
    private var workflowId = ""

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Execute a workflow template.
     *
     * @param templateJson Complete workflow template JSON (from WORKFLOW_START message)
     * @param resumeCheckpoint If non-null, resume from this checkpoint
     */
    suspend fun executeWorkflow(
        templateJson: JSONObject,
        resumeCheckpoint: WorkflowCheckpoint? = null,
    ) {
        if (!running.tryAcquire()) {
            Log.w(TAG, "Workflow already running — rejecting")
            return
        }

        currentScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        try {
            executeWorkflowInternal(templateJson, resumeCheckpoint)
        } catch (e: CancellationException) {
            Log.w(TAG, "Workflow cancelled: ${e.message}")
            sendStatusUpdate("cancelled", error = e.message)
        } catch (e: Exception) {
            Log.e(TAG, "Workflow failed: ${e.message}", e)
            sendStatusUpdate("failed", error = e.message)
        } finally {
            running.release()
            currentScope = null
        }
    }

    /**
     * Cancel the currently running workflow.
     */
    fun cancel() {
        Log.w(TAG, "Workflow cancellation requested")
        currentScope?.cancel()
    }

    /**
     * Check if a workflow is currently running.
     */
    fun isRunning(): Boolean = running.availablePermits == 0

    /**
     * Load last checkpoint for a workflow (for resume on restart).
     */
    fun loadCheckpoint(workflowId: String): WorkflowCheckpoint? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val json = prefs.getString("checkpoint_$workflowId", null) ?: return null
        return try {
            val obj = JSONObject(json)
            WorkflowCheckpoint(
                workflowId = obj.getString("workflowId"),
                stepIndex = obj.getInt("stepIndex"),
                variables = parseVariablesMap(obj.getJSONObject("variables")),
                phase = obj.optString("phase", null),
                timestamp = obj.optLong("timestamp", 0),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse checkpoint: ${e.message}")
            null
        }
    }

    // ─── Internal execution ───────────────────────────────────────────────────

    private suspend fun executeWorkflowInternal(
        templateJson: JSONObject,
        resumeCheckpoint: WorkflowCheckpoint?,
    ) {
        workflowId = templateJson.optString("id", "unknown")
        val stepsArray = templateJson.optJSONArray("steps") ?: JSONArray()
        val steps = WorkflowStepParser.parseSteps(stepsArray)
        totalSteps = steps.size

        // Auto-save template to local cache (OTA)
        templateStore.saveTemplate(templateJson)

        // Initialize or restore variables
        if (resumeCheckpoint != null) {
            variables.putAll(resumeCheckpoint.variables)
            currentStepIndex = resumeCheckpoint.stepIndex
            Log.i(TAG, "Resuming workflow $workflowId from step $currentStepIndex")
        } else {
            currentStepIndex = 0
            variables.clear()
            Log.i(TAG, "Starting workflow $workflowId: $totalSteps steps")
        }

        sendStatusUpdate("running")

        // Initialize HBE engine from template variables
        val accountAgeDays = (variables["accountAgeDays"] as? Number)?.toInt() ?: 30
        val timezone = variables["timezone"] as? String ?: "Europe/Bucharest"
        val hbe = HbeEngine(accountAgeDays, timezone)

        // Execute steps starting from currentStepIndex
        for (i in currentStepIndex until steps.size) {
            ensureActive()

            currentStepIndex = i
            val step = steps[i]

            Log.i(TAG, "Step $i/${steps.size}: type=${step.type} id=${step.id}")

            try {
                executeStep(step, steps, i, hbe)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Step $i failed: ${e.message}")
                saveCheckpoint(workflowId, i, "step_failed")
                sendStatusUpdate("failed", error = "Step $i (${step.id}) failed: ${e.message}")
                return
            }

            // Save checkpoint after each step
            saveCheckpoint(workflowId, i + 1, null)

            // Send progress update
            sendStatusUpdate("running", stepIndex = i + 1)
        }

        // Workflow completed successfully
        clearCheckpoint(workflowId)
        sendStatusUpdate("completed", stepIndex = totalSteps)
        Log.i(TAG, "Workflow $workflowId completed successfully")
    }

    // ─── Step dispatch ─────────────────────────────────────────────────────────

    private suspend fun executeStep(
        step: WorkflowStep,
        allSteps: List<WorkflowStep>,
        stepIndex: Int,
        hbe: HbeEngine,
        depth: Int = 0,
    ) {
        if (depth > MAX_NESTED_DEPTH) {
            throw IllegalStateException("Max nesting depth ($MAX_NESTED_DEPTH) exceeded")
        }

        when (step) {
            is WorkflowStep.Action -> executeActionStep(step, hbe)
            is WorkflowStep.Wait -> executeWaitStep(step, hbe)
            is WorkflowStep.Condition -> executeConditionStep(step, allSteps, stepIndex, hbe, depth)
            is WorkflowStep.Loop -> executeLoopStep(step, hbe, depth)
            is WorkflowStep.Checkpoint -> {
                saveCheckpoint(workflowId, stepIndex, step.phase)
                Log.i(TAG, "Checkpoint saved: phase=${step.phase}")
            }
        }
    }

    // ─── Action execution ──────────────────────────────────────────────────────

    private suspend fun executeActionStep(step: WorkflowStep.Action, hbe: HbeEngine) {
        val action = step.action

        when {
            // ── Local device actions (delegate to JobExecutor) ──
            action in listOf("tap", "swipe", "scroll", "press_back", "press_home",
                "press_recent", "open_app", "close_app", "long_press", "double_tap",
                "screen_wake", "unlock", "keyevent", "screenshot", "ui_tree_dump") -> {

                // HBE pre-action delay
                val preDelay = hbe.getPreActionDelay(mapActionToHbeType(action))
                if (preDelay > 0) delay(preDelay)

                // Execute via JobExecutor
                executeDeviceAction(action, step.params, step.timeoutMs)

                // HBE post-action delay
                val postDelay = hbe.getPostActionDelay(mapActionToHbeType(action))
                if (postDelay > 0) delay(postDelay)
            }

            // ── Variable operations (pure local) ──
            action == "set_variable" -> handleSetVariable(step)
            action == "increment" -> handleIncrement(step)
            action == "decrement" -> handleDecrement(step)
            action == "reset_counter" -> handleResetCounter(step)
            action == "append_to_list" -> handleAppendToList(step)
            action == "mark_processed" -> handleMarkProcessed(step)

            // ── Control flow helpers (pure local) ──
            action == "random_delay" -> {
                val min = (step.params.opt("min") as? Number)?.toLong() ?: 500L
                val max = (step.params.opt("max") as? Number)?.toLong() ?: 2000L
                delay(hbe.resolveDuration(DurationSpec(min, max)))
            }
            action == "branch_on_decision" -> handleBranchOnDecision(step)
            action == "conditional_pause" -> handleConditionalPause(step)
            action == "forced_pause" -> {
                val min = (step.params.opt("min") as? Number)?.toLong() ?: 5000L
                val max = (step.params.opt("max") as? Number)?.toLong() ?: 15000L
                delay(hbe.resolveDuration(DurationSpec(min, max)))
            }

            // ── LLM operations (server callback) ──
            action == "vlm_analyze_post_for_outreach" -> handleVlmAnalyze(step)
            action == "vlm_generate_comment" -> handleVlmGenerateComment(step)
            action == "detect_current_screen" -> handleDetectScreen(step)

            // ── Loop/iteration actions ──
            action == "run_loop" -> handleRunLoop(step, hbe)
            action == "for_each" -> handleForEach(step, hbe)

            // ── Navigation actions ──
            action == "cascade_tap" -> handleCascadeTap(step, hbe)
            action == "ensure_on_screen" -> handleEnsureOnScreen(step, hbe)

            else -> {
                Log.w(TAG, "Unknown action: $action — skipping")
            }
        }
    }

    // ─── Device action (delegates to JobExecutor) ──────────────────────────────

    private suspend fun executeDeviceAction(action: String, params: JSONObject, timeoutMs: Long) {
        withTimeoutOrNull(timeoutMs) {
            val jobPayload = JSONObject().apply {
                put("jobId", "wf-local-${System.currentTimeMillis()}")
                put("type", action)
                put("params", params)
            }

            jobExecutor.execute(jobPayload) { result ->
                val status = result.optString("status")
                if (status != "completed") {
                    val error = result.optString("error", "Unknown error")
                    Log.w(TAG, "Device action $action result: $status error=$error")
                }
            }
        } ?: throw Exception("Action $action timed out after ${timeoutMs}ms")
    }

    // ─── Wait step ─────────────────────────────────────────────────────────────

    private suspend fun executeWaitStep(step: WorkflowStep.Wait, hbe: HbeEngine) {
        val durationMs = hbe.resolveDuration(step.duration)
        Log.d(TAG, "Wait: ${durationMs}ms (${step.duration.distribution})")
        delay(durationMs)
    }

    // ─── Condition step ────────────────────────────────────────────────────────

    private suspend fun executeConditionStep(
        step: WorkflowStep.Condition,
        allSteps: List<WorkflowStep>,
        stepIndex: Int,
        hbe: HbeEngine,
        depth: Int,
    ) {
        val result = evaluateCondition(step)
        Log.d(TAG, "Condition ${step.check}: $result")

        val branch = if (result) step.thenSteps else step.elseSteps
        for ((i, subStep) in branch.withIndex()) {
            ensureActive()
            executeStep(subStep, allSteps, stepIndex, hbe, depth + 1)
        }
    }

    private fun evaluateCondition(step: WorkflowStep.Condition): Boolean {
        return when (step.check) {
            "random_probability" -> Math.random() < step.probability
            "variable_equals" -> {
                val varName = step.id  // simplified; real impl would parse from params
                val expected = variables[varName]
                expected == true || (expected as? Number)?.toInt() == 1
            }
            else -> {
                Log.w(TAG, "Unknown condition check: ${step.check} — defaulting to true")
                true
            }
        }
    }

    // ─── Loop step ─────────────────────────────────────────────────────────────

    private suspend fun executeLoopStep(
        step: WorkflowStep.Loop,
        hbe: HbeEngine,
        depth: Int,
    ) {
        val count = hbe.resolveCount(step.count)
        Log.d(TAG, "Loop: $count iterations (min=${step.count.min}, max=${step.count.max})")

        for (i in 0 until count) {
            ensureActive()
            variables["_loop_iteration"] = i
            for (subStep in step.steps) {
                executeStep(subStep, emptyList(), -1, hbe, depth + 1)
            }
        }
    }

    // ─── Variable operations ───────────────────────────────────────────────────

    private fun handleSetVariable(step: WorkflowStep.Action) {
        val varsObj = step.params.optJSONObject("variables") ?: return
        val keys = varsObj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            variables[key] = varsObj.get(key)
        }
        // Log.d(TAG, "Set variables: ${variables.keys().toList().takeLast(3)}")
        Log.d(TAG, "Set variables done")
    }

    private fun handleIncrement(step: WorkflowStep.Action) {
        val counter = step.params.optString("counter", "counter")
        val by = (step.params.opt("by") as? Number)?.toInt() ?: 1
        val current = (variables[counter] as? Number)?.toInt() ?: 0
        variables[counter] = current + by
    }

    private fun handleDecrement(step: WorkflowStep.Action) {
        val counter = step.params.optString("counter", "counter")
        val by = (step.params.opt("by") as? Number)?.toInt() ?: 1
        val current = (variables[counter] as? Number)?.toInt() ?: 0
        variables[counter] = current - by
    }

    private fun handleResetCounter(step: WorkflowStep.Action) {
        val counter = step.params.optString("counter", "counter")
        variables[counter] = 0
    }

    private fun handleAppendToList(step: WorkflowStep.Action) {
        val listKey = step.params.optString("list", "_list")
        val value = step.params.opt("value") ?: return
        @Suppress("UNCHECKED_CAST")
        val list = (variables[listKey] as? MutableList<Any>) ?: mutableListOf()
        list.add(value)
        variables[listKey] = list
    }

    private fun handleMarkProcessed(step: WorkflowStep.Action) {
        val item = step.params.opt("item") ?: variables["_current_item"] ?: return
        val setKey = step.params.optString("set", "_processed")
        @Suppress("UNCHECKED_CAST")
        val set = (variables[setKey] as? MutableSet<Any>) ?: mutableSetOf()
        set.add(item)
        variables[setKey] = set
    }

    // ─── Control flow actions ──────────────────────────────────────────────────

    private suspend fun handleRunLoop(step: WorkflowStep.Action, hbe: HbeEngine) {
        val maxIterations = (step.params.opt("maxIterations") as? Number)?.toInt() ?: 100
        val exitConditions = (step.params.opt("exitConditions") as? JSONArray)
            ?.let { arr -> (0 until arr.length()).map { arr.getString(it) } }
            ?: emptyList()

        val bodyStepsJson = step.params.optJSONArray("steps") ?: JSONArray()
        val bodySteps = WorkflowStepParser.parseSteps(bodyStepsJson)

        for (iter in 0 until maxIterations) {
            // Check exit conditions
            for (cond in exitConditions) {
                if (evalConditionExpr(cond)) {
                    Log.i(TAG, "run_loop: exit '$cond' at iteration $iter")
                    return
                }
            }

            // Execute body
            for (subStep in bodySteps) {
                ensureActive()
                executeStep(subStep, emptyList(), -1, hbe, 1)
            }

            variables["_loop_iteration"] = iter + 1
        }

        variables["stopped_reason"] = "max_iterations"
    }

    private suspend fun handleForEach(step: WorkflowStep.Action, hbe: HbeEngine) {
        val sourceKey = step.params.optString("source", "")
        val skipKey = step.params.optString("skip_if_in", "")

        @Suppress("UNCHECKED_CAST")
        val items = (variables[sourceKey] as? List<Any>) ?: emptyList()
        if (items.isEmpty()) {
            Log.d(TAG, "for_each: source '$sourceKey' empty — no-op")
            return
        }

        @Suppress("UNCHECKED_CAST")
        val processed = (variables[skipKey] as? Set<Any>) ?: emptySet()

        val bodyStepsJson = step.params.optJSONArray("steps") ?: JSONArray()
        val bodySteps = WorkflowStepParser.parseSteps(bodyStepsJson)

        for (item in items) {
            if (item in processed) continue
            ensureActive()

            variables["_current_item"] = item
            for (subStep in bodySteps) {
                executeStep(subStep, emptyList(), -1, hbe, 1)
            }

            // Mark as processed
            @Suppress("UNCHECKED_CAST")
            val processedSet = (variables[skipKey] as? MutableSet<Any>) ?: mutableSetOf()
            processedSet.add(item)
            variables[skipKey] = processedSet
        }
    }

    private fun handleBranchOnDecision(step: WorkflowStep.Action) {
        val decisionVar = step.params.optString("decisionVariable", "_decision")
        val decision = variables[decisionVar] as? String ?: "default"
        // In full impl, this would route to different step sets based on decision
        Log.d(TAG, "Branch on decision: $decision")
    }

    private fun handleConditionalPause(step: WorkflowStep.Action) {
        val condition = step.params.optString("condition", "")
        if (evalConditionExpr(condition)) {
            variables["_paused"] = true
            Log.i(TAG, "Conditional pause triggered: $condition")
        }
    }

    // ─── LLM operations ────────────────────────────────────────────────────────

    private suspend fun handleVlmAnalyze(step: WorkflowStep.Action) {
        val prompt = step.params.optString("prompt", "Analyze this screenshot")
        val targetVar = step.params.optString("targetVariable", "_post_analysis")

        // Take screenshot
        val screenshotResult = capture.takeScreenshotForVlmJson()
        val screenshotBase64 = screenshotResult.optString("image_base64", "")

        // Request LLM analysis from server
        val result = requestLLM(prompt, screenshotBase64, "gemma4")
        variables[targetVar] = result
        Log.i(TAG, "VLM analysis complete: ${result.take(100)}...")

        // Track VLM usage
        val prev = (variables["vlm_calls_this_run"] as? Number)?.toInt() ?: 0
        variables["vlm_calls_this_run"] = prev + 1
    }

    private suspend fun handleVlmGenerateComment(step: WorkflowStep.Action) {
        val descVar = step.params.optString("post_description_var", "_post_description")
        val targetVar = step.params.optString("target_variable", "_generated_comment")

        val postDesc = variables[descVar] as? String ?: ""
        val prompt = "Generate a natural comment for this post: $postDesc"

        val result = requestLLM(prompt, null, "gemma4")
        variables[targetVar] = result
        Log.i(TAG, "Comment generated: ${result.take(80)}...")

        val prev = (variables["vlm_calls_this_run"] as? Number)?.toInt() ?: 0
        variables["vlm_calls_this_run"] = prev + 1
    }

    private suspend fun handleDetectScreen(step: WorkflowStep.Action) {
        val targetVar = step.params.optString("targetVariable", "_current_screen")
        // Use local UI tree dump (no LLM needed for screen detection)
        val uiTree = automation.uiTreeDump(null)
        variables[targetVar] = uiTree
    }

    // ─── Navigation actions ────────────────────────────────────────────────────

    private suspend fun handleCascadeTap(step: WorkflowStep.Action, hbe: HbeEngine) {
        val elementName = step.params.optString("element", "")
        val verify = step.params.optString("verify", "")

        // Try local cascade: accessibility tap → OCR → VLM fallback
        // For Phase 1, delegate to device-level cascade
        val preDelay = hbe.getPreActionDelay("tap")
        if (preDelay > 0) delay(preDelay)

        // For now, use tap with coords if available
        if (step.x != null && step.y != null) {
            executeDeviceAction("tap", step.params, STEP_TIMEOUT_MS)
        } else {
            Log.w(TAG, "cascade_tap without coords: element=$elementName — needs VLM fallback")
        }

        val postDelay = hbe.getPostActionDelay("tap")
        if (postDelay > 0) delay(postDelay)
    }

    private suspend fun handleEnsureOnScreen(step: WorkflowStep.Action, hbe: HbeEngine) {
        // Check if element is visible via UI tree, if not scroll
        // Simplified for Phase 1
        Log.d(TAG, "ensure_on_screen: ${step.params}")
    }

    // ─── Condition expression evaluator ─────────────────────────────────────────

    /**
     * Evaluate a condition expression against current variables.
     * Supports: "variable == value", "variable > 5", "variable != 0", etc.
     */
    private fun evalConditionExpr(expr: String): Boolean {
        val trimmed = expr.trim()

        // Simple variable reference (truthy check)
        if (!trimmed.contains(" ") && trimmed !in listOf("==", "!=", ">", "<", ">=", "<=")) {
            val value = variables[trimmed]
            return when (value) {
                is Boolean -> value
                is Number -> value.toInt() != 0
                is String -> value.isNotBlank()
                null -> false
                else -> true
            }
        }

        // Comparison operators
        val operators = listOf("!=", "<=", ">=", "==", ">", "<")
        for (op in operators) {
            val parts = trimmed.split(" $op ", limit = 2)
            if (parts.size == 2) {
                val left = resolveVarValue(parts[0].trim())
                val right = resolveVarValue(parts[1].trim())
                return compareValues(left, right, op)
            }
        }

        return false
    }

    private fun resolveVarValue(expr: String): Any? {
        // If it's a variable name, resolve it
        return if (expr.startsWith("$")) {
            variables[expr.removePrefix("$")]
        } else if (expr.startsWith("\"") && expr.endsWith("\"")) {
            expr.removeSurrounding("\"")
        } else {
            variables[expr] ?: expr.toIntOrNull() ?: expr.toDoubleOrNull() ?: expr
        }
    }

    private fun compareValues(left: Any?, right: Any?, op: String): Boolean {
        val leftNum = (left as? Number)?.toDouble()
        val rightNum = (right as? Number)?.toDouble()

        if (leftNum != null && rightNum != null) {
            return when (op) {
                "==" -> leftNum == rightNum
                "!=" -> leftNum != rightNum
                ">" -> leftNum > rightNum
                "<" -> leftNum < rightNum
                ">=" -> leftNum >= rightNum
                "<=" -> leftNum <= rightNum
                else -> false
            }
        }

        return when (op) {
            "==" -> left == right
            "!=" -> left != right
            else -> false
        }
    }

    // ─── Checkpoint persistence ─────────────────────────────────────────────────

    private fun saveCheckpoint(workflowId: String, stepIndex: Int, phase: String?) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val checkpoint = JSONObject().apply {
            put("workflowId", workflowId)
            put("stepIndex", stepIndex)
            put("variables", variablesToJSON())
            put("phase", phase ?: JSONObject.NULL)
            put("timestamp", System.currentTimeMillis())
        }
        prefs.edit()
            .putString("checkpoint_$workflowId", checkpoint.toString())
            .apply()
    }

    private fun clearCheckpoint(workflowId: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().remove("checkpoint_$workflowId").apply()
    }

    private fun variablesToJSON(): JSONObject {
        return JSONObject().apply {
            for ((key, value) in variables) {
                when (value) {
                    is Number -> put(key, value)
                    is String -> put(key, value)
                    is Boolean -> put(key, value)
                    is List<*> -> put(key, JSONArray(value))
                    is Set<*> -> put(key, JSONArray(value.toList()))
                    else -> put(key, value.toString())
                }
            }
        }
    }

    private fun parseVariablesMap(json: JSONObject): Map<String, Any> {
        val map = mutableMapOf<String, Any>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = json.get(key)
        }
        return map
    }

    // ─── Status reporting ───────────────────────────────────────────────────────

    private fun sendStatusUpdate(
        status: String,
        stepIndex: Int = currentStepIndex,
        error: String? = null,
    ) {
        val payload = JSONObject().apply {
            put("type", "WORKFLOW_STATUS")
            put("workflowId", workflowId)
            put("status", status)
            put("currentStep", stepIndex)
            put("totalSteps", totalSteps)
            put("variables", variablesToJSON())
            if (error != null) put("error", error)
            put("timestamp", System.currentTimeMillis())
            put("agentVersion", getAgentVersion())
        }

        Log.d(TAG, "Status: $status step=$stepIndex/$totalSteps${error?.let { " err=$it" } ?: ""}")
        sendStatus(payload)
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private fun mapActionToHbeType(action: String): String {
        return when (action) {
            "tap", "cascade_tap" -> "tap"
            "swipe" -> "swipe"
            "type_text" -> "type"
            "scroll" -> "scroll"
            "open_app", "close_app" -> "navigate"
            else -> "tap"
        }
    }

    private fun getAgentVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (e: Exception) { "unknown" }
    }

    private suspend fun ensureActive() {
        // Throws CancellationException if coroutine is cancelled
        yield()
    }
}
