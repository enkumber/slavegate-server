package com.phonenetwork.workflow

import android.util.Log
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * HbeEngine — Human Behavior Emulation timing engine.
 *
 * Generates realistic delays between actions to avoid detection.
 * Runs entirely on-device — zero server contact for timing decisions.
 *
 * Port of server-side hbe.service.ts to Kotlin.
 * Timing profiles based on:
 *   - Action type (tap, swipe, type, scroll, navigate, wait)
 *   - Account age (warmup = slower, mature = faster)
 *   - Timezone-aware time-of-day (night = slower)
 *   - Mood profile (engaged, casual, explorer, cautious)
 *
 * Usage:
 *   val hbe = HbeEngine(accountAgeDays = 30, timezone = "Europe/Bucharest")
 *   val preDelay = hbe.getPreActionDelay("tap")    // ms before tap
 *   val postDelay = hbe.getPostActionDelay("tap")   // ms after tap
 *   val typingSpeed = hbe.getTypingDelay()           // ms per character
 */

class HbeEngine(
    private val accountAgeDays: Int = 30,
    private val timezone: String = "Europe/Bucharest",
) {
    companion object {
        private const val TAG = "HbeEngine"

        // Timing profiles by action type (base min/max in ms)
        private val ACTION_PROFILES = mapOf(
            "tap"      to TimingProfile(preMin = 50,  preMax = 200,  postMin = 100, postMax = 400),
            "swipe"    to TimingProfile(preMin = 80,  preMax = 250,  postMin = 150, postMax = 500),
            "type"     to TimingProfile(preMin = 100, preMax = 300,  postMin = 50,  postMax = 150),
            "scroll"   to TimingProfile(preMin = 200, preMax = 600,  postMin = 300, postMax = 800),
            "navigate" to TimingProfile(preMin = 300, preMax = 800,  postMin = 500, postMax = 1500),
            "wait"     to TimingProfile(preMin = 0,   preMax = 0,    postMin = 0,   postMax = 0),
        )

        // Typing speed (ms per character) by account age bracket
        private val TYPING_SPEED = mapOf(
            "warmup"  to TypingProfile(minMsPerChar = 80,  maxMsPerChar = 200),
            "growth"  to TypingProfile(minMsPerChar = 50,  maxMsPerChar = 150),
            "mature"  to TypingProfile(minMsPerChar = 30,  maxMsPerChar = 100),
        )

        // Mood profiles affect timing multiplier
        private val MOOD_PROFILES = mapOf(
            "engaged"  to MoodProfile(multiplier = 0.8f, description = "Fast, focused"),
            "casual"   to MoodProfile(multiplier = 1.0f, description = "Normal pace"),
            "explorer" to MoodProfile(multiplier = 1.2f, description = "Slower, browsing"),
            "cautious" to MoodProfile(multiplier = 1.4f, description = "Very slow, careful"),
        )

        // Time-of-day multiplier (hour → multiplier)
        // Night (0-6): 1.5x slower, Morning (6-9): 1.2x, Day (9-18): 1.0x, Evening (18-22): 1.1x, Late (22-24): 1.3x
        private val TOD_MULTIPLIERS = floatArrayOf(
            1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f,  // 0-5 (night)
            1.3f, 1.2f, 1.1f,                       // 6-8 (morning)
            1.0f, 1.0f, 1.0f, 1.0f, 1.0f,           // 9-13 (midday)
            1.0f, 1.0f, 1.0f, 1.0f, 1.0f,           // 14-18 (afternoon)
            1.1f, 1.1f, 1.1f, 1.2f,                  // 18-21 (evening)
            1.3f, 1.4f,                               // 22-23 (late night)
        )
    }

    data class TimingProfile(
        val preMin: Long, val preMax: Long,
        val postMin: Long, val postMax: Long,
    )

    data class TypingProfile(
        val minMsPerChar: Long,
        val maxMsPerChar: Long,
    )

    data class MoodProfile(
        val multiplier: Float,
        val description: String,
    )

    // ─── State ────────────────────────────────────────────────────────────────

    private val phase: String = when {
        accountAgeDays < 14 -> "warmup"
        accountAgeDays < 60 -> "growth"
        else -> "mature"
    }

    private val mood: String = pickMood()

    // Session-level timing multiplier (0.7 to 1.5)
    private val sessionMultiplier: Float

    init {
        val base = MOOD_PROFILES[mood]?.multiplier ?: 1.0f
        // Add ±15% session drift for variety between runs
        val drift = 0.85f + Random.nextFloat() * 0.3f
        sessionMultiplier = base * drift
        Log.i(TAG, "HBE session: phase=$phase mood=$mood multiplier=${"%.2f".format(sessionMultiplier)}")
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Get pre-action delay in ms (delay BEFORE executing the action).
     * Simulates human micro-pause before tapping/swiping.
     */
    fun getPreActionDelay(actionType: String): Long {
        val profile = ACTION_PROFILES[actionType] ?: ACTION_PROFILES["tap"]!!
        return applyMultipliers(profile.preMin, profile.preMax)
    }

    /**
     * Get post-action delay in ms (delay AFTER executing the action).
     * Simulates human reaction time / visual processing.
     */
    fun getPostActionDelay(actionType: String): Long {
        val profile = ACTION_PROFILES[actionType] ?: ACTION_PROFILES["tap"]!!
        return applyMultipliers(profile.postMin, profile.postMax)
    }

    /**
     * Get typing delay per character in ms.
     * Use this for type_text actions — multiply by text length.
     */
    fun getTypingDelay(): Long {
        val profile = TYPING_SPEED[phase] ?: TYPING_SPEED["growth"]!!
        val base = randomBetween(profile.minMsPerChar, profile.maxMsPerChar)
        return (base * sessionMultiplier).toLong()
    }

    /**
     * Get total typing time for a text string, including natural variation.
     * Adds occasional longer pauses (simulating thought/hesitation).
     */
    fun getTypingTime(text: String): Long {
        var total = 0L
        for (char in text) {
            total += getTypingDelay()
            // 5% chance of a longer pause (thinking/deliberation)
            if (Random.nextFloat() < 0.05f) {
                total += randomBetween(200, 600)
            }
            // Punctuation → slightly longer pause
            if (char in ".,!?;:") {
                total += randomBetween(50, 150)
            }
            // Space → shorter pause
            if (char == ' ') {
                total -= randomBetween(10, 30)
            }
        }
        return max(total, text.length.toLong() * 30) // minimum 30ms/char
    }

    /**
     * Get a natural scroll duration (how long the gesture lasts).
     */
    fun getScrollDuration(): Long {
        return applyMultipliers(250, 600)
    }

    /**
     * Get a random "browse" delay — simulates reading content.
     * Longer than action delays, used after opening content.
     */
    fun getBrowseDelay(): Long {
        return applyMultipliers(1500, 5000)
    }

    /**
     * Resolve a DurationSpec (from wait step) with HBE timing.
     */
    fun resolveDuration(duration: DurationSpec): Long {
        val m = sessionMultiplier
        val baseMean = duration.mean ?: ((duration.min + duration.max) / 2.0)
        val adjustedMean = baseMean * m

        val value = when (duration.distribution) {
            "lognormal" -> logNormalSample(adjustedMean, 0.4)
            "normal" -> {
                val stddev = (duration.max - duration.min) / 6.0
                normalSample(adjustedMean, stddev)
            }
            else -> randomBetween(duration.min * m, duration.max * m).toDouble()
        }

        return value.toLong().coerceIn(duration.min, duration.max)
    }

    /**
     * Resolve a CountSpec (from loop step) with natural variation.
     */
    fun resolveCount(count: CountSpec): Int {
        val value = when (count.distribution) {
            "normal" -> {
                val mean = (count.min + count.max) / 2.0
                val stddev = (count.max - count.min) / 6.0
                normalSample(mean, stddev)
            }
            else -> randomBetween(count.min.toLong(), count.max.toLong()).toDouble()
        }
        return value.toInt().coerceIn(count.min, count.max)
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private fun applyMultipliers(min: Long, max: Long): Long {
        val base = randomBetween(min, max)
        val tod = getTimeOfDayMultiplier()
        return (base * sessionMultiplier * tod).toLong()
    }

    private fun getTimeOfDayMultiplier(): Float {
        val calendar = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone(timezone))
        val hour = calendar.get(java.util.Calendar.HOUR_OF_DAY)
        return TOD_MULTIPLIERS.getOrElse(hour) { 1.0f }
    }

    private fun pickMood(): String {
        val roll = Random.nextFloat()
        return when {
            roll < 0.35f -> "engaged"
            roll < 0.60f -> "casual"
            roll < 0.85f -> "explorer"
            else -> "cautious"
        }
    }

    private fun randomBetween(min: Long, max: Long): Long {
        if (min >= max) return min
        return min + Random.nextLong(max - min + 1)
    }

    private fun randomBetween(min: Double, max: Double): Long {
        return (min + Random.nextDouble() * (max - min)).toLong()
    }

    /**
     * Box-Muller transform for normal distribution sampling.
     */
    private fun normalSample(mean: Double, stddev: Double): Double {
        val u1 = Random.nextDouble()
        val u2 = Random.nextDouble()
        val z = kotlin.math.sqrt(-2.0 * kotlin.math.ln(u1)) * kotlin.math.cos(2.0 * Math.PI * u2)
        return mean + z * stddev
    }

    /**
     * Log-normal distribution sampling.
     */
    private fun logNormalSample(mean: Double, sigma: Double): Double {
        val normal = normalSample(kotlin.math.ln(mean), sigma)
        return kotlin.math.exp(normal)
    }
}
