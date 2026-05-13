package com.phonenetwork.workflow

import org.json.JSONArray
import org.json.JSONObject

/**
 * WorkflowStep — parsed representation of a workflow step from JSON template.
 *
 * Mirrors the server-side WorkflowStep type (see server/src/modules/workflows/types.ts).
 * Each step has a type (action, wait, condition, loop, checkpoint) and type-specific fields.
 *
 * Design: data classes for type safety, companion object for JSON parsing.
 */

// ─── Sealed hierarchy ─────────────────────────────────────────────────────────

sealed class WorkflowStep {
    abstract val id: String
    abstract val type: String

    /** Action step — tap, swipe, type, screen_wake, unlock, etc. */
    data class Action(
        override val id: String,
        val action: String,
        val params: JSONObject,
        val x: Double? = null,
        val y: Double? = null,
        val target: String? = null,
        val verification: String? = null,
        val retries: Int = 0,
        val timeoutMs: Long = 15_000,
    ) : WorkflowStep() {
        override val type = "action"
    }

    /** Wait step — delay with distribution (uniform, normal, lognormal). */
    data class Wait(
        override val id: String,
        val duration: DurationSpec,
    ) : WorkflowStep() {
        override val type = "wait"
    }

    /** Condition step — evaluate and pick a branch. */
    data class Condition(
        override val id: String,
        val check: String,
        val probability: Double = 0.5,
        val thenSteps: List<WorkflowStep> = emptyList(),
        val elseSteps: List<WorkflowStep> = emptyList(),
    ) : WorkflowStep() {
        override val type = "condition"
    }

    /** Loop step — repeat a set of steps N times. */
    data class Loop(
        override val id: String,
        val count: CountSpec,
        val steps: List<WorkflowStep>,
    ) : WorkflowStep() {
        override val type = "loop"
    }

    /** Checkpoint step — persist execution state for resume. */
    data class Checkpoint(
        override val id: String,
        val phase: String? = null,
    ) : WorkflowStep() {
        override val type = "checkpoint"
    }
}

// ─── Duration specification ───────────────────────────────────────────────────

data class DurationSpec(
    val min: Long,
    val max: Long,
    val distribution: String = "uniform",  // uniform, normal, lognormal
    val mean: Double? = null,
)

// ─── Count specification ──────────────────────────────────────────────────────

data class CountSpec(
    val min: Int,
    val max: Int,
    val distribution: String = "uniform",
)

// ─── Checkpoint data ──────────────────────────────────────────────────────────

data class WorkflowCheckpoint(
    val workflowId: String,
    val stepIndex: Int,
    val variables: Map<String, Any>,
    val phase: String? = null,
    val timestamp: Long = System.currentTimeMillis(),
)

// ─── JSON Parsing ─────────────────────────────────────────────────────────────

object WorkflowStepParser {

    /**
     * Parse a JSONArray of steps into a list of WorkflowStep objects.
     */
    fun parseSteps(stepsArray: JSONArray): List<WorkflowStep> {
        val steps = mutableListOf<WorkflowStep>()
        for (i in 0 until stepsArray.length()) {
            val stepJson = stepsArray.getJSONObject(i)
            steps.add(parseStep(stepJson))
        }
        return steps
    }

    /**
     * Parse a single step from JSON.
     */
    fun parseStep(json: JSONObject): WorkflowStep {
        val id = json.optString("id", json.optString("type", ""))
        val type = json.optString("type", "action")

        return when (type) {
            "action" -> parseActionStep(id, json)
            "wait"   -> parseWaitStep(id, json)
            "condition" -> parseConditionStep(id, json)
            "loop"   -> parseLoopStep(id, json)
            "checkpoint" -> WorkflowStep.Checkpoint(
                id = id,
                phase = json.optString("phase", null),
            )
            else -> throw IllegalArgumentException("Unknown step type: $type")
        }
    }

    private fun parseActionStep(id: String, json: JSONObject): WorkflowStep.Action {
        val params = json.optJSONObject("params") ?: JSONObject()
        return WorkflowStep.Action(
            id = id,
            action = json.optString("action", ""),
            params = params,
            x = if (json.has("x")) json.optDouble("x") else if (params.has("x")) params.optDouble("x") else null,
            y = if (json.has("y")) json.optDouble("y") else if (params.has("y")) params.optDouble("y") else null,
            target = json.optString("target", null) ?: params.optString("target", null),
            verification = json.optString("verification", null),
            retries = json.optInt("retries", 0),
            timeoutMs = json.optLong("timeoutMs", 15_000),
        )
    }

    private fun parseWaitStep(id: String, json: JSONObject): WorkflowStep.Wait {
        val dur = json.optJSONObject("duration") ?: JSONObject().apply {
            put("min", 1000)
            put("max", 2000)
        }
        return WorkflowStep.Wait(
            id = id,
            duration = DurationSpec(
                min = dur.optLong("min", 1000),
                max = dur.optLong("max", 2000),
                distribution = dur.optString("distribution", "uniform"),
                mean = if (dur.has("mean")) dur.optDouble("mean") else null,
            ),
        )
    }

    private fun parseConditionStep(id: String, json: JSONObject): WorkflowStep.Condition {
        val thenArray = json.optJSONArray("then") ?: JSONArray()
        val elseArray = json.optJSONArray("else") ?: JSONArray()
        return WorkflowStep.Condition(
            id = id,
            check = json.optString("check", "random_probability"),
            probability = json.optDouble("probability", 0.5),
            thenSteps = parseSteps(thenArray),
            elseSteps = parseSteps(elseArray),
        )
    }

    private fun parseLoopStep(id: String, json: JSONObject): WorkflowStep.Loop {
        val countJson = json.optJSONObject("count") ?: JSONObject().apply {
            put("min", 1)
            put("max", 1)
        }
        val stepsArray = json.optJSONArray("steps") ?: JSONArray()
        return WorkflowStep.Loop(
            id = id,
            count = CountSpec(
                min = countJson.optInt("min", 1),
                max = countJson.optInt("max", 1),
                distribution = countJson.optString("distribution", "uniform"),
            ),
            steps = parseSteps(stepsArray),
        )
    }
}
