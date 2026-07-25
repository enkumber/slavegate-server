package com.phonenetwork.connection

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.provider.Settings
import android.util.Log
import com.phonenetwork.executor.BatchExecutor
import com.phonenetwork.executor.JobExecutor
import com.phonenetwork.workflow.WorkflowEngine
import com.phonenetwork.utils.BoundedProcessRunner
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
    private val onModelConfigUpdated: () -> Unit = {},
    private val onOtaUpdate: (version: String, versionCode: Int, apkUrl: String, apkSha256: String, mandatory: Boolean) -> Unit = { _, _, _, _, _ -> },
    private val onTaskResult: (taskType: String, success: Boolean, result: Map<String, Any?>, error: String?) -> Unit = { _, _, _, _ -> },
    private var batchExecutor: BatchExecutor? = null,
    private var workflowEngine: WorkflowEngine? = null,
) {
    private var workflowCancellationWatchdogJob: Job? = null

    /**
     * Set the BatchExecutor instance. Called after dependencies are initialized.
     * Without this, BATCH_START messages are rejected with an error.
     */
    fun setBatchExecutor(be: BatchExecutor) {
        batchExecutor = be
        Log.i(TAG, "BatchExecutor attached to DirectWsClient")
    }

    /**
     * Set the WorkflowEngine instance for edge execution (ADR-001).
     */
    fun setWorkflowEngine(engine: WorkflowEngine) {
        workflowEngine = engine
        Log.i(TAG, "WorkflowEngine attached to DirectWsClient")
    }
    /**
     * Stable device ID derived from hardware serial.
     * Uses root `getprop ro.serialno` → SHA-256 → UUID v5 style.
     * Falls back to stored prefs, then ANDROID_ID, then random UUID.
     * This ensures the same physical device always gets the same ID,
     * even after uninstall/reinstall or package name change.
     */
    private fun getStableDeviceId(): String {
        // 1. Already have a stable ID saved?
        val stored = prefs.getString(PREF_DEVICE_ID, null)
        if (!stored.isNullOrBlank()) return stored

        // 2. Try hardware serial via root
        val serial = try {
            BoundedProcessRunner.runBlocking(
                arrayOf("su", "-c", "getprop ro.serialno"),
                5_000L,
            ).output
        } catch (_: Exception) { "" }

        if (serial.isNotBlank() && serial != "unknown") {
            // Derive UUID from serial: SHA-256 hash → format as UUID
            val hash = java.security.MessageDigest.getInstance("SHA-256")
                .digest(serial.toByteArray())
            val uuid = java.util.UUID.nameUUIDFromBytes(hash)
            prefs.edit().putString(PREF_DEVICE_ID, uuid.toString()).apply()
            Log.i(TAG, "Stable deviceId from serial: ${uuid}")
            return uuid.toString()
        }

        // 3. Fallback: ANDROID_ID (less stable but better than random)
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        if (!androidId.isNullOrBlank()) {
            val uuid = java.util.UUID.nameUUIDFromBytes(androidId.toByteArray())
            prefs.edit().putString(PREF_DEVICE_ID, uuid.toString()).apply()
            Log.i(TAG, "Stable deviceId from ANDROID_ID: ${uuid}")
            return uuid.toString()
        }

        // 4. Last resort: random (will change on reinstall)
        val uuid = java.util.UUID.randomUUID().toString()
        prefs.edit().putString(PREF_DEVICE_ID, uuid).apply()
        Log.w(TAG, "Stable deviceId fallback to random: $uuid")
        return uuid
    }

    companion object {
        private const val TAG = "DirectWsClient"
        private const val PREFS = "phone_network_direct"
        private const val PREF_URL = "direct_ws_url"
        private const val PREF_KEY = "direct_ws_device_key"
        private const val PREF_DEVICE_ID = "direct_ws_device_id"
        private const val PREF_ENABLED = "direct_ws_enabled"

        private const val PING_INTERVAL_MS      = 15_000L
        private const val PONG_TIMEOUT_MS       = 10_000L   // 10s timeout per spec
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val AUTH_TIMEOUT_MS       = 15_000L

        private const val RECONNECT_BASE_MS     = 1_000L
        private const val RECONNECT_MAX_MS      = 60_000L
        private const val RECONNECT_MAX_ATTEMPTS = 10
        private const val SERVER_HEALTH_POLL_MS  = 60_000L
        private const val WORKFLOW_CANCEL_GRACE_MS = 5_000L
        private const val AGENT_RECOVERY_DELAY_MS = 2_000L
        private const val AGENT_RECOVERY_REQUEST_CODE = 9107
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

    @Volatile private var lastPongAt = 0L
    @Volatile private var lastPingSentAt = 0L
    @Volatile private var active = true  // set to false on explicit disconnect()
    @Volatile private var consecutiveReconnectAttempts = 0
    @Volatile private var lastServerUrl: String? = null
    @Volatile private var lastDeviceKey: String? = null

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var healthPollJob: Job? = null

    // ─── Public API ───────────────────────────────────────────────────────────

    val isEnabled: Boolean get() = prefs.getBoolean(PREF_ENABLED, false)

    fun connect() {
        if (!isEnabled) {
            Log.d(TAG, "DirectWs disabled — skipping connect")
            return
        }
        val url = prefs.getString(PREF_URL, null)
        val key = prefs.getString(PREF_KEY, null) ?: ""
        if (url.isNullOrBlank()) {
            Log.w(TAG, "DirectWs not configured (url missing)")
            return
        }
        active = true
        lastServerUrl = url
        lastDeviceKey = key
        doConnect(url, key)
        registerNetworkCallback()
        startHealthPoll()
    }

    fun disconnect() {
        active = false
        heartbeatJob?.cancel(); heartbeatJob = null
        pingJob?.cancel();      pingJob = null
        reconnectJob?.cancel(); reconnectJob = null
        healthPollJob?.cancel(); healthPollJob = null
        unregisterNetworkCallback()
        ws?.close(1000, "Disconnecting"); ws = null
        authenticated = false
        lastPingSentAt = 0L
        lastPongAt = 0L
        consecutiveReconnectAttempts = 0
    }

    fun isConnected(): Boolean {
        val ws = ws ?: return false
        if (!authenticated) return false
        // Check PONG timeout (15s + 2s grace)
        if (lastPingSentAt > lastPongAt && System.currentTimeMillis() - lastPingSentAt > PONG_TIMEOUT_MS + 2_000L) {
            return false
        }
        return true
    }

    // ─── Connection ───────────────────────────────────────────────────────────

    private fun doConnect(url: String, key: String) {
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "Connected to $url — sending AUTH")
                lastPongAt = System.currentTimeMillis()

                // AUTH — send deviceId+key+deviceInfo for enrollment
                // Stable device ID: derive from hardware serial (root) so it survives reinstall
                val deviceId = getStableDeviceId()
                val fingerprint = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                val agentVersion = getAgentVersion()
                val manufacturer = android.os.Build.MANUFACTURER
                val model = android.os.Build.MODEL
                val androidVersion = android.os.Build.VERSION.RELEASE
                sendRaw(webSocket, JSONObject().apply {
                    put("type", "AUTH")
                    put("deviceId", deviceId)
                    put("deviceKey", key)
                    put("fingerprint", fingerprint)
                    put("deviceInfo", JSONObject().apply {
                        put("manufacturer", manufacturer)
                        put("model", model)
                        put("androidVersion", androidVersion)
                        put("agentVersion", agentVersion)
                    })
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
                val deviceKey = msg.optString("deviceKey")
                if (deviceId.isNotBlank()) {
                    prefs.edit()
                        .putString(PREF_DEVICE_ID, deviceId)
                        .putString(PREF_KEY, deviceKey)
                        .apply()
                }
                authenticated = true
                reconnectDelay = RECONNECT_BASE_MS  // reset backoff
                consecutiveReconnectAttempts = 0
                Log.i(TAG, "AUTH_OK — deviceId=$deviceId")
                startKeepalive(webSocket)
                onConnected(deviceId)
                onModelConfigUpdated()
            }

            "MODEL_CONFIG_UPDATED" -> {
                Log.i(TAG, "MODEL_CONFIG_UPDATED received")
                onModelConfigUpdated()
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
                val timeoutMs = msg.optLong("timeoutMs", 0L)
                Log.i(TAG, "JOB received: $jobId type=$jobType")
                executeJob(webSocket, jobId, jobType, params, timeoutMs)
            }

            "BATCH_START" -> {
                Log.i(TAG, "BATCH_START received: batchId=${msg.optString("batchId")}")
                executeBatch(webSocket, msg)
            }

            "PING" -> sendRaw(webSocket, JSONObject().put("type", "PONG"))

            "PONG" -> {
                lastPongAt = System.currentTimeMillis()
                Log.d(TAG, "PONG received")
            }

            "HEARTBEAT_ACK" -> {
                Log.d(TAG, "HEARTBEAT_ACK received")
            }

            "ACK" -> Log.d(TAG, "ACK: ${msg.optString("ref")}")

            "OTA_UPDATE" -> {
                val version = msg.optString("version")
                val versionCode = msg.optInt("versionCode", 0)
                val apkUrl = msg.optString("apkUrl")
                val apkSha256 = msg.optString("apkSha256")
                val mandatory = msg.optBoolean("mandatory", false)
                Log.i(TAG, "OTA_UPDATE: version=$version code=$versionCode mandatory=$mandatory")
                onOtaUpdate(version, versionCode, apkUrl, apkSha256, mandatory)
            }

            "EXECUTE_TASK" -> {
                val taskType = msg.optString("taskType", "")
                val params = msg.optJSONObject("params")?.let { obj ->
                    obj.keys()?.asSequence()?.associateWith { obj.opt(it) } ?: emptyMap()
                } ?: emptyMap()
                Log.i(TAG, "EXECUTE_TASK: $taskType params=$params")
                executeJob(webSocket, "", taskType, JSONObject(params))
            }

            // ─── Edge Workflow Execution (ADR-001) ───────────────────────────────
            "WORKFLOW_START" -> {
                workflowCancellationWatchdogJob?.cancel()
                Log.i(TAG, "WORKFLOW_START received: ${msg.optString("id")}")
                notifyDebug(
                    "Workflow START",
                    "template=${msg.optString("id")} run=${msg.optString("workflowId", "none").take(8)}"
                )
                executeWorkflow(msg)
            }

            "WORKFLOW_CANCEL" -> {
                val runId = msg.optString("workflowId", "")
                Log.i(TAG, "WORKFLOW_CANCEL received: ${runId.take(8)}")
                notifyDebug("Workflow CANCEL", "run=${runId.take(8)}")
                val engine = workflowEngine
                val cancellationAccepted = engine?.cancel(runId) == true
                workflowCancellationWatchdogJob?.cancel()
                if (cancellationAccepted) {
                    workflowCancellationWatchdogJob = scope.launch {
                        delay(WORKFLOW_CANCEL_GRACE_MS)
                        if (engine?.isRunning(runId) == true) {
                            Log.e(TAG, "Workflow cancel did not unwind within grace period; restarting agent process")
                            scheduleAgentProcessRecovery()
                        }
                    }
                } else {
                    Log.i(TAG, "Ignoring stale WORKFLOW_CANCEL for ${runId.take(8)}")
                }
            }

            "LLM_RESULT" -> {
                // LLM response from server — handled by WorkflowEngine's requestLLM callback
                Log.d(TAG, "LLM_RESULT received: requestId=${msg.optString("requestId")}")
                handleLlmResult(msg)
            }

            // ─── Template OTA push (ADR-001 Phase 3) ──────────────────────────────
            "CONFIG_UPDATE" -> {
                val template = msg.optJSONObject("template")
                if (template != null) {
                    Log.i(TAG, "CONFIG_UPDATE: template push id=${template.optString("id")}")
                    val store = com.phonenetwork.workflow.TemplateStore(context)
                    val saved = store.saveTemplate(template)
                    Log.i(TAG, "Template OTA: ${if (saved) "saved" else "already cached"}")
                }
            }

            else -> Log.w(TAG, "Unknown message type: $type")
        }
    }

    // ─── Job execution ────────────────────────────────────────────────────────

    private fun executeJob(webSocket: WebSocket, jobId: String, jobType: String, params: JSONObject, timeoutMs: Long = 0L) {
        scope.launch {
            val startMs = System.currentTimeMillis()
            try {
                val jobPayload = JSONObject().apply {
                    put("jobId", jobId)
                    put("type", jobType)
                    put("params", params)
                    if (timeoutMs > 0L) put("timeoutMs", timeoutMs)
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

    // ─── Batch execution (Fast-Path) ──────────────────────────────────────────

    /**
     * Execute a BATCH_START message via BatchExecutor.
     *
     * Flow:
     *   1. Receive BATCH_START from server
     *   2. Delegate to BatchExecutor.executeBatch()
     *   3. BatchExecutor runs all steps locally (zero server contact)
     *   4. Send BATCH_RESULT back via WebSocket
     *
     * Falls back to error result if BatchExecutor is not initialized.
     */
    private fun executeBatch(webSocket: WebSocket, batchMsg: JSONObject) {
        val be = batchExecutor
        if (be == null) {
            Log.e(TAG, "BATCH_START received but BatchExecutor not initialized — sending error")
            sendRaw(webSocket, JSONObject().apply {
                put("type", "BATCH_RESULT")
                put("batchId", batchMsg.optString("batchId"))
                put("workflowId", batchMsg.optString("workflowId"))
                put("completed", false)
                put("partial", false)
                put("timedOut", false)
                put("results", org.json.JSONArray())
                put("executedAt", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
                    .format(java.util.Date()))
                put("totalDurationMs", 0)
                put("error", "BatchExecutor not initialized on device")
            })
            return
        }

        scope.launch {
            try {
                be.executeBatch(batchMsg) { resultJson ->
                    sendRaw(webSocket, resultJson)
                    Log.i(TAG, "BATCH_RESULT sent: batchId=${resultJson.optString("batchId")} " +
                            "completed=${resultJson.optBoolean("completed")}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Batch execution failed: ${e.message}")
                sendRaw(webSocket, JSONObject().apply {
                    put("type", "BATCH_RESULT")
                    put("batchId", batchMsg.optString("batchId"))
                    put("workflowId", batchMsg.optString("workflowId"))
                    put("completed", false)
                    put("partial", false)
                    put("timedOut", false)
                    put("results", org.json.JSONArray())
                    put("executedAt", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
                        .format(java.util.Date()))
                    put("totalDurationMs", 0)
                    put("error", e.message ?: "Unknown batch error")
                })
            }
        }
    }

    // ─── Keepalive ────────────────────────────────────────────────────────────

    private fun startKeepalive(webSocket: WebSocket) {
        stopKeepalive()

        // Unified heartbeat + ping/pong in single loop
        heartbeatJob = scope.launch {
            var pingCounter = 0
            while (isActive) {
                delay(PING_INTERVAL_MS)

                // Check PONG timeout from previous ping
                if (lastPingSentAt > lastPongAt) {
                    val timeSincePing = System.currentTimeMillis() - lastPingSentAt
                    if (timeSincePing > PONG_TIMEOUT_MS) {
                        Log.e(TAG, "PONG timeout (${timeSincePing}ms) — closing zombie connection")
                        webSocket.close(4002, "PONG timeout")
                        break
                    }
                }

                // Send PING
                lastPingSentAt = System.currentTimeMillis()
                sendRaw(webSocket, JSONObject().put("type", "PING"))
                pingCounter++

                // Send HEARTBEAT every 2 pings (30s)
                if (pingCounter >= 2) {
                    pingCounter = 0
                    sendHeartbeat(webSocket)
                }
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
        val stat = android.os.StatFs(context.filesDir.absolutePath)
        val storageFreeBytes = stat.availableBlocksLong * stat.blockSizeLong
        sendRaw(webSocket, JSONObject().apply {
            put("type", "HEARTBEAT")
            put("battery", battery)
            put("charging", charging)
            put("storageFreeBytes", storageFreeBytes)
            put("foregroundApp", getForegroundApp())
            put("agentVersion", getAgentVersion())
        })
    }

    // ─── Reconnect ────────────────────────────────────────────────────────────

    private fun scheduleReconnect(url: String, key: String) {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            consecutiveReconnectAttempts++
            if (consecutiveReconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
                Log.w(TAG, "Reconnect attempts cap reached ($RECONNECT_MAX_ATTEMPTS) — resetting backoff")
                reconnectDelay = RECONNECT_BASE_MS
                consecutiveReconnectAttempts = 0
            }
            val jitter = (Math.random() * 1000).toLong()
            Log.i(TAG, "Reconnecting in ${reconnectDelay}ms + ${jitter}ms jitter (attempt $consecutiveReconnectAttempts)")
            delay(reconnectDelay + jitter)
            reconnectDelay = min(reconnectDelay * 2, RECONNECT_MAX_MS)
            if (active) doConnect(url, key)
        }
    }

    // ─── Network Change Listener ──────────────────────────────────────────────

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onLost(network: Network) {
                    Log.w(TAG, "Network lost")
                    if (isConnected()) {
                        ws?.close(4004, "Network lost")
                        scheduleReconnect(lastServerUrl ?: return, lastDeviceKey ?: "")
                    }
                }

                override fun onAvailable(network: Network) {
                    Log.i(TAG, "Network available")
                    if (!isConnected() && active) {
                        reconnectJob?.cancel()
                        reconnectDelay = RECONNECT_BASE_MS
                        doConnect(lastServerUrl ?: return, lastDeviceKey ?: "")
                    }
                }
            }
            networkCallback = callback
            cm.registerNetworkCallback(request, callback)
            Log.i(TAG, "Network callback registered")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register network callback: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let { callback ->
            try {
                val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
                cm.unregisterNetworkCallback(callback)
                Log.i(TAG, "Network callback unregistered")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to unregister network callback: ${e.message}")
            }
            networkCallback = null
        }
    }

    // ─── Server Health Poll ───────────────────────────────────────────────────

    private fun startHealthPoll() {
        healthPollJob?.cancel()
        healthPollJob = scope.launch {
            while (isActive) {
                delay(SERVER_HEALTH_POLL_MS)
                if (!isConnected() && active) {
                    val url = lastServerUrl
                    val key = lastDeviceKey
                    if (url != null) {
                        Log.i(TAG, "Health poll: attempting reconnect")
                        reconnectJob?.cancel()
                        reconnectDelay = RECONNECT_BASE_MS
                        doConnect(url, key ?: "")
                    }
                }
            }
        }
    }

    // ─── Edge Workflow Execution (ADR-001) ──────────────────────────────────

    private fun executeWorkflow(msg: JSONObject) {
        val engine = workflowEngine
        if (engine == null) {
            Log.e(TAG, "WORKFLOW_START received but WorkflowEngine not initialized")
            notifyDebug("Workflow FAILED", "WorkflowEngine not initialized")
            sendRaw(ws ?: return, JSONObject().apply {
                put("type", "WORKFLOW_STATUS")
                put("workflowId", msg.optString("workflowId", msg.optString("id")))
                put("status", "failed")
                put("error", "WorkflowEngine not initialized on device")
            })
            return
        }

        scope.launch {
            try {
                engine.executeWorkflow(msg)
            } catch (e: Exception) {
                Log.e(TAG, "Workflow execution failed: ${e.message}")
            }
        }
    }

    /**
     * Last-resort local watchdog. This is deliberately process-only recovery:
     * it does not reboot the phone and does not use root. The launch alarm is
     * registered before killing the process, so Android starts a clean agent
     * even if an OEM fails to restart the sticky foreground service promptly.
     */
    private fun scheduleAgentProcessRecovery() {
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launchIntent == null) {
            Log.e(TAG, "Cannot schedule agent recovery: launch intent unavailable")
            return
        }
        launchIntent.addFlags(
            android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
        )
        val pendingIntent = android.app.PendingIntent.getActivity(
            context,
            AGENT_RECOVERY_REQUEST_CODE,
            launchIntent,
            android.app.PendingIntent.FLAG_CANCEL_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        val triggerAt = android.os.SystemClock.elapsedRealtime() + AGENT_RECOVERY_DELAY_MS
        alarmManager.setAndAllowWhileIdle(
            android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
            triggerAt,
            pendingIntent,
        )
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    private fun notifyDebug(title: String, text: String) {
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notification = Notification.Builder(context, "phone_network_agent")
                .setContentTitle("Phone Network Agent — $title")
                .setContentText(text.take(120))
                .setSmallIcon(android.R.drawable.ic_menu_manage)
                .setShowWhen(true)
                .build()
            nm.notify(1102, notification)
        } catch (e: Exception) {
            Log.w(TAG, "notifyDebug failed: ${e.message}")
        }
    }

    // ─── LLM request/response (via WebSocket) ──────────────────────────────────

    private val pendingLlmRequests = mutableMapOf<String, ((String) -> Unit)>()

    fun requestLLMViaWs(requestId: String, prompt: String, screenshot: String?, model: String) {
        val currentWs = ws ?: run {
            Log.w(TAG, "Cannot send LLM_REQUEST — not connected")
            return
        }
        sendRaw(currentWs, JSONObject().apply {
            put("type", "LLM_REQUEST")
            put("requestId", requestId)
            put("prompt", prompt)
            if (screenshot != null) put("screenshot", screenshot)
            put("model", model)
        })
    }

    private fun handleLlmResult(msg: JSONObject) {
        val requestId = msg.optString("requestId")
        val result = msg.optString("result", "")
        val error = msg.optString("error", null)

        val callback = pendingLlmRequests.remove(requestId)
        if (callback != null) {
            if (error != null) {
                Log.w(TAG, "LLM_RESULT error: $error")
            }
            callback(result)
        } else {
            Log.w(TAG, "LLM_RESULT for unknown requestId: $requestId")
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

    /**
     * Send a raw JSON payload to the server via the current WebSocket connection.
     * Used by WorkflowEngine to send WORKFLOW_STATUS updates.
     */
    fun sendRaw(payload: JSONObject): Boolean {
        val ws = this.ws
        if (ws != null) {
            return try {
                ws.send(payload.toString())
            } catch (e: Exception) {
                Log.w(TAG, "Send raw failed: ${e.message}")
                false
            }
        } else {
            Log.w(TAG, "Cannot send raw payload — WebSocket not connected")
            return false
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
