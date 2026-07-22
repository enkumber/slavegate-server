package com.phonenetwork.utils

import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedProcessRunnerTest {
    @Test
    fun `returns success for a process that exits`() {
        val result = BoundedProcessRunner.runBlocking(
            arrayOf("sh", "-c", "exit 0"),
            1_000L,
        )
        assertTrue(result.success)
        assertFalse(result.timedOut)
    }

    @Test
    fun `forcibly terminates a process at the deadline`() {
        val startedAt = System.currentTimeMillis()
        val result = BoundedProcessRunner.runBlocking(
            arrayOf("sh", "-c", "sleep 5"),
            100L,
        )
        assertTrue(result.timedOut)
        assertTrue(System.currentTimeMillis() - startedAt < 2_000L)
    }

    @Test
    fun `coroutine cancellation interrupts and destroys the process`() = runBlocking {
        val startedAt = System.currentTimeMillis()
        val job = launch {
            BoundedProcessRunner.run(arrayOf("sh", "-c", "sleep 30"), 60_000L)
        }
        delay(100L)
        job.cancelAndJoin()
        assertTrue(System.currentTimeMillis() - startedAt < 2_000L)
    }
}
