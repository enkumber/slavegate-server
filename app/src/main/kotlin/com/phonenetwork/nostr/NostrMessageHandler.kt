package com.phonenetwork.nostr

import android.util.Log
import org.json.JSONObject
import rust.nostr.sdk.Event

/**
 * NostrMessageHandler.kt
 * Routes incoming Nostr events from the server to appropriate handlers.
 *
 * This is the default implementation with stub handlers for Sprint 3a testing.
 * AgentForegroundService will override this with real handlers in Sprint 3b.
 */
interface NostrMessageHandler {
    /**
     * Handle an incoming event from the server.
     *
     * @param kind The event kind (see NostrEventKinds)
     * @param payload The decrypted and parsed JSON payload
     * @param rawEvent The original Nostr event (for metadata like id, created_at, etc.)
     */
    suspend fun handleEvent(kind: Int, payload: JSONObject, rawEvent: Event)
}

/**
 * Default message handler with logging stubs.
 * Used for Sprint 3a standalone testing before full integration.
 */
open class DefaultNostrMessageHandler : NostrMessageHandler {
    
    companion object {
        private const val TAG = "NostrMsgHandler"
    }
    
    override suspend fun handleEvent(kind: Int, payload: JSONObject, rawEvent: Event) {
        val eventId = rawEvent.id().toHex().take(8)
        val kindName = NostrEventKinds.nameOf(kind)
        
        Log.i(TAG, "Received $kindName (id=$eventId)")
        
        when (kind) {
            NostrEventKinds.JOB_DISPATCH -> onJobDispatch(payload, rawEvent)
            NostrEventKinds.KILL_SWITCH -> onKillSwitch(payload, rawEvent)
            NostrEventKinds.OTA -> onOta(payload, rawEvent)
            NostrEventKinds.CONFIG_PUSH -> onConfigPush(payload, rawEvent)
            NostrEventKinds.DEVICE_ACK -> onDeviceAck(payload, rawEvent)
            NostrEventKinds.DEVICE_REJECT -> onDeviceReject(payload, rawEvent)
            NostrEventKinds.VISION_RESULT -> onVisionResult(payload, rawEvent)
            else -> Log.w(TAG, "Unknown event kind: $kind")
        }
    }
    
    /**
     * JOB_DISPATCH (21000) — Server sends a job/command to execute.
     * Override in AgentForegroundService to route to JobExecutor.
     */
    protected open suspend fun onJobDispatch(payload: JSONObject, rawEvent: Event) {
        val jobId = payload.optString("jobId", "unknown")
        val type = payload.optString("type", "unknown")
        Log.i(TAG, "[STUB] JOB_DISPATCH: jobId=${jobId.take(8)} type=$type")
        // TODO Sprint 3b: executor.dispatch(jobId, type, payload.optJSONObject("params"))
    }
    
    /**
     * KILL_SWITCH (21003) — Emergency stop command.
     * Override to trigger device lockdown.
     */
    protected open suspend fun onKillSwitch(payload: JSONObject, rawEvent: Event) {
        val reason = payload.optString("reason", "unspecified")
        Log.w(TAG, "[STUB] KILL_SWITCH received! reason=$reason")
        // TODO Sprint 3b: killSwitchManager.activate(reason)
    }
    
    /**
     * OTA (21004) — Over-the-air update notification.
     * Override to trigger OTA download and install.
     */
    protected open suspend fun onOta(payload: JSONObject, rawEvent: Event) {
        val version = payload.optString("version", "unknown")
        val apkUrl = payload.optString("apkUrl", "")
        Log.i(TAG, "[STUB] OTA: version=$version url=${apkUrl.take(50)}")
        // TODO Sprint 3b: otaManager.startUpdate(version, apkUrl, payload)
    }
    
    /**
     * CONFIG_PUSH (21005) — Runtime config update.
     * Override to apply new configuration.
     */
    protected open suspend fun onConfigPush(payload: JSONObject, rawEvent: Event) {
        Log.i(TAG, "[STUB] CONFIG_PUSH: ${payload.keys().asSequence().toList()}")
        // TODO Sprint 3b: configManager.apply(payload)
    }
    
    /**
     * DEVICE_ACK (21007) — Registration acknowledged/approved.
     * Override to update device state.
     */
    protected open suspend fun onDeviceAck(payload: JSONObject, rawEvent: Event) {
        val status = payload.optString("status", "unknown")
        Log.i(TAG, "[STUB] DEVICE_ACK: status=$status — Device approved!")
        // TODO Sprint 3b: Update UI, persist approved state
    }
    
    /**
     * DEVICE_REJECT (21008) — Registration rejected or device revoked.
     * Override to handle rejection (e.g., disable service, notify user).
     */
    protected open suspend fun onDeviceReject(payload: JSONObject, rawEvent: Event) {
        val reason = payload.optString("reason", "unspecified")
        Log.w(TAG, "[STUB] DEVICE_REJECT: reason=$reason — Device rejected!")
        // TODO Sprint 3b: Disable service, show notification, clear credentials
    }
    
    /**
     * VISION_RESULT (21010) — VLM analysis result from server.
     * Override to route result to VisionClient callback.
     */
    protected open suspend fun onVisionResult(payload: JSONObject, rawEvent: Event) {
        val query = payload.optString("query", "").take(30)
        val resultPreview = payload.optString("result", "").take(50)
        Log.i(TAG, "[STUB] VISION_RESULT: query='$query' result='$resultPreview...'")
        // TODO Sprint 3b: visionClient.handleResult(payload)
    }
}
