package com.phonenetwork.ota

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class OtaVersionPolicyTest {
    @Test
    fun acceptsUpgradeWhenDeclaredApkAndInstalledVersionsAreConsistent() {
        OtaVersionPolicy.validate(115, 115, 110, false)
    }

    @Test
    fun acceptsReinstallOfSameVersion() {
        OtaVersionPolicy.validate(115, 115, 115, false)
    }

    @Test
    fun rejectsStaleServerMetadataBeforeCallingItADowngrade() {
        val error = expectFailure<IllegalArgumentException> {
            OtaVersionPolicy.validate(107, 115, 110, false)
        }
        assertEquals("OTA metadata mismatch: declared=107, apk=115", error.message)
    }

    @Test
    fun rejectsARealDowngrade() {
        val error = expectFailure<IllegalStateException> {
            OtaVersionPolicy.validate(107, 107, 110, false)
        }
        assertEquals("Downgrade prevented: installed=110, target=107", error.message)
    }

    @Test
    fun allowsExplicitDowngradeButNeverAllowsMetadataMismatch() {
        OtaVersionPolicy.validate(107, 107, 110, true)
        expectFailure<IllegalArgumentException> {
            OtaVersionPolicy.validate(106, 107, 110, true)
        }
    }

    private inline fun <reified T : Throwable> expectFailure(block: () -> Unit): T {
        try {
            block()
            fail("Expected ${T::class.java.simpleName}")
        } catch (error: Throwable) {
            if (error is T) return error
            throw error
        }
        throw AssertionError("unreachable")
    }
}
