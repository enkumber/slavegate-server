package com.phonenetwork.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.phonenetwork.service.AgentForegroundService

/**
 * AgentAccessibilityService — primary UI automation mechanism.
 *
 * Phase 1: Declared in manifest. User enables in Settings > Accessibility.
 * Phase 2: Auto-enable via root ("settings put secure enabled_accessibility_services").
 *
 * This service is the main element-finding and interaction layer.
 * All automation flows through AccessibilityService first (L1).
 * VLM vision is last resort (L3, Phase 3) — only when A11y fails.
 *
 * Watchdog: Phase 2 adds periodic health check — if service is killed,
 * re-enable via root command.
 */
class AgentAccessibilityService : AccessibilityService() {

    private val tag = "PhoneNet/A11y"

    override fun onServiceConnected() {
        val info = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    AccessibilityServiceInfo.FLAG_REQUEST_ENHANCED_WEB_ACCESSIBILITY
            notificationTimeout = 100
        }
        serviceInfo = info
        Log.i(tag, "AccessibilityService connected — UI automation active")
        // Register with ForegroundService so JobExecutor can route automation through us
        AgentForegroundService.registerAccessibilityService(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Phase 2: events drive workflow state detection (screen change → update state machine)
        // Phase 1: no-op
    }

    override fun onInterrupt() {
        Log.w(tag, "AccessibilityService interrupted — Phase 2 watchdog will re-enable")
    }

    override fun onDestroy() {
        Log.w(tag, "AccessibilityService destroyed — Boot/Phase 2 watchdog will restart")
        super.onDestroy()
    }
}
