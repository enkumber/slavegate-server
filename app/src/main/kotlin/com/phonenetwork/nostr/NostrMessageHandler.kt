package com.phonenetwork.nostr

import org.json.JSONObject
import rust.nostr.sdk.Event

/**
 * NostrMessageHandler.kt
 * Interface for handling incoming Nostr events from the server.
 *
 * Implemented by AgentForegroundService to route events to appropriate handlers
 * (JobExecutor, VisionClient, etc.)
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
