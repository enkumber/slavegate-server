package com.phonenetwork.verification

/**
 * VerificationResult — output of Action Verification Cascade.
 * Included in every JOB_RESULT payload.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §5
 */
data class VerificationResult(
    val verified:            Boolean,
    val verifiedBy:          VerifiedBy,
    val cascadeLevelsUsed:   Int,        // 0 = no verification, 1 = L1 only, 2 = L1+L2, 3 = L1+L2+L3
    val confidence:          Float,      // 0.0 - 1.0
    val llmTokensUsed:       Int,        // 0 in Phase 2
    val verificationTimeMs:  Long,
    val note:                String? = null
) {
    companion object {
        /** Phase 1 stub — no verification performed */
        fun none() = VerificationResult(
            verified           = false,
            verifiedBy         = VerifiedBy.NONE,
            cascadeLevelsUsed  = 0,
            confidence         = 0f,
            llmTokensUsed      = 0,
            verificationTimeMs = 0
        )
    }
}

enum class VerifiedBy(val value: String) {
    UI_TREE("ui_tree"),
    PIXEL_DIFF("pixel_diff"),
    VLM("vlm"),
    NONE("none");

    override fun toString() = value
}

/** Strategy received from server in JOB_DISPATCH */
enum class VerificationStrategy(val value: String) {
    LOCAL_ONLY("local_only"),
    LOCAL_WITH_SCREENSHOT("local_with_screenshot"),
    FULL_CASCADE("full_cascade"),      // Phase 3
    VLM_REQUIRED("vlm_required");      // Phase 3

    companion object {
        fun from(value: String?): VerificationStrategy =
            entries.find { it.value == value } ?: LOCAL_WITH_SCREENSHOT
    }
}
