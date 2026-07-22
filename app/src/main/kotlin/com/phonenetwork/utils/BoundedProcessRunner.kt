package com.phonenetwork.utils

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import java.util.concurrent.TimeUnit

/**
 * Executes OS processes with a hard deadline and cancellation propagation.
 *
 * Every process spawned by the agent must use this runner (or an Android API)
 * instead of an unbounded Process.waitFor(). Cancelling the calling coroutine
 * interrupts waitFor and forcibly destroys the child process, so a stuck root
 * command cannot retain the workflow executor forever.
 */
object BoundedProcessRunner {
    data class Result(
        val exitCode: Int?,
        val output: String,
        val timedOut: Boolean,
    ) {
        val success: Boolean get() = !timedOut && exitCode == 0
    }

    fun runBlocking(
        command: Array<String>,
        timeoutMs: Long,
    ): Result {
        require(timeoutMs > 0L) { "Process timeout must be positive" }
        val process = ProcessBuilder(*command)
            .redirectErrorStream(true)
            .start()
        try {
            val completed = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
            if (!completed) {
                terminate(process)
                return Result(null, "process timed out after ${timeoutMs}ms", true)
            }
            val output = process.inputStream.bufferedReader().use { it.readText().trim() }
            return Result(process.exitValue(), output, false)
        } catch (interrupted: InterruptedException) {
            terminate(process)
            Thread.currentThread().interrupt()
            throw interrupted
        } finally {
            if (process.isAlive) terminate(process)
        }
    }

    suspend fun run(
        command: Array<String>,
        timeoutMs: Long,
    ): Result = runInterruptible(Dispatchers.IO) {
        runBlocking(command, timeoutMs)
    }

    private fun terminate(process: Process) {
        process.destroy()
        try {
            if (!process.waitFor(250L, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly()
                process.waitFor(250L, TimeUnit.MILLISECONDS)
            }
        } catch (interrupted: InterruptedException) {
            process.destroyForcibly()
            Thread.currentThread().interrupt()
        }
    }
}
