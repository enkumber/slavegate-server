package com.phonenetwork.nostr

/**
 * NostrEventKinds.kt
 * Custom Nostr event kind constants for Phone Network v2.
 *
 * All kinds are in the ephemeral range (20000-29999) per NIP-01.
 * Ephemeral events are NOT stored by relays — transient message flow.
 *
 * Must match server-side event-kinds.ts exactly.
 */
object NostrEventKinds {
    /** Server → Device: Dispatch a job/command */
    const val JOB_DISPATCH = 21000
    
    /** Device → Server: Result of a dispatched job */
    const val JOB_RESULT = 21001
    
    /** Device → Server: Periodic health/status report */
    const val HEARTBEAT = 21002
    
    /** Server → Device: Emergency stop command */
    const val KILL_SWITCH = 21003
    
    /** Server → Device: OTA update notification */
    const val OTA = 21004
    
    /** Server → Device: Runtime config update */
    const val CONFIG_PUSH = 21005
    
    /** Device → Server: Initial registration/hello */
    const val DEVICE_HELLO = 21006
    
    /** Server → Device: Registration acknowledged */
    const val DEVICE_ACK = 21007
    
    /** Server → Device: Registration rejected / revoked */
    const val DEVICE_REJECT = 21008
    
    /** Device → Server: Vision analysis request (screenshot + query) */
    const val VISION_REQUEST = 21009
    
    /** Server → Device: Vision analysis result */
    const val VISION_RESULT = 21010
    
    /**
     * Get human-readable name for a kind (logging/debugging).
     */
    fun nameOf(kind: Int): String = when (kind) {
        JOB_DISPATCH -> "JOB_DISPATCH"
        JOB_RESULT -> "JOB_RESULT"
        HEARTBEAT -> "HEARTBEAT"
        KILL_SWITCH -> "KILL_SWITCH"
        OTA -> "OTA"
        CONFIG_PUSH -> "CONFIG_PUSH"
        DEVICE_HELLO -> "DEVICE_HELLO"
        DEVICE_ACK -> "DEVICE_ACK"
        DEVICE_REJECT -> "DEVICE_REJECT"
        VISION_REQUEST -> "VISION_REQUEST"
        VISION_RESULT -> "VISION_RESULT"
        else -> "UNKNOWN($kind)"
    }
}
