package com.phonenetwork.nostr

import android.content.Context
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import rust.nostr.sdk.*
import java.time.Duration

/**
 * NostrClient.kt
 * Dual-relay Nostr client for server communication.
 *
 * Connects to both relays simultaneously for redundancy.
 * All messages are NIP-44 encrypted between device and server.
 *
 * Event flow:
 * - Device → Server: JOB_RESULT, HEARTBEAT, DEVICE_HELLO, VISION_REQUEST
 * - Server → Device: JOB_DISPATCH, KILL_SWITCH, OTA, CONFIG_PUSH, DEVICE_ACK, DEVICE_REJECT
 *
 * NOTE: This is a standalone client. Integration with AgentForegroundService
 * will be done in Sprint 3b.
 */
class NostrClient(
    private val context: Context,
    private val relayUrls: List<String>,
    private val serverPubkey: String,
    private val deviceId: String,
    private val scope: CoroutineScope
) {
    companion object {
        private const val TAG = "NostrClient"
        private const val RECONNECT_DELAY_MS = 5000L
        private const val HEARTBEAT_INTERVAL_MS = 30000L
        private const val FETCH_INTERVAL_MS = 1000L  // Poll for new events (1s for responsiveness)
        private const val FETCH_TIMEOUT_SECS = 3L
    }

    private var client: Client? = null
    private var keys: Keys? = null
    private var serverPk: PublicKey? = null
    private var signer: NostrSigner? = null

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    private var heartbeatJob: Job? = null
    private var eventPollingJob: Job? = null
    private var lastEventTimestamp: Timestamp? = null

    // Handler for incoming events (set by AgentForegroundService)
    var messageHandler: NostrMessageHandler? = null

    /**
     * Connect to relays and start listening for events.
     */
    suspend fun connect() {
        withContext(Dispatchers.IO) {
            try {
                // Get device keys
                keys = NostrKeys.getOrCreateKeys(context)
                serverPk = PublicKey.parse(serverPubkey)

                Log.i(TAG, "Connecting to ${relayUrls.size} relay(s)...")
                Log.i(TAG, "Device pubkey: ${keys!!.publicKey().toHex().take(16)}...")
                Log.i(TAG, "Server pubkey: ${serverPubkey.take(16)}...")

                // Create client with signer
                signer = NostrSigner.keys(keys!!)
                client = Client(signer = signer)

                // Add relays
                for (url in relayUrls) {
                    try {
                        val relayUrl = RelayUrl.parse(url)
                        client!!.addRelay(relayUrl)
                        Log.i(TAG, "Added relay: $url")
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to add relay $url: ${e.message}")
                    }
                }

                // Connect
                client!!.connect()
                _isConnected.value = true
                Log.i(TAG, "Connected to relays")

                // Initialize last event timestamp to now (don't fetch old events)
                lastEventTimestamp = Timestamp.now()

                // Start polling for server events
                startEventPolling()

                // Send DEVICE_HELLO
                sendDeviceHello()

            } catch (e: Exception) {
                Log.e(TAG, "Connection failed: ${e.message}", e)
                _isConnected.value = false
                // Schedule reconnect
                scope.launch {
                    delay(RECONNECT_DELAY_MS)
                    connect()
                }
            }
        }
    }

    /**
     * Poll for events from server. Uses fetchEvents with 1s interval.
     * Filter: events from server pubkey tagged to us (p tag = our pubkey)
     */
    private fun startEventPolling() {
        eventPollingJob?.cancel()
        eventPollingJob = scope.launch(Dispatchers.IO) {
            while (isActive && _isConnected.value) {
                try {
                    val myPubkey = keys!!.publicKey()

                    val filter = Filter()
                        .author(PublicKey.parse(serverPubkey))
                        .pubkey(myPubkey)
                        .kinds(listOf(
                            Kind(NostrEventKinds.JOB_DISPATCH.toUShort()),
                            Kind(NostrEventKinds.KILL_SWITCH.toUShort()),
                            Kind(NostrEventKinds.OTA.toUShort()),
                            Kind(NostrEventKinds.CONFIG_PUSH.toUShort()),
                            Kind(NostrEventKinds.DEVICE_ACK.toUShort()),
                            Kind(NostrEventKinds.DEVICE_REJECT.toUShort()),
                            Kind(NostrEventKinds.VISION_RESULT.toUShort())
                        ))

                    val filterWithSince = lastEventTimestamp?.let { filter.since(it) } ?: filter

                    val events = client!!.fetchEvents(
                        filter = filterWithSince,
                        timeout = Duration.ofSeconds(FETCH_TIMEOUT_SECS)
                    )

                    for (event in events.toVec()) {
                        try {
                            handleIncomingEvent(event)
                            lastEventTimestamp = Timestamp.fromSecs(event.createdAt().asSecs() + 1u)
                        } catch (e: Exception) {
                            Log.e(TAG, "Error handling event: ${e.message}")
                        }
                    }

                } catch (e: Exception) {
                    Log.e(TAG, "Event polling failed: ${e.message}")
                }

                delay(FETCH_INTERVAL_MS)
            }
        }
    }

    /**
     * Handle incoming event from server.
     */
    private suspend fun handleIncomingEvent(event: Event) {
        val kind = event.kind().asU16().toInt()
        val eventId = event.id().toHex().take(8)

        Log.i(TAG, "Received event: kind=${NostrEventKinds.nameOf(kind)} id=$eventId")

        // Decrypt content (NIP-44)
        val content = try {
            nip44Decrypt(
                secretKey = keys!!.secretKey(),
                publicKey = serverPk!!,
                payload = event.content()
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decrypt event: ${e.message}")
            return
        }

        // Parse JSON payload
        val payload = try {
            JSONObject(content)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse event content: ${e.message}")
            return
        }

        // Route to handler
        messageHandler?.handleEvent(kind, payload, event)
    }

    /**
     * Publish encrypted event to server.
     */
    private suspend fun publishToServer(
        kind: Int,
        payload: JSONObject,
        extraTags: List<Tag> = emptyList()
    ) {
        withContext(Dispatchers.IO) {
            try {
                val content = payload.toString()

                // Encrypt with NIP-44
                val encrypted = nip44Encrypt(
                    secretKey = keys!!.secretKey(),
                    publicKey = serverPk!!,
                    content = content,
                    version = Nip44Version.V2
                )

                // Build tags list: p tag for recipient + any extra tags
                val tags = mutableListOf(Tag.publicKey(serverPk!!))
                tags.addAll(extraTags)

                // Build event
                val eventBuilder = EventBuilder(kind = Kind(kind.toUShort()), content = encrypted)
                    .tags(tags)

                // Send event
                val output = client!!.sendEventBuilder(eventBuilder)

                Log.i(TAG, "Published event: kind=${NostrEventKinds.nameOf(kind)} id=${output.id.toHex().take(8)}")
                Log.d(TAG, "  Sent to: ${output.success}")
                if (output.failed.isNotEmpty()) {
                    Log.w(TAG, "  Failed: ${output.failed}")
                }

            } catch (e: Exception) {
                Log.e(TAG, "Failed to publish event: ${e.message}", e)
                throw e
            }
        }
    }

    /**
     * Send DEVICE_HELLO (kind=21006) — initial registration.
     */
    suspend fun sendDeviceHello() {
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("pubkey", keys!!.publicKey().toHex())
            put("model", android.os.Build.MODEL)
            put("androidVersion", android.os.Build.VERSION.RELEASE)
            put("agentVersion", getAgentVersion())
        }

        publishToServer(NostrEventKinds.DEVICE_HELLO, payload)
        Log.i(TAG, "Sent DEVICE_HELLO")
    }

    /**
     * Send JOB_RESULT (kind=21001) — response to job dispatch.
     */
    suspend fun sendJobResult(jobId: String, result: JSONObject, success: Boolean) {
        val payload = JSONObject().apply {
            put("jobId", jobId)
            put("success", success)
            put("result", result)
            put("completedAt", System.currentTimeMillis())
        }

        // Add job tag for correlation
        val jobTag = Tag.parse(listOf("job", jobId))

        publishToServer(
            NostrEventKinds.JOB_RESULT,
            payload,
            listOf(jobTag)
        )
        Log.i(TAG, "Sent JOB_RESULT: jobId=${jobId.take(8)} success=$success")
    }

    /**
     * Send HEARTBEAT (kind=21002) — periodic health report.
     */
    suspend fun sendHeartbeat(health: JSONObject) {
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("timestamp", System.currentTimeMillis())
            put("batteryLevel", health.optInt("batteryLevel", -1))
            put("charging", health.optBoolean("charging", false))
            put("networkType", health.optString("networkType", "unknown"))
            put("publicIp", health.optString("publicIp", ""))
            put("activeApp", health.optString("activeApp", ""))
            put("storageFreeBytes", health.optLong("storageFreeBytes", -1))
        }

        publishToServer(NostrEventKinds.HEARTBEAT, payload)
        Log.d(TAG, "Sent HEARTBEAT")
    }

    /**
     * Send VISION_REQUEST (kind=21009) — screenshot + query for VLM.
     */
    suspend fun sendVisionRequest(screenshot: String, query: String) {
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("screenshot", screenshot)  // base64
            put("query", query)
            put("timestamp", System.currentTimeMillis())
        }

        publishToServer(NostrEventKinds.VISION_REQUEST, payload)
        Log.i(TAG, "Sent VISION_REQUEST: query=${query.take(50)}")
    }

    /**
     * Start periodic heartbeat.
     */
    fun startHeartbeat(healthProvider: () -> JSONObject) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                try {
                    if (_isConnected.value) {
                        sendHeartbeat(healthProvider())
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Heartbeat failed: ${e.message}")
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    /**
     * Stop heartbeat.
     */
    fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    /**
     * Disconnect from relays.
     */
    suspend fun disconnect() {
        stopHeartbeat()
        eventPollingJob?.cancel()

        withContext(Dispatchers.IO) {
            try {
                client?.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "Disconnect error: ${e.message}")
            }
        }

        _isConnected.value = false
        client = null
        Log.i(TAG, "Disconnected")
    }

    private fun getAgentVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (e: Exception) {
            "unknown"
        }
    }
}
