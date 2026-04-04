package com.phonenetwork.connection

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.phonenetwork.executor.JobExecutor
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * DirectWsClient — low-latency WebSocket transport for Phone Network.
 *
 * Alternative to Nostr relay for devices behind DDNS + port-forward.
 * Sub-second latency vs 8-10s via Nostr.
 *
 * Auth flow:
 *   1. Connect to ws://<host>/ws-direct
 *   2. Send { type: "AUTH", deviceId, deviceKey }
 *   3. Receive { type: "AUTH_OK" } or { type: "AUTH_FAIL" }
 *
 * Protocol:
 *   Server → Device: { type: "JOB", jobId, jobType, params }
 *   Device → Server: { type: "JOB_RESULT", jobId, success, output, error, durationMs }
 *   Device → Server: { type: "HEARTBEAT", battery, charging, foregroundApp, agentVersion }
 *   Server → Device: { type: "ACK" }
 *   Both:            { type: "PING" } / { type: "PONG" }
 *
 * Config (SharedPreferences "phone_network_direct"):
 *   direct_ws_url      — server URL, e.g. ws://enkzoned.go.ro:3000/ws-direct
 *   direct_ws_device_key — auth token from server
 *   direct_ws_enabled  — "true" to use this transport
 */
class DirectWsClient(
    private val context: Context,
    private val executor: JobExecutor,
    private val scope: CoroutineScope,
    private val onConnected: (deviceId: String) -> Unit = {},
    private val onDisconnected: () -> Unit = {},
) {
    companion object {
        private const val TAG = "DirectWsClient"
        private const val PREFS = "phone_network_direct"
        private const val PREF_URL = "direct_ws_url"
        private const val PREF_KEY = "direct_ws_device_key"
        private const val PREF_DEVICE_ID = "direct_ws_device_id"
        private const val PREF_ENABLED = "direct_ws_enabled"

        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val PING_INTERVAL_MS      = 30_000L
        private const val PONG_TIMEOUT_MS       = 90_000L
        private const val AUTH_TIMEOUT_MS       = 15_000L

        private const val RECONNECT_BASE_MS     = 1_000L
        private const val RECONNECT_MAX_MS      = 60_000L
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)   // no read timeout — persistent connection
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var authenticated = false
    @Volatile private var reconnectDelay = RECONNECT_BASE_MS

    private var heartbeatJob: Job? = null
    private var pingJob: Job? = null
    private var reconnectJob: Job? = null

    @Volatile private var lastPongAt = System.currentTimeMillis()
    @Volatile private var active = true  // set to false on explicit disconnect()

    // ─── Public API ───────────────────────────────────────────────────────────

    val isEnabled: Boolean get() = prefs.getBoolean(PREF_ENABLED, false)

    fun connect() {
        if (!isEnabled) {
            Log.d(TAG, "DirectWs disabled — skipping connect")
            return
        }
        val url = prefs.getString(PREF_URL, null)
        val key = prefs.getString(PREF_KEY, null)
        if (url.isNullOrBlank() || key.isNullOrBlank()) {
            Log.w(TAG, "DirectWs not configured (url or key missing)")
            return
        }
        active = true
        doConnect(url, key)
    }

    fun disconnect() {
        active = false
        heartbeatJob?.cancel(); heartbeatJob = null
        pingJob?.cancel();      pingJob = null
        reconnectJob?.cancel(); reconnectJob = null
        ws?.close(1000, "Disconnecting"); ws = null
        authenticated = false
    }

    fun isConnected(): Boolean = authenticated && ws?.let {
        it.queueSize() >= 0  // throws if closed, returns 0+ if open
    } ?: false

    // ─── Connection ───────────────────────────────────────────────────────────

    private fun doConnect(url: String, key: String) {
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "Connected to $url — sending AUTH")
                lastPongAt = System.currentTimeMillis()

                // AUTH
                val deviceId = prefs.getString(PREF_DEVICE_ID, null) ?: ""
                sendRaw(webSocket, JSONObject().apply {
                    put("type", "AUTH")
                    put("deviceId", deviceId)
                    put("deviceKey", key)
                })

                // Auth timeout watchdog
                scope.launch {
                    delay(AUTH_TIMEOUT_MS)
                    if (!authenticated) {
                        Log.w(TAG, "Auth timeout — closing")
                        webSocket.close(4001, "Auth timeout")
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleMessage(webSocket, text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "Closed: $code $reason")
                stopKeepalive()
                authenticated = false
                onDisconnected()
                if (active) scheduleReconnect(url, key)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "Connection failure: ${t.message}")
                stopKeepalive()
                authenticated = false
                onDisconnected()
                if (active) scheduleReconnect(url, key)
            }
        })
    }

    // ─── Message handling ─────────────────────────────────────────────────────

    private suspend fun handleMessage(webSocket: WebSocket, text: String) {
        val msg = try { JSONObject(text) } catch (e: Exception) {
            Log.w(TAG, "Invalid JSON: $text"); return
        }

        when (val type = msg.optString("type")) {
            "AUTH_OK" -> {
                val deviceId = msg.optString("deviceId")
                prefs.edit().putString(PREF_DEVICE_ID, deviceId).apply()
                authenticated = true
                reconnectDelay = RECONNECT_BASE_MS  // reset backoff
                Log.i(TAG, "AUTH_OK — deviceId=$deviceId")
                startKeepalive(webSocket)
                onConnected(deviceId)
            }

            "AUTH_FAIL" -> {
                Log.e(TAG, "AUTH_FAIL: ${msg.optString("reason")} — check device key")
                // Don't reconnect on auth fail — key is wrong
                active = false
                webSocket.close(4003, "Auth failed")
            }

            "JOB" -> {
                val jobId = msg.optString("jobId")
                val jobType = msg.optString("jobType")
                val params = msg.optJSONObject("params") ?: JSONObject()
                Log.i(TAG, "JOB received: $jobId type=$jobType")
                executeJob(webSocket, jobId, jobType, params)
            }

            "PING" -> sendRaw(webSocket, JSONObject().put("type", "PONG"))

            "PONG" -> {
                lastPongAt = System.currentTimeMillis()
                Log.d(TAG, "PONG received")
            }

            "ACK" -> Log.d(TAG, "ACK: ${msg.optString("ref")}")

            else -> Log.w(TAG, "Unknown message type: $type")
        }
    }

    // ─── Job execution ────────────────────────────────────────────────────────

    private fun executeJob(webSocket: WebSocket, jobId: String, jobType: String, params: JSONObject) {
        scope.launch {
            val startMs = System.currentTimeMillis()
            try {
                val jobPayload = JSONObject().apply {
                    put("jobId", jobId)
                    put("type", jobType)
                    put("params", params)
                }
                executor.execute(jobPayload) { result ->
                    val durationMs = System.currentTimeMillis() - startMs
                    sendRaw(webSocket, JSONObject().apply {
                        put("type", "JOB_RESULT")
                        put("jobId", jobId)
                        put("success", result.optString("status") == "completed")
                        put("output", result.opt("output"))
                        put("error", result.optString("error", ""))
                        put("durationMs", durationMs)
                    })
                    Log.i(TAG, "JOB_RESULT sent: $jobId success=${result.optString("status")}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Job execution failed: ${e.message}")
                sendRaw(webSocket, JSONObject().apply {
                    put("type", "JOB_RESULT")
                    put("jobId", jobId)
                    put("success", false)
                    put("output", JSONObject.NULL)
                    put("error", e.message ?: "Unknown error")
                    put("durationMs", System.currentTimeMillis() - startMs)
                })
            }
        }
    }

    // ─── Keepalive ────────────────────────────────────────────────────────────

    private fun startKeepalive(webSocket: WebSocket) {
        stopKeepalive()

        // HEARTBEAT every 30s
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                sendHeartbeat(webSocket)
            }
        }

        // PING every 30s + PONG timeout check
        pingJob = scope.launch {
            while (isActive) {
                delay(PING_INTERVAL_MS)
                val timeSincePong = System.currentTimeMillis() - lastPongAt
                if (timeSincePong > PONG_TIMEOUT_MS) {
                    Log.e(TAG, "PONG timeout (${timeSincePong}ms) — closing zombie connection")
                    webSocket.close(4002, "PONG timeout")
                    break
                }
                sendRaw(webSocket, JSONObject().put("type", "PING"))
            }
        }
    }

    private fun stopKeepalive() {
        heartbeatJob?.cancel(); heartbeatJob = null
        pingJob?.cancel();      pingJob = null
    }

    private fun sendHeartbeat(webSocket: WebSocket) {
        val battery = getBatteryLevel()
        val charging = isCharging()
        sendRaw(webSocket, JSONObject().apply {
            put("type", "HEARTBEAT")
            put("battery", battery)
            put("charging", charging)
            put("foregroundApp", getForegroundApp())
            put("agentVersion", getAgentVersion())
        })
    }

    // ─── Reconnect ────────────────────────────────────────────────────────────

    private fun scheduleReconnect(url: String, key: String) {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            val jitter = (Math.random() * 1000).toLong()
            Log.i(TAG, "Reconnecting in ${reconnectDelay}ms + ${jitter}ms jitter")
            delay(reconnectDelay + jitter)
            reconnectDelay = min(reconnectDelay * 2, RECONNECT_MAX_MS)
            if (active) doConnect(url, key)
        }
    }

    // ─── Util ─────────────────────────────────────────────────────────────────

    private fun sendRaw(webSocket: WebSocket, payload: JSONObject) {
        try {
            webSocket.send(payload.toString())
        } catch (e: Exception) {
            Log.w(TAG, "Send failed: ${e.message}")
        }
    }

    private fun getBatteryLevel(): Int {
        return try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
            bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } catch (e: Exception) { -1 }
    }

    private fun isCharging(): Boolean {
        return try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
            bm.isCharging
        } catch (e: Exception) { false }
    }

    private fun getForegroundApp(): String {
        return try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            @Suppress("DEPRECATION")
            am.runningAppProcesses?.firstOrNull {
                it.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
            }?.processName ?: ""
        } catch (e: Exception) { "" }
    }

    private fun getAgentVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (e: Exception) { "unknown" }
    }
}
