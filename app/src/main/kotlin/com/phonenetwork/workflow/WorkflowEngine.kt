package com.phonenetwork.workflow

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
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
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.*
import kotlin.coroutines.coroutineContext
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
        private const val LOOP_SUBSTEP_TIMEOUT_MS = 180_000L
        private const val VLM_STEP_TIMEOUT_MS = 150_000L
        private val EDGE_V2_ACTIONS = setOf(
            "a11y_find_tap", "classify_ui_tree", "close_app", "double_tap",
            "get_foreground_app", "get_screen_state", "intent_send", "keyevent",
            "long_press", "ocr_find_tap", "open_app", "press_key", "request_llm",
            "screen_off", "screen_wake", "screenshot", "screenshot_for_vlm", "scroll",
            "set_focused_text", "set_variable", "swipe", "tap", "type_text",
            "ui_tree_dump", "unlock", "wait_for_idle",
        )
    }

    /** Local template cache for OTA updates */
    private val templateStore = TemplateStore(context)

    // ─── State ────────────────────────────────────────────────────────────────

    private val running = Semaphore(1)
    @Volatile private var currentScope: CoroutineScope? = null
    @Volatile private var currentJob: Job? = null

    private val variables = mutableMapOf<String, Any>()
    private var currentStepIndex = 0
    private var totalSteps = 0
    @Volatile private var workflowId = ""

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
            val rejectedWorkflowId = templateJson.optString(
                "workflowId",
                templateJson.optString("id", "unknown")
            )
            Log.w(TAG, "Workflow already running — rejecting $rejectedWorkflowId")
            sendStatus(JSONObject().apply {
                put("type", "WORKFLOW_STATUS")
                put("workflowId", rejectedWorkflowId)
                put("status", "failed")
                put("currentStep", 0)
                put("totalSteps", templateJson.optJSONArray("steps")?.length() ?: 0)
                put("error", "Workflow already running on device")
                put("variables", JSONObject())
                put("timestamp", System.currentTimeMillis())
            })
            return
        }

        currentJob = coroutineContext[Job]
        currentScope = CoroutineScope(Dispatchers.IO + SupervisorJob(currentJob))

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
            currentJob = null
            currentScope = null
        }
    }

    /**
     * Cancel the currently running workflow.
     */
    fun cancel() {
        Log.w(TAG, "Workflow cancellation requested")
        currentJob?.cancel(CancellationException("Cancelled by server"))
        currentScope?.cancel(CancellationException("Cancelled by server"))
    }

    /**
     * Cancel the current workflow only if it matches the requested run id.
     * If workflowId is blank, cancel whatever is active.
     */
    fun cancel(workflowId: String?): Boolean {
        val requested = workflowId?.takeIf { it.isNotBlank() }
        if (requested == null || requested == this.workflowId) {
            Log.w(TAG, "Workflow cancellation requested for ${requested ?: "active"}")
            currentJob?.cancel(CancellationException("Cancelled by server"))
            currentScope?.cancel(CancellationException("Cancelled by server"))
            return true
        } else {
            Log.w(TAG, "Ignoring cancel for $requested; active workflow is ${this.workflowId}")
            return false
        }
    }

    /**
     * Check if a workflow is currently running.
     */
    fun isRunning(workflowId: String? = null): Boolean {
        if (running.availablePermits != 0) return false
        val requested = workflowId?.takeIf { it.isNotBlank() } ?: return true
        return requested == this.workflowId
    }

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
        // `id` is the reusable template id. The server injects
        // `workflowId` for the concrete DB run. Status updates must use that
        // run id, otherwise the server cannot persist progress.
        workflowId = templateJson.optString(
            "workflowId",
            templateJson.optString("id", "unknown")
        )

        val runtimeContract = templateJson.optString("runtimeContract", "")
        require(runtimeContract == "edge-workflow/v2") {
            "Workflow must be recompiled for edge-workflow/v2; legacy templates are not executable"
        }

        // Early receipt heartbeat: proves WORKFLOW_START reached the device even
        // if parsing/cache later fails or blocks.
        sendStatus(JSONObject().apply {
            put("type", "WORKFLOW_STATUS")
            put("workflowId", workflowId)
            put("status", "running")
            put("currentStep", 0)
            put("totalSteps", templateJson.optJSONArray("steps")?.length() ?: 0)
            put("variables", JSONObject())
            put("timestamp", System.currentTimeMillis())
            put("agentVersion", getAgentVersion())
            put("phase", "received")
        })

        val stepsArray = templateJson.optJSONArray("steps") ?: JSONArray()
        val steps = WorkflowStepParser.parseSteps(stepsArray)
        totalSteps = steps.size

        // Auto-save template to local cache (OTA)
        try {
            templateStore.saveTemplate(templateJson)
        } catch (e: Exception) {
            Log.w(TAG, "Template cache save failed, continuing: ${e.message}")
        }

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
        var lastError: Exception? = null
        val attempts = step.retries.coerceAtLeast(0) + 1
        for (attempt in 0 until attempts) {
            try {
                withTimeout(step.timeoutMs.coerceAtLeast(1_000L)) {
                    executeActionAttempt(step, hbe)
                }
                if (step.delayAfterMs > 0) delay(step.delayAfterMs)
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastError = e
                if (attempt + 1 < attempts) {
                    if (step.retryDelayMs > 0) delay(step.retryDelayMs)
                    continue
                }
            }
        }

        if (step.onFailureSteps.isNotEmpty()) {
            for (subStep in step.onFailureSteps) {
                ensureActive()
                withTimeout(subStepTimeoutMs(subStep)) {
                    executeStep(subStep, emptyList(), -1, hbe, 1)
                }
            }
        }

        when (step.failureMode) {
            "continue", "run_branch" -> return
            "run_branch_then_retry" -> {
                withTimeout(step.timeoutMs.coerceAtLeast(1_000L)) {
                    executeActionAttempt(step, hbe)
                }
                if (step.delayAfterMs > 0) delay(step.delayAfterMs)
                return
            }
            "abort" -> throw lastError ?: IllegalStateException("Action ${step.action} failed")
            else -> throw IllegalArgumentException("Unknown failureMode: ${step.failureMode}")
        }
    }

    private suspend fun executeActionAttempt(step: WorkflowStep.Action, hbe: HbeEngine) {
        val action = step.action
        require(action in EDGE_V2_ACTIONS) {
            "Action '$action' is not enabled by edge-workflow/v2"
        }

        when {
            // ── Local device actions (delegate to JobExecutor) ──
            action in listOf("tap", "swipe", "scroll", "press_back", "press_home",
                "press_recent", "open_app", "close_app", "long_press", "double_tap",
                "screen_wake", "unlock", "keyevent", "press_key", "screenshot", "screenshot_for_vlm", "ui_tree_dump",
                "a11y_find_tap", "ocr_find_tap", "wait_for_idle", "intent_send", "set_focused_text", "type_text",
                "screen_off", "get_screen_state", "get_foreground_app") -> {
                // Execute via JobExecutor
                val output = executeDeviceAction(action, step.params, step.timeoutMs, step.verification)
                if (action == "screenshot" || action == "screenshot_for_vlm") {
                    recordScreenshotArtifact(output)
                }
                val outputVariable = step.saveOutputAs?.takeIf { it.isNotBlank() }
                    ?: step.params.optString("outputVariable", "").takeIf { it.isNotBlank() }
                outputVariable?.let { variables[it] = output }
            }

            // ── Variable operations (pure local) ──
            action == "set_variable" -> handleSetVariable(step)
            action == "classify_ui_tree" -> handleClassifyUiTree(step)
            action == "request_llm" -> handleRequestLlm(step)
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
            action == "vlm_generate_comment" -> handleLlmGenerateText(step)
            action == "detect_current_screen" -> handleDetectScreen(step)

            // ── Loop/iteration actions ──
            action == "run_loop" -> handleRunLoop(step, hbe)
            action == "for_each" -> handleForEach(step, hbe)

            // ── Navigation actions ──
            action == "cascade_tap" -> handleCascadeTap(step, hbe)
            action == "ensure_on_screen" -> handleEnsureOnScreen(step, hbe)

            else -> {
                throw IllegalArgumentException("Unknown workflow action: $action")
            }
        }
    }

    // ─── Device action (delegates to JobExecutor) ──────────────────────────────

    private suspend fun executeDeviceAction(
        action: String,
        params: JSONObject,
        timeoutMs: Long,
        verificationStrategy: String? = null,
    ): JSONObject {
        return withTimeoutOrNull(timeoutMs) {
            val (jobType, actionParams) = normalizeDeviceAction(action, params)
            val jobId = "wf-local-${System.currentTimeMillis()}"
            val jobPayload = JSONObject().apply {
                put("jobId", jobId)
                put("type", jobType)
                put("params", resolveActionParams(actionParams))
                // Workflow steps already have checkpoint/status reporting. Keep the
                // per-action executor verification lightweight so short local steps
                // like screen_wake do not spend their whole timeout in screenshot/L2.
                put("timeoutMs", timeoutMs)
                put("verificationStrategy", verificationStrategy ?: "local_only")
                put("l1TimeoutMs", 500L)
                put("l2SettleMs", 100L)
            }

            var jobError: String? = null
            var jobOutput = JSONObject()
            jobExecutor.execute(jobPayload) { result ->
                val status = result.optString("status")
                val output = result.optJSONObject("output")
                if (status != "completed") {
                    val error = result.optString("error", "Unknown error")
                    Log.w(TAG, "Device action $action result: $status error=$error")
                    jobError = error
                } else if (jobType in listOf("a11y_find_tap", "ocr_find_tap")) {
                    val found = output?.optBoolean("found", false) ?: false
                    val tapped = output?.optBoolean("tapped", true) ?: true
                    if (!found || !tapped) {
                        jobError = "${jobType} did not find/tap target"
                    }
                }
                if (output != null) jobOutput = output
            }
            if (jobError != null) throw IllegalStateException("Action $action failed: $jobError")
            jobOutput.put("_workflowJobId", jobId)
            jobOutput
        } ?: throw Exception("Action $action timed out after ${timeoutMs}ms")
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun recordScreenshotArtifact(output: JSONObject) {
        val imageBase64 = output.optString("base64", output.optString("image_base64", ""))
        if (imageBase64.isBlank()) {
            throw IllegalStateException("screenshot did not return image bytes")
        }

        val decoded = try {
            Base64.decode(imageBase64, Base64.DEFAULT)
        } catch (_: Exception) {
            ByteArray(0)
        }
        val artifact = JSONObject().apply {
            put("source", "edge_workflow")
            put("jobId", output.optString("_workflowJobId", ""))
            put("capturedAt", System.currentTimeMillis())
            put("hasImage", true)
            put("width", output.optInt("width", 0))
            put("height", output.optInt("height", 0))
            put("format", output.optString("format", "jpeg"))
            put("bytes", decoded.size)
            put("sha256", if (decoded.isNotEmpty()) sha256Hex(decoded) else "")
            // Evidence-only payload. Server materializes this from checkpoint for audit.
            put("imageBase64", imageBase64)
        }
        variables["lastScreenshotArtifact"] = artifact
        Log.i(TAG, "Screenshot artifact recorded: bytes=${decoded.size} sha=${artifact.optString("sha256").take(12)}")
    }

    private fun normalizeDeviceAction(action: String, params: JSONObject): Pair<String, JSONObject> {
        return when (action) {
            "press_back" -> "press_key" to JSONObject().put("key", "back")
            "press_home" -> "press_key" to JSONObject().put("key", "home")
            "press_recent" -> "press_key" to JSONObject().put("key", "recents")
            "keyevent" -> "press_key" to JSONObject().put("key", when (params.optInt("keyCode", 4)) {
                3 -> "home"
                187 -> "recents"
                else -> "back"
            })
            else -> action to params
        }
    }

    private fun resolveActionParams(params: JSONObject): JSONObject {
        val resolved = JSONObject(params.toString())
        if (resolved.has("textFromVariable") && !resolved.has("text")) {
            val varName = resolved.optString("textFromVariable")
            val value = resolvePath(varName)?.toString().orEmpty()
            if (value.isBlank()) throw IllegalStateException("textFromVariable '$varName' resolved empty")
            resolved.put("text", value)
            resolved.remove("textFromVariable")
        }
        return resolved
    }

    // ─── Wait step ─────────────────────────────────────────────────────────────

    private suspend fun executeWaitStep(step: WorkflowStep.Wait, hbe: HbeEngine) {
        step.duration?.let { duration ->
            val durationMs = hbe.resolveDuration(duration)
            Log.d(TAG, "Wait: ${durationMs}ms (${duration.distribution})")
            val deadline = android.os.SystemClock.elapsedRealtime() + durationMs
            sendStatusUpdate("running", stepIndex = currentStepIndex)
            while (true) {
                ensureActive()
                val remaining = deadline - android.os.SystemClock.elapsedRealtime()
                if (remaining <= 0L) break
                delay(min(remaining, 1_000L))
                sendStatusUpdate("running", stepIndex = currentStepIndex)
            }
            return
        }

        val until = step.until ?: throw IllegalArgumentException("Wait step ${step.id} requires duration or until")
        if (until.action.isBlank()) throw IllegalArgumentException("Wait step ${step.id} until.action is required")
        val deadline = System.currentTimeMillis() + until.timeoutMs
        var lastOutput = JSONObject()
        do {
            ensureActive()
            lastOutput = executeDeviceAction(
                until.action,
                until.params,
                min(until.timeoutMs, 30_000L),
                "local_only",
            )
            if (matchesWaitPredicate(lastOutput, until)) return
            delay(until.pollIntervalMs.coerceAtLeast(25L))
        } while (System.currentTimeMillis() < deadline)

        throw IllegalStateException("Wait predicate timed out for ${step.id}; lastOutput=${lastOutput.toString().take(300)}")
    }

    private fun matchesWaitPredicate(output: JSONObject, spec: WaitUntilSpec): Boolean {
        val actual = resolveJsonPath(output, spec.outputPath)
        val expected = spec.expected
        return when (spec.operator) {
            "truthy" -> truthy(actual)
            "falsy" -> !truthy(actual)
            "equals" -> compareValues(actual, expected, "==")
            "not_equals" -> compareValues(actual, expected, "!=")
            "contains" -> actual?.toString()?.contains(expected?.toString().orEmpty(), ignoreCase = false) == true
            "contains_ci" -> actual?.toString()?.contains(expected?.toString().orEmpty(), ignoreCase = true) == true
            "not_contains" -> actual?.toString()?.contains(expected?.toString().orEmpty(), ignoreCase = false) != true
            "not_contains_ci" -> actual?.toString()?.contains(expected?.toString().orEmpty(), ignoreCase = true) != true
            "exists" -> actual != null
            "missing" -> actual == null
            else -> throw IllegalArgumentException("Unknown wait predicate operator: ${spec.operator}")
        }
    }

    private fun resolveJsonPath(root: Any?, path: String): Any? {
        if (path.isBlank()) return root
        var current: Any? = root
        for (part in path.removePrefix("$").removePrefix(".").split('.').filter { it.isNotBlank() }) {
            current = when (current) {
                is JSONObject -> current.opt(part).takeUnless { it == JSONObject.NULL }
                is JSONArray -> part.toIntOrNull()?.takeIf { it in 0 until current.length() }?.let { current.opt(it) }
                is Map<*, *> -> current[part]
                else -> null
            }
        }
        return current
    }

    private fun truthy(value: Any?): Boolean = when (value) {
        is Boolean -> value
        is Number -> value.toDouble() != 0.0
        is String -> value.isNotBlank() && !value.equals("false", ignoreCase = true) && value != "0"
        null, JSONObject.NULL -> false
        else -> true
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
        step.expression?.takeIf { it.isNotBlank() }?.let { return evalConditionExpr(it) }
        return when (step.check) {
            "random_probability" -> Math.random() < step.probability
            "variable_equals" -> {
                val varName = step.id  // simplified; real impl would parse from params
                val expected = variables[varName]
                expected == true || (expected as? Number)?.toInt() == 1
            }
            else -> {
                throw IllegalArgumentException("Unknown condition check: ${step.check}")
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
            if (!step.breakWhen.isNullOrBlank() && evalConditionExpr(step.breakWhen)) {
                Log.i(TAG, "Loop ${step.id} breakWhen matched at iteration $i")
                break
            }
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
            variables[key] = resolveTemplateValue(varsObj.get(key))
        }
        // Log.d(TAG, "Set variables: ${variables.keys().toList().takeLast(3)}")
        Log.d(TAG, "Set variables done")
    }

    private suspend fun executeLocalJobForOutput(
        type: String,
        params: JSONObject = JSONObject(),
        timeoutMs: Long = 30_000L,
    ): JSONObject {
        val payload = JSONObject().apply {
            put("jobId", "wf-local-${type}-${System.currentTimeMillis()}")
            put("type", type)
            put("params", params)
            put("timeoutMs", timeoutMs)
            put("verificationStrategy", "local_only")
            put("l1TimeoutMs", 500L)
            put("l2SettleMs", 100L)
        }

        val deferred = CompletableDeferred<JSONObject>()
        jobExecutor.execute(payload) { result ->
            deferred.complete(result)
        }

        val result = withTimeout(timeoutMs + 5_000L) { deferred.await() }
        val status = result.optString("status")
        if (status != "completed") {
            throw IllegalStateException("$type failed: ${result.optString("error", status)}")
        }
        return result.optJSONObject("output") ?: JSONObject()
    }

    /** Generic UI-tree classifier; all app knowledge is supplied by the workflow. */
    private suspend fun handleClassifyUiTree(step: WorkflowStep.Action) {
        val output = executeLocalJobForOutput("ui_tree_dump", JSONObject(), 10_000L)
        val uiTreeText = output.optString("uiTree", output.toString())
        val lower = uiTreeText.lowercase(Locale.US)
        val outputs = step.params.optJSONObject("outputs")
            ?: throw IllegalArgumentException("classify_ui_tree requires params.outputs")
        val keys = outputs.keys()
        while (keys.hasNext()) {
            val variableName = keys.next()
            val rule = outputs.optJSONObject(variableName)
                ?: throw IllegalArgumentException("classify_ui_tree output rule must be an object: $variableName")
            variables[variableName] = evaluateUiTreeRule(rule, uiTreeText, lower)
        }
        step.params.optString("metadataVariable", "").takeIf { it.isNotBlank() }?.let { key ->
            variables[key] = JSONObject().apply {
                put("method", "ui_tree_rules")
                put("uiTreeChars", uiTreeText.length)
            }
        }
        Log.i(TAG, "UI tree rules classified ${outputs.length()} output(s)")
    }

    private fun evaluateUiTreeRule(rule: JSONObject, original: String, lower: String): Any {
        val cases = rule.optJSONArray("cases")
        if (cases != null) {
            for (index in 0 until cases.length()) {
                val candidate = cases.optJSONObject(index) ?: continue
                if (matchesTextRule(candidate, lower)) {
                    return candidate.opt("value").takeUnless { it == null || it == JSONObject.NULL } ?: true
                }
            }
        }

        val regex = rule.optString("regex", "")
        if (regex.isNotBlank()) {
            val match = Regex(regex).find(original)
            val group = rule.optInt("group", 0)
            return match?.groupValues?.getOrNull(group)
                ?: rule.opt("default").takeUnless { it == null || it == JSONObject.NULL }
                ?: ""
        }

        if (rule.has("anyContains") || rule.has("allContains") || rule.has("noneContains")) {
            return if (matchesTextRule(rule, lower)) {
                rule.opt("trueValue").takeUnless { it == null || it == JSONObject.NULL } ?: true
            } else {
                rule.opt("falseValue").takeUnless { it == null || it == JSONObject.NULL }
                    ?: rule.opt("default").takeUnless { it == null || it == JSONObject.NULL }
                    ?: false
            }
        }

        return rule.opt("value").takeUnless { it == null || it == JSONObject.NULL }
            ?: rule.opt("default").takeUnless { it == null || it == JSONObject.NULL }
            ?: ""
    }

    private fun matchesTextRule(rule: JSONObject, lower: String): Boolean {
        fun terms(name: String): List<String> {
            val array = rule.optJSONArray(name) ?: return emptyList()
            return (0 until array.length()).mapNotNull { index ->
                array.optString(index, "").trim().lowercase(Locale.US).takeIf { it.isNotBlank() }
            }
        }
        val any = terms("anyContains")
        val all = terms("allContains")
        val none = terms("noneContains")
        return (any.isEmpty() || any.any(lower::contains)) &&
            (all.isEmpty() || all.all(lower::contains)) &&
            none.none(lower::contains)
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
        val value = step.params.opt("value")
            ?: step.params.optJSONObject("item_from_vars")?.let { varsObj ->
                JSONObject().apply {
                    val keys = varsObj.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        put(key, resolvePath(varsObj.optString(key)).toString())
                    }
                }
            }
            ?: return
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
                sendStatusUpdate("running", stepIndex = currentStepIndex)
                withTimeout(subStepTimeoutMs(subStep)) {
                    executeStep(subStep, emptyList(), -1, hbe, 1)
                }
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

    private suspend fun handleBranchOnDecision(step: WorkflowStep.Action) {
        val condition = step.params.optString("condition", "")
        val branch = if (condition.isNotBlank() && evalConditionExpr(condition)) {
            step.params.optJSONArray("if_true_steps")
        } else {
            step.params.optJSONArray("if_false_steps")
        } ?: JSONArray()

        val branchSteps = WorkflowStepParser.parseSteps(branch)
        Log.d(TAG, "Branch on decision: condition='$condition' steps=${branchSteps.size}")
        for (subStep in branchSteps) {
            ensureActive()
            withTimeout(subStepTimeoutMs(subStep)) {
                executeStep(subStep, emptyList(), -1, HbeEngine(30, "Europe/Bucharest"), 1)
            }
        }
    }

    private fun handleConditionalPause(step: WorkflowStep.Action) {
        val condition = step.params.optString("condition", "")
        if (evalConditionExpr(condition)) {
            variables["_paused"] = true
            Log.i(TAG, "Conditional pause triggered: $condition")
        }
    }

    // ─── LLM operations ────────────────────────────────────────────────────────

    private suspend fun handleRequestLlm(step: WorkflowStep.Action) {
        val rawPrompt = step.params.optString("prompt", "").trim()
        require(rawPrompt.isNotBlank()) { "request_llm requires params.prompt" }
        val prompt = interpolateVariables(rawPrompt)
        val model = step.params.optString("model", "decision_llm").ifBlank { "decision_llm" }
        val responseFormat = step.params.optString("responseFormat", "text")
        val targetVar = step.saveOutputAs?.takeIf { it.isNotBlank() }
            ?: step.params.optString("targetVariable", "_llm_result").ifBlank { "_llm_result" }
        val screenshot = when {
            step.params.optBoolean("captureScreenshot", false) -> {
                val captureResult = withTimeout(20_000L) { capture.takeScreenshotForVlmJson() }
                captureResult.optString("image_base64", "").ifBlank {
                    throw IllegalStateException("request_llm screenshot unavailable")
                }
            }
            step.params.has("screenshotVariable") -> {
                val value = resolvePath(step.params.optString("screenshotVariable"))
                when (value) {
                    is JSONObject -> value.optString("imageBase64", value.optString("image_base64", value.optString("base64", "")))
                    else -> value?.toString().orEmpty()
                }.ifBlank { throw IllegalStateException("request_llm screenshotVariable resolved empty") }
            }
            else -> null
        }

        val raw = requestLLM(prompt, screenshot, model)
        val result: Any = if (responseFormat == "json") {
            val parsed = parseJsonIfPossible(raw)
            if (parsed !is JSONObject && parsed !is JSONArray) {
                throw IllegalStateException("request_llm expected JSON response")
            }
            val requiredKeys = step.params.optJSONArray("requiredKeys") ?: JSONArray()
            if (parsed is JSONObject) {
                for (i in 0 until requiredKeys.length()) {
                    val key = requiredKeys.optString(i)
                    if (key.isNotBlank() && !parsed.has(key)) {
                        throw IllegalStateException("request_llm JSON missing required key: $key")
                    }
                }
            }
            parsed
        } else {
            val maxChars = step.params.optInt("maxChars", 100_000).coerceIn(1, 100_000)
            raw.take(maxChars)
        }
        variables[targetVar] = result
        val counter = (variables["runtime_llm_calls"] as? Number)?.toInt() ?: 0
        variables["runtime_llm_calls"] = counter + 1
    }

    private fun interpolateVariables(template: String): String {
        val pattern = Regex("\\{\\{([a-zA-Z0-9_.-]+)}}")
        return pattern.replace(template) { match ->
            val path = match.groupValues[1]
            resolvePath(path)?.toString()
                ?: throw IllegalStateException("request_llm prompt variable '$path' is missing")
        }
    }

    private suspend fun handleVlmAnalyze(step: WorkflowStep.Action) {
        withTimeout(VLM_STEP_TIMEOUT_MS) {
            val prompt = step.params.optString(
                "prompt",
                step.params.optString("criteria", "Analyze this screenshot and return concise JSON")
            )
            val targetVar = step.params.optString(
                "target_variable",
                step.params.optString("targetVariable", "_post_analysis")
            )

            Log.i(TAG, "VLM analyze: capture screenshot target=$targetVar")
            val screenshotResult = withTimeout(20_000L) { capture.takeScreenshotForVlmJson() }
            val screenshotBase64 = screenshotResult.optString("image_base64", "")
            if (screenshotBase64.isBlank()) {
                throw IllegalStateException("VLM screenshot unavailable: ${screenshotResult.optString("error", "empty")}")
            }

            Log.i(TAG, "VLM analyze: request provider bytes=${screenshotBase64.length}")
            val raw = requestLLM(prompt, screenshotBase64, "gemma4")
            variables[targetVar] = parseJsonIfPossible(raw)
            Log.i(TAG, "VLM analysis complete: ${raw.take(100)}...")

            val prev = (variables["vlm_calls_this_run"] as? Number)?.toInt() ?: 0
            variables["vlm_calls_this_run"] = prev + 1
        }
    }

    private suspend fun handleLlmGenerateText(step: WorkflowStep.Action) {
        val prompt = step.params.optString("prompt", "").trim()
        require(prompt.isNotBlank()) {
            "vlm_generate_comment requires params.prompt; content instructions belong to the workflow payload"
        }
        val targetVar = step.params.optString("target_variable", "_generated_text")
        val maxChars = step.params.optInt("max_chars", 400).coerceIn(1, 100_000)
        val provider = step.params.optString("provider", "gemma4")

        val result = withTimeout(VLM_STEP_TIMEOUT_MS) { requestLLM(prompt, null, provider) }
        variables[targetVar] = cleanGeneratedText(result, maxChars)
        Log.i(TAG, "Text generated: ${result.take(80)}...")

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

        if (trimmed.contains(" && ")) {
            return trimmed.split(" && ").all { evalConditionExpr(it) }
        }
        if (trimmed.contains(" || ")) {
            return trimmed.split(" || ").any { evalConditionExpr(it) }
        }

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
            resolvePath(expr.removePrefix("$"))
        } else if ((expr.startsWith("\"") && expr.endsWith("\"")) || (expr.startsWith("'") && expr.endsWith("'"))) {
            expr.substring(1, expr.length - 1)
        } else {
            when (expr) {
                "true" -> true
                "false" -> false
                "null" -> null
                else -> resolvePath(expr) ?: expr.toIntOrNull() ?: expr.toDoubleOrNull() ?: expr
            }
        }
    }

    private fun resolvePath(path: String): Any? {
        val parts = path.split('.').filter { it.isNotBlank() }
        if (parts.isEmpty()) return null
        var current: Any? = variables[parts.first()]
        for (part in parts.drop(1)) {
            current = when (current) {
                is JSONObject -> current.opt(part).takeUnless { it == JSONObject.NULL }
                is Map<*, *> -> current[part]
                is String -> parseJsonIfPossible(current).let { parsed ->
                    if (parsed is JSONObject) parsed.opt(part).takeUnless { it == JSONObject.NULL } else null
                }
                else -> null
            }
        }
        return current
    }

    private fun parseJsonIfPossible(raw: String): Any {
        val trimmed = unwrapJsonMarkdown(raw)
        return try {
            when {
                trimmed.startsWith("{") -> JSONObject(trimmed)
                trimmed.startsWith("[") -> JSONArray(trimmed)
                else -> raw
            }
        } catch (_: Exception) {
            raw
        }
    }

    private fun unwrapJsonMarkdown(raw: String): String {
        var s = raw.trim()
        if (s.startsWith("```")) {
            s = s.removePrefix("```").trimStart()
            if (s.startsWith("json", ignoreCase = true)) s = s.drop(4).trimStart()
            val end = s.lastIndexOf("```")
            if (end >= 0) s = s.substring(0, end)
        }
        // If the model wrapped prose around JSON, keep the first JSON object/array.
        val objStart = s.indexOf('{')
        val objEnd = s.lastIndexOf('}')
        if (objStart >= 0 && objEnd > objStart) return s.substring(objStart, objEnd + 1).trim()
        val arrStart = s.indexOf('[')
        val arrEnd = s.lastIndexOf(']')
        if (arrStart >= 0 && arrEnd > arrStart) return s.substring(arrStart, arrEnd + 1).trim()
        return s.trim()
    }

    private fun cleanGeneratedText(raw: String, maxChars: Int): String {
        var s = raw.trim()
        if (s.startsWith("```")) s = unwrapJsonMarkdown(s)
        s = s.lines()
            .map { it.trim().removePrefix("-").trim() }
            .firstOrNull { it.isNotBlank() && !it.startsWith("Here", ignoreCase = true) && !it.contains("option", ignoreCase = true) }
            ?: s
        s = s.removeSurrounding("\"").trim()
        if (s.length > maxChars) s = s.take(maxChars).trimEnd().trimEnd('.', ',', ';', ':')
        return s
    }

    private fun resolveTemplateValue(value: Any): Any {
        if (value !is String) return value
        val trimmed = value.trim()
        if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
            return resolvePath(trimmed.removePrefix("{{").removeSuffix("}}").trim()) ?: ""
        }
        return value
    }

    private fun subStepTimeoutMs(step: WorkflowStep): Long {
        return when (step) {
            is WorkflowStep.Action -> maxOf(step.timeoutMs, LOOP_SUBSTEP_TIMEOUT_MS)
            is WorkflowStep.Wait -> maxOf(
                (step.duration?.max ?: step.until?.timeoutMs ?: 10_000L) + 5_000L,
                10_000L,
            )
            else -> LOOP_SUBSTEP_TIMEOUT_MS
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
                    is JSONObject -> put(key, value)
                    is JSONArray -> put(key, value)
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
        // Running checkpoints may be emitted every second during waits. Posting an
        // Android notification for each heartbeat is another Binder IPC and can
        // itself stall the executor. Only terminal states need a local notification.
        if (status != "running") notifyWorkflowStatus(status, stepIndex, error)
        sendStatus(payload)
    }

    private fun notifyWorkflowStatus(status: String, stepIndex: Int, error: String?) {
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val text = if (error != null) {
                "${workflowId.take(8)} $status step=$stepIndex/$totalSteps err=${error.take(60)}"
            } else {
                "${workflowId.take(8)} $status step=$stepIndex/$totalSteps"
            }
            val notification = Notification.Builder(context, "phone_network_agent")
                .setContentTitle("Phone Network Agent — Workflow")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_manage)
                .setShowWhen(true)
                .build()
            nm.notify(1103, notification)
        } catch (e: Exception) {
            Log.w(TAG, "notifyWorkflowStatus failed: ${e.message}")
        }
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
