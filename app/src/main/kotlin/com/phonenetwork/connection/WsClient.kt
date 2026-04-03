package com.phonenetwork.connection

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.phonenetwork.anti_detection.DnsPrivacyApplier
// CloakConfigStore import removed — cloak functionality deprecated
import com.phonenetwork.executor.JobExecutor
import com.phonenetwork.health.HealthMonitor
import com.phonenetwork.vision.VisionClient
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * WsClient — Outbound WebSocket client for relay server connection.
 *
 * Phase 2: Phone initiates outbound WebSocket to relay server.
 * This solves NAT/firewall traversal — phone is client, relay is server.
 *
 * Connection states:
 * - DISCONNECTED: Initial / after disconnect() / after permanent failure
 * - CONNECTING: TCP handshake in progress
 * - AUTHENTICATING: Connected, performing registration + EC key challenge
 * - CONNECTED: Fully authenticated and ready for job dispatch / heartbeats
 * - RECONNECTING: Connection lost, waiting before next attempt
 *
 * Reconnect: exponential backoff starting at 1s, doubling each time,
 * capped at 60s, with ±30% jitter added each cycle.
 * Relay keeps session in grace period (30s) for seamless resume.
 *
 * Auth flow (relay server):
 * 1. Connect → `ensureKeyPair()` (once, idempotent)
 * 2. Send register { deviceId, authToken, role: "phone", imei, publicKeyPem, ... }
 *    Relay validates authToken. If approved → sends registered + optional CHALLENGE.
 *    If pending/revoked → HELLO_REJECT or error.
 * 3. Receive CHALLENGE → sign nonce bytes with EC private key → send CHALLENGE_RESPONSE
 * 4. Server verifies ECDSA-SHA256 → sends HELLO_ACK (device authenticated)
 *
 * Security:
 * - EC P-256 key pair in Android Keystore (hardware-backed, non-exportable)
 * - Server stores only public key — no secret exposed on server compromise
 * - Nonce is one-time-use, expires in 60s — prevents replay attacks
 * - Auth token: HMAC-SHA256 based, stored per-device
 *
 * Heartbeat: application-level PING every 30s (Cloudflare-compatible).
 * PONG timeout: 60s — triggers reconnect for zombie connections.
 */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    CONNECTED,
    RECONNECTING
}

class WsClient(
    private val relayHost: String?,
    private val relayPort: Int?,
    private val executor: JobExecutor,
    private val healthMonitor: HealthMonitor,
    private val scope: CoroutineScope,
    private val onRevoked: () -> Unit = {},
    private val onConnected: (deviceId: String) -> Unit = {}
) {
    val visionClient: VisionClient = VisionClient(sendMessage = { type, payload ->
        send(ws, type, payload)
    })

    companion object {
        private const val TAG                  = "WsClient"
        private const val HEARTBEAT_IDLE_MS    = 45_000L
        private const val HEARTBEAT_ACTIVE_MS  = 30_000L
        private const val MAX_RECONNECT_DELAY  = 60_000L
        const val KEY_ALIAS                    = "phone_network_device_key"
        private const val IMEI_CACHE_KEY       = "cached_imei"
        private const val DEVICE_ID_KEY        = "server_device_id"
        private const val AUTH_TOKEN_KEY       = "auth_token"
        private const val PREFS_NAME           = "phone_network_auth"
        private const val UUID_FILE            = "device_imei.txt"
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(90, TimeUnit.SECONDS)  // 90s read timeout — detects dead connections
        // OkHttp ping frames removed — Cloudflare can filter/delay WS ping frames,
        // causing pong timeout after 0 successful pings → disconnect loop.
        // Replaced by application-level PING/PONG messages (see keepAliveJob below).
        .build()

    private var ws: WebSocket? = null
    private var isActive = false
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null        // only one pending reconnect at a time
    private var keepAliveJob: Job? = null        // application-level PING every 30s
    private var connectingWatchdogJob: Job? = null  // detects stuck in "Connecting..." state
    private var authTimeoutJob: Job? = null      // detects auth completion timeout
    private var reconnectDelay = 1_000L  // backoff starts at 1s
    private var connectionOpenedAt = 0L
    private var rapidReconnectCount = 0

    // PONG timeout tracking — detects zombie connections
    private var lastPongReceived = System.currentTimeMillis()
    private val classInitializedAt = System.currentTimeMillis()  // Track when WsClient was created
    private val PONG_TIMEOUT_MS = 60_000L        // 60s without PONG = zombie connection
    private val CONNECTING_TIMEOUT_MS = 45_000L  // 45s stuck in connecting = force reconnect
    private val AUTH_TIMEOUT_MS = 30_000L        // 30s without HELLO_ACK = auth timeout

    /**
     * Guards against concurrent attemptConnect() calls.
     * Set to true before creating WebSocket, cleared in onOpen/onClosed/onFailure.
     * Prevents race when onClosed + onFailure both fire on the same WebSocket,
     * or when connect() is called externally while a connection attempt is in progress.
     */
    private val isConnecting = AtomicBoolean(false)

    /**
     * Monotonic connection generation counter.
     * Incremented on every attemptConnect(). Captured in each WebSocketListener closure.
     *
     * Problem this solves: when attemptConnect() closes the old WebSocket and opens a new
     * one, OkHttp still fires onClosed/onFailure for the OLD socket. At that point `ws`
     * already points to the NEW socket, so the old `webSocket !== ws` check fails to filter
     * stale callbacks → spurious scheduleReconnect() fires → two connections open in parallel.
     *
     * Fix: each listener captures `myId = connectionId.get()` at creation time. Callbacks
     * that arrive after a newer connection has started (connectionId > myId) are silently
     * dropped. Guarantees at most one active reconnect path at any time.
     */
    private val connectionId = AtomicInteger(0)

    @Volatile var isJobActive = false

    /**
     * Exposed connection state for external observers (UI, tests, watchdog).
     */
    @Volatile
    var connectionState: ConnectionState = ConnectionState.DISCONNECTED
        private set

    /**
     * AUTH_FAILED loop prevention.
     * If device is deleted from DB but keeps sending CHALLENGE_RESPONSE, server
     * returns AUTH_FAILED repeatedly → infinite loop. After 3 consecutive failures,
     * log a critical warning and force fresh HELLO with new publicKeyPem on next connect.
     * Counter resets to 0 on any successful HELLO_ACK.
     */
    private var consecutiveAuthFailures = 0

    /**
     * Pending challenge state — prevents duplicate HELLO when reconnecting mid-auth.
     * Set to nonce when CHALLENGE received, cleared on HELLO_ACK or AUTH_FAILED.
     * If non-null and connection drops, next onOpen resumes with CHALLENGE_RESPONSE
     * instead of sending new HELLO.
     */
    private var pendingChallenge: Pair<String, String>? = null  // (deviceId, nonce)

    private val context get() = executor.context
    private val prefs get() = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    fun connect() {
        // Idempotent guard: duplicate connect() calls while already active are ignored.
        // Prevents multiple simultaneous WebSocket connections when Android service
        // lifecycle triggers connect() more than once (e.g. multiple startService() calls).
        if (isActive) {
            Log.w(TAG, "connect() called while already active — ignoring duplicate")
            return
        }
        isActive = true
        connectionState = ConnectionState.CONNECTING
        ensureKeyPair()
        // Reset stale state from any prior session before calling attemptConnect.
        // This is the external entry point — force a fresh start.
        reconnectJob?.cancel()
        isConnecting.set(false)
        attemptConnect()
    }

    fun disconnect() {
        isActive = false
        connectionState = ConnectionState.DISCONNECTED
        heartbeatJob?.cancel()
        keepAliveJob?.cancel()
        reconnectJob?.cancel()
        connectingWatchdogJob?.cancel()
        authTimeoutJob?.cancel()
        ws?.close(1000, "Disconnecting")
        ws = null
    }

    // ─── Connection ───────────────────────────────────────────────────────────

    private fun attemptConnect() {
        if (!isActive) return

        // Guard: only one connection attempt at a time.
        // compareAndSet(false, true) is atomic — only one thread wins.
        if (!isConnecting.compareAndSet(false, true)) {
            Log.w(TAG, "Already connecting — ignoring duplicate attemptConnect()")
            return
        }

        // Stamp this connection attempt with a unique generation ID.
        // All callbacks from this listener will check against this ID at runtime.
        val myId = connectionId.incrementAndGet()

        // Start connecting watchdog — detects stuck in "Connecting..." state
        connectingWatchdogJob?.cancel()
        connectingWatchdogJob = scope.launch {
            delay(CONNECTING_TIMEOUT_MS)
            if (connectionId.get() == myId && isConnecting.get()) {
                Log.e(TAG, "⚠️ Connecting watchdog: stuck for ${CONNECTING_TIMEOUT_MS}ms — forcing reconnect")
                ws?.close(4003, "Connecting timeout")
                isConnecting.set(false)
                scheduleReconnect()
            }
        }

        // Close previous WebSocket before opening a new one.
        ws?.close(1000, "Reconnecting")
        ws = null

        // Resolve target URL: relay config overrides WireGuardManager URL.
        // Path is always /relay for Phase 2 outbound relay connection.
        val targetUrl = buildTargetUrl()
        Log.i(TAG, "Connecting to relay: $targetUrl")
        val request = Request.Builder().url(targetUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Stale guard: a newer connection has already been initiated.
                if (connectionId.get() != myId) {
                    Log.d(TAG, "onOpen from stale connection (gen $myId) — closing")
                    webSocket.close(1000, "stale")
                    return
                }
                // Connection established — clear guards
                isConnecting.set(false)
                connectingWatchdogJob?.cancel()
                connectionOpenedAt = System.currentTimeMillis()
                connectionState = ConnectionState.AUTHENTICATING
                Log.i(TAG, "Connected to relay (connectionId=$connectionId, uptimeSinceInit=${connectionOpenedAt - classInitializedAt}ms)")

                // Reset PONG tracking for new connection
                lastPongReceived = System.currentTimeMillis()
                Log.d(TAG, "PONG tracking reset in onOpen (connectionId=$connectionId)")

                // Start application-level keepalive (replaces OkHttp pingInterval).
                // Sends {"type":"PING"} every 30s — server replies with {"type":"PONG"}.
                // 30s < Cloudflare idle timeout (100s) — keeps connection alive through proxy.
                // Also checks PONG timeout to detect zombie connections.
                keepAliveJob?.cancel()
                keepAliveJob = scope.launch {
                    // Defensive: track when this job started
                    val jobStartedAt = System.currentTimeMillis()
                    
                    while (isActive) {
                        delay(30_000L)
                        if (connectionId.get() != myId) {
                            Log.d(TAG, "keepAliveJob: stale connection (gen $myId, current $connectionId) — stopping")
                            break  // connection replaced — stop
                        }
                        
                        // Defensive check: if job has been running > 2x timeout, something is wrong
                        val jobAge = System.currentTimeMillis() - jobStartedAt
                        if (jobAge > PONG_TIMEOUT_MS * 2) {
                            Log.e(TAG, "⚠️ keepAliveJob age ${jobAge}ms > 2x timeout — forcing reconnect to reset state")
                            webSocket.close(4002, "Job stale")
                            break
                        }
                        
                        // Check PONG timeout BEFORE sending next PING
                        val timeSincePong = System.currentTimeMillis() - lastPongReceived
                        if (timeSincePong > PONG_TIMEOUT_MS) {
                            Log.e(TAG, "⚠️ PONG timeout (${timeSincePong}ms > ${PONG_TIMEOUT_MS}ms) — zombie connection, forcing reconnect")
                            webSocket.close(4002, "PONG timeout")
                            break
                        }
                        
                        webSocket.send("{\"type\":\"PING\"}")
                        Log.d(TAG, "PING sent (last PONG: ${timeSincePong}ms ago, job age: ${jobAge}ms)")
                    }
                }

                sendAuthMessage(webSocket)
                startHeartbeat()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleMessage(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // Stale guard: drop callbacks from any connection older than the current one.
                // This fires when attemptConnect() closes the old WS — those callbacks must
                // not trigger scheduleReconnect(), which would open a third connection.
                if (connectionId.get() != myId) {
                    Log.d(TAG, "onClosed from stale connection (gen $myId) — ignored")
                    return
                }
                Log.i(TAG, "Closed: $code $reason")
                keepAliveJob?.cancel()
                heartbeatJob?.cancel()
                isConnecting.set(false)
                connectionState = ConnectionState.RECONNECTING
                com.phonenetwork.service.AgentForegroundService.instance
                    ?.updateNotification("Connecting…")
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Stale guard: same as onClosed — ping timeout on old WS must not
                // spawn a new reconnect if a newer connection is already in progress.
                if (connectionId.get() != myId) {
                    Log.d(TAG, "onFailure from stale connection (gen $myId) — ignored")
                    return
                }
                Log.e(TAG, "Failure: ${t.message}")
                keepAliveJob?.cancel()
                heartbeatJob?.cancel()
                isConnecting.set(false)
                connectionState = ConnectionState.RECONNECTING
                com.phonenetwork.service.AgentForegroundService.instance
                    ?.updateNotification("Connecting…")
                scheduleReconnect()
            }
        })
        // NOTE: isConnecting stays true until onOpen, onClosed, or onFailure fires.
        // This blocks concurrent attemptConnect() calls during the handshake window.
    }

    // ─── EC Key Pair ──────────────────────────────────────────────────────────

    /**
     * Ensure EC P-256 key pair exists in Android Keystore.
     * Idempotent — no-op if key already exists.
     * Hardware-backed (StrongBox/TEE) when available.
     */
    private fun ensureKeyPair() {
        try {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
            if (keyStore.containsAlias(KEY_ALIAS)) return

            val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            kpg.initialize(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")) // P-256
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false) // background service — no biometrics
                    .build()
            )
            kpg.generateKeyPair()
            Log.i(TAG, "EC P-256 key pair generated in AndroidKeyStore")
        } catch (e: Exception) {
            Log.e(TAG, "Key pair generation failed: ${e.message}")
        }
    }

    /**
     * Export public key in PEM format (SubjectPublicKeyInfo, DER base64 with headers).
     * Node.js crypto.createVerify accepts this format directly.
     */
    fun getPublicKeyPem(): String {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        val certificate = keyStore.getCertificate(KEY_ALIAS)
            ?: throw IllegalStateException("EC key not found in AndroidKeyStore — call ensureKeyPair() first")
        val derBase64 = Base64.encodeToString(certificate.publicKey.encoded, Base64.NO_WRAP)
        return "-----BEGIN PUBLIC KEY-----\n$derBase64\n-----END PUBLIC KEY-----"
    }

    /**
     * Sign raw nonce bytes with EC private key.
     * Input: hex-encoded nonce string → decoded to raw bytes → signed.
     * Output: DER-encoded ECDSA signature, base64-encoded.
     * SHA256withECDSA output is DER (matches what Node.js crypto.createVerify expects).
     */
    private fun signNonce(nonceHex: String): String {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        val privateKey = keyStore.getKey(KEY_ALIAS, null) as PrivateKey
        val nonceBytes = hexToBytes(nonceHex)
        val sig = Signature.getInstance("SHA256withECDSA").also {
            it.initSign(privateKey)
            it.update(nonceBytes)  // sign raw bytes, not hex string
        }
        return Base64.encodeToString(sig.sign(), Base64.NO_WRAP)
    }

    private fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        for (i in 0 until len / 2) {
            data[i] = ((Character.digit(hex[i * 2], 16) shl 4) +
                Character.digit(hex[i * 2 + 1], 16)).toByte()
        }
        return data
    }

    // ─── Register auth (Phase 2: outbound to relay) ───────────────────────────────────

    /**
     * Send registration message to relay server.
     * Auth flow (relay server):
     * 1. Phone sends register { deviceId, authToken, role: "phone", ... }
     * 2. Relay validates authToken, sends registered on success
     * 3. Phone optionally receives CHALLENGE for EC key verification
     * 
     * For backward compatibility, we also handle HELLO_ACK (legacy server).
     */
    private fun sendAuthMessage(webSocket: WebSocket) {
        // Resume pending challenge if connection dropped mid-auth
        pendingChallenge?.let { (deviceId, nonce) ->
            Log.i(TAG, "Resuming pending CHALLENGE_RESPONSE (reconnected mid-auth)")
            try {
                val signature = signNonce(nonce)
                val payload = JSONObject().apply {
                    put("deviceId", deviceId)
                    put("signature", signature)
                }
                send(webSocket, "CHALLENGE_RESPONSE", payload)
                Log.i(TAG, "CHALLENGE_RESPONSE sent (resumed)")
                return
            } catch (e: Exception) {
                Log.w(TAG, "Failed to resume challenge — clearing and sending register")
                pendingChallenge = null
            }
        }

        val imei = getOrReadImei()
        try {
            val publicKeyPem = getPublicKeyPem()
            // Wrap wireguardIp in separate try-catch — EncryptedSharedPreferences can throw
            val wireguardIp = try {
                com.phonenetwork.wireguard.WireGuardManager.getInterfaceAddress(context)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to get wireguardIp: ${e.message}")
                null  // Non-fatal — continue without wireguardIp
            }

            // Get or generate auth token
            val authToken = getOrCreateAuthToken()
            // Get existing deviceId (for reconnects within grace period)
            val existingDeviceId = getDeviceId()
            // Use existing deviceId if available, otherwise use IMEI as provisional id
            val deviceId = existingDeviceId ?: imei

            val payload = JSONObject().apply {
                put("deviceId", deviceId)
                put("authToken", authToken)
                put("role", "phone")
                put("imei", imei)
                put("publicKeyPem", publicKeyPem)
                put("model", android.os.Build.MODEL)
                put("androidVersion", android.os.Build.VERSION.RELEASE)
                put("agentVersion", try {
                    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.0"
                } catch (_: Exception) { "1.0.0" })
                if (wireguardIp != null) put("wireguardIp", wireguardIp)
            }
            send(webSocket, "register", payload)
            Log.i(TAG, "register sent (deviceId=${deviceId.take(6)}…, authToken=${authToken.take(6)}…, wgIp=${wireguardIp ?: "none"})")
            
            // Start auth timeout — detects hung auth (no registered or HELLO_ACK)
            authTimeoutJob?.cancel()
            authTimeoutJob = scope.launch {
                delay(AUTH_TIMEOUT_MS)
                if (getDeviceId() == null || pendingChallenge != null) {
                    Log.e(TAG, "⚠️ Auth timeout: no registered after ${AUTH_TIMEOUT_MS}ms")
                    ws?.close(4004, "Auth timeout")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to prepare register: ${e.message}")
            webSocket.close(1001, "register preparation failed")
        }
    }

    /**
     * Get existing auth token or generate a new one.
     * Auth token sent to relay server for device validation.
     * For Phase 2: uses a simple UUID-based token.
     * In production: should be HMAC-SHA256(deviceId, serverSecret).
     */
    private fun getOrCreateAuthToken(): String {
        prefs.getString(AUTH_TOKEN_KEY, null)?.takeIf { it.isNotBlank() }?.let { return it }
        val token = "at_${UUID.randomUUID()}"
        prefs.edit().putString(AUTH_TOKEN_KEY, token).apply()
        Log.i(TAG, "Generated new auth token: ${token.take(8)}…")
        return token
    }

    // ─── IMEI reading ─────────────────────────────────────────────────────────

    private fun getOrReadImei(): String {
        prefs.getString(IMEI_CACHE_KEY, null)?.takeIf { it.length >= 7 }?.let { return it }
        val imei = readImei()
        prefs.edit().putString(IMEI_CACHE_KEY, imei).apply()
        runCatching { File(context.filesDir, UUID_FILE).writeText(imei) }
        return imei
    }

    private fun readImei(): String {
        var proc: Process? = null
        return try {
            proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "service call iphonesubinfo 1"))
            val output = proc.inputStream.bufferedReader().readText()
            proc.waitFor()
            // Collect all quoted segments across lines, extract digits only, take first 15.
            // Handles both single-line and multi-line hex dump (Android 10 OnePlus format):
            //   '........8.6.7.2.'
            //   '8.7.0.3.7.7.3.9.'
            //   '5.1.8...        '
            // → joinToString → filter digits → "867287037739518"
            val allDigits = Regex("'([^']*)'").findAll(output)
                .map { it.groupValues[1] }
                .joinToString("")
                .filter { it.isDigit() }
                .take(15)
            if (allDigits.length >= 14) {
                Log.i(TAG, "IMEI read via iphonesubinfo (${allDigits.length} digits)")
                allDigits
            } else {
                readImeiFallback()
            }
        } catch (e: Exception) {
            Log.w(TAG, "iphonesubinfo failed: ${e.message}")
            readImeiFallback()
        } finally {
            proc?.inputStream?.close()
            proc?.errorStream?.close()
            proc?.destroy()
        }
    }

    private fun readImeiFallback(): String {
        var proc: Process? = null
        return try {
            proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "getprop ro.serialno"))
            val serial = proc.inputStream.bufferedReader().readText().trim()
            proc.waitFor()
            if (serial.length >= 4 && serial != "unknown") {
                Log.i(TAG, "IMEI fallback: ro.serialno")
                "SN_$serial"
            } else {
                readOrCreatePersistentUuid()
            }
        } catch (e: Exception) {
            Log.w(TAG, "ro.serialno failed: ${e.message}")
            readOrCreatePersistentUuid()
        } finally {
            proc?.inputStream?.close()
            proc?.errorStream?.close()
            proc?.destroy()
        }
    }

    private fun readOrCreatePersistentUuid(): String {
        val file = File(context.filesDir, UUID_FILE)
        if (file.exists()) {
            val uuid = file.readText().trim()
            if (uuid.length >= 7) return uuid
        }
        val androidId = android.provider.Settings.Secure.getString(
            context.contentResolver, android.provider.Settings.Secure.ANDROID_ID
        )
        val uuid = if (!androidId.isNullOrBlank() && androidId != "9774d56d682e549c") {
            "UUID_${UUID.nameUUIDFromBytes("phonenetwork:$androidId".toByteArray())}"
        } else {
            "UUID_${UUID.randomUUID()}"
        }
        Log.i(TAG, "IMEI fallback: generated UUID")
        runCatching { file.writeText(uuid) }
        return uuid
    }

    // ─── Device ID persistence ────────────────────────────────────────────────

    fun getDeviceId(): String? = prefs.getString(DEVICE_ID_KEY, null)
    private fun saveDeviceId(deviceId: String) = prefs.edit().putString(DEVICE_ID_KEY, deviceId).apply()

    // ─── Message handling ─────────────────────────────────────────────────────

    private suspend fun handleMessage(text: String) {
        try {
            val msg = JSONObject(text)
            when (val type = msg.getString("type")) {
                "CHALLENGE" -> {
                    val p        = msg.getJSONObject("payload")
                    val nonce    = p.getString("nonce")
                    val deviceId = p.getString("deviceId")
                    Log.i(TAG, "CHALLENGE received — signing nonce")
                    // Store challenge in case connection drops before CHALLENGE_RESPONSE arrives
                    pendingChallenge = Pair(deviceId, nonce)
                    try {
                        val signature = signNonce(nonce)
                        val payload = JSONObject().apply {
                            put("deviceId", deviceId)
                            put("signature", signature)
                        }
                        send(ws, "CHALLENGE_RESPONSE", payload)
                        Log.i(TAG, "CHALLENGE_RESPONSE sent")
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to sign nonce: ${e.message}")
                        pendingChallenge = null  // clear — can't sign this nonce
                        // Reconnect — key may have been deleted
                        ws?.close(1001, "Signing failed")
                    }
                }

                "registered" -> {
                    // Relay server confirmed registration
                    authTimeoutJob?.cancel()
                    val p = msg.getJSONObject("payload")
                    val deviceId = p.optString("deviceId", getDeviceId() ?: "unknown")
                    saveDeviceId(deviceId)
                    consecutiveAuthFailures = 0
                    pendingChallenge = null
                    connectionState = ConnectionState.CONNECTED
                    if (System.currentTimeMillis() - connectionOpenedAt > 30_000L) {
                        reconnectDelay = 1_000L
                        rapidReconnectCount = 0
                    }
                    Log.i(TAG, "registered — authenticated. deviceId=$deviceId")
                    com.phonenetwork.service.AgentForegroundService.instance
                        ?.updateNotification("Connected")
                    onConnected(deviceId)
                }

                "HELLO_ACK" -> {
                    // Backward compat: legacy server sends HELLO_ACK
                    authTimeoutJob?.cancel()
                    val p = msg.getJSONObject("payload")
                    val deviceId = p.getString("deviceId")
                    saveDeviceId(deviceId)
                    consecutiveAuthFailures = 0
                    pendingChallenge = null
                    connectionState = ConnectionState.CONNECTED
                    if (System.currentTimeMillis() - connectionOpenedAt > 30_000L) {
                        reconnectDelay = 1_000L
                        rapidReconnectCount = 0
                    }
                    Log.i(TAG, "HELLO_ACK (legacy) — authenticated. deviceId=$deviceId")
                    com.phonenetwork.service.AgentForegroundService.instance
                        ?.updateNotification("Connected")
                    onConnected(deviceId)
                }

                "error" -> {
                    // Relay server error (invalid auth token, etc.)
                    val errMsg = msg.optString("message", "Unknown relay error")
                    Log.e(TAG, "Relay error: $errMsg")
                    com.phonenetwork.service.AgentForegroundService.instance
                        ?.updateNotification("Relay error")
                    ws?.close(4005, "Relay error: $errMsg")
                }

                "HELLO_REJECT" -> {
                    val p    = msg.getJSONObject("payload")
                    val code = p.optString("code", "")
                    Log.w(TAG, "HELLO_REJECT [$code]: ${p.optString("reason")}")

                    when (code) {
                        "BLOCKED" -> {
                            Log.e(TAG, "Device blocked. Stopping.")
                            isActive = false
                            com.phonenetwork.service.AgentForegroundService.instance
                                ?.updateNotification("Blocked by admin")
                            onRevoked()
                        }
                        "AWAITING_APPROVAL" -> {
                            Log.i(TAG, "Pending admin approval")
                            com.phonenetwork.service.AgentForegroundService.instance
                                ?.updateNotification("Waiting for approval…")
                            // scheduleReconnect() via onClosed
                        }
                        "AUTH_FAILED" -> {
                            consecutiveAuthFailures++
                            pendingChallenge = null  // challenge consumed/invalid — don't retry with same nonce
                            Log.w(TAG, "AUTH_FAILED ($consecutiveAuthFailures/3) — challenge verification error")
                            if (consecutiveAuthFailures >= 3) {
                                // Device likely deleted from DB or key mismatch.
                                // Clear cached IMEI to force fresh registration on next connect.
                                Log.w(TAG, "3 consecutive AUTH_FAILED — clearing IMEI cache, forcing re-registration")
                                prefs.edit()
                                    .remove(IMEI_CACHE_KEY)
                                    .remove(DEVICE_ID_KEY)
                                    .apply()
                                consecutiveAuthFailures = 0
                                com.phonenetwork.service.AgentForegroundService.instance
                                    ?.updateNotification("Auth failed — re-registering…")
                            } else {
                                com.phonenetwork.service.AgentForegroundService.instance
                                    ?.updateNotification("Auth failed — retrying…")
                            }
                            // scheduleReconnect() via onClosed
                        }
                        else -> Log.w(TAG, "Unknown reject code: $code")
                    }
                }

                "JOB_DISPATCH" -> {
                    val jobPayload = msg.getJSONObject("payload")
                    scope.launch {
                        isJobActive = true
                        try {
                            executor.execute(jobPayload,
                                onResult = { result ->
                                    Log.i(TAG, "Sending JOB_RESULT for ${result.optString("jobId")}")
                                    send(ws, "JOB_RESULT", result)
                                    Log.i(TAG, "JOB_RESULT sent for ${result.optString("jobId")}")
                                }
                            )
                        } catch (e: Exception) {
                            Log.e(TAG, "Unhandled exception in execute(): ${e.message}")
                            val fallback = JSONObject().apply {
                                put("jobId",      jobPayload.optString("jobId", "unknown"))
                                put("status",     "failed")
                                put("error",      e.message ?: "Unhandled executor exception")
                                put("durationMs", 0)
                                put("output",     JSONObject.NULL)
                                put("verification", JSONObject().apply {
                                    put("verified", false); put("verifiedBy", "none")
                                    put("cascadeLevelsUsed", 0); put("confidence", 0.0)
                                    put("llmTokensUsed", 0); put("verificationTimeMs", 0)
                                })
                            }
                            send(ws, "JOB_RESULT", fallback)
                        } finally {
                            isJobActive = false
                        }
                    }
                }

                "VISION_RESULT" -> {
                    visionClient.handleResult(msg.getJSONObject("payload"))
                }

                "WG_CONFIG" -> {
                    val p = msg.getJSONObject("payload")
                    val configText = p.getString("config")

                    // Always save config — even if tunnel is active, config might have changed
                    com.phonenetwork.wireguard.WireGuardManager.saveConfig(context, configText)
                    Log.i(TAG, "WG_CONFIG received — config saved")

                    // If tunnel already active, restart it with new config
                    if (com.phonenetwork.wireguard.WireGuardManager.isActive()) {
                        Log.i(TAG, "Tunnel active — restarting with new config")
                        com.phonenetwork.wireguard.WireGuardManager.stopTunnel()
                        val started = com.phonenetwork.wireguard.WireGuardManager.startTunnel(context)
                        Log.i(TAG, "Tunnel restarted: $started")
                        val result = JSONObject().apply {
                            put("deviceId", getDeviceId())
                            put("success", started)
                            put("wireguardIp", com.phonenetwork.wireguard.WireGuardManager.getInterfaceAddress(context) ?: "unknown")
                        }
                        send(ws, "WG_CONFIG_ACK", result)
                        return@handleMessage
                    }

                    // Initialize GoBackend if not yet done
                    com.phonenetwork.wireguard.WireGuardManager.initBackend(context)

                    // Auto-grant VPN permission via root before starting tunnel
                    try {
                        val proc = Runtime.getRuntime().exec(arrayOf(
                            "su", "-c",
                            "appops set ${context.packageName} ACTIVATE_VPN allow"
                        ))
                        val exitCode = proc.waitFor()
                        proc.inputStream.close()
                        proc.errorStream.close()
                        proc.destroy()
                        if (exitCode == 0) {
                            Log.i(TAG, "VPN permission auto-granted via root ✓")
                        } else {
                            Log.w(TAG, "VPN auto-grant failed (exit=$exitCode)")
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "VPN auto-grant failed: ${e.message}")
                    }

                    // Start tunnel using GoBackend
                    scope.launch {
                        try {
                            val started = com.phonenetwork.wireguard.WireGuardManager.startTunnel(context)
                            Log.i(TAG, "WireGuard tunnel started: $started")

                            // Report back
                            val result = JSONObject().apply {
                                put("deviceId", getDeviceId())
                                put("success", started)
                                put("wireguardIp", com.phonenetwork.wireguard.WireGuardManager.getInterfaceAddress(context) ?: "unknown")
                            }
                            send(ws, "WG_CONFIG_ACK", result)

                            // Force reconnect through WG tunnel only if not already on local URL
                            if (started) {
                                val localUrl = com.phonenetwork.wireguard.WireGuardManager.SERVER_WS_URL
                                val targetUrl = buildTargetUrl()
                                if (targetUrl != localUrl && com.phonenetwork.wireguard.WireGuardManager.getServerUrl() == localUrl) {
                                    Log.i(TAG, "WG tunnel active — forcing reconnect to local server URL")
                                    delay(2000)  // Give WG tunnel time to stabilize
                                    ws?.close(1000, "Switching to WG tunnel")
                                } else {
                                    Log.i(TAG, "WG tunnel active — already on local URL, no reconnect needed")
                                }
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "WireGuard start failed: ${e.message}")
                            val result = JSONObject().apply {
                                put("deviceId", getDeviceId())
                                put("success", false)
                                put("error", e.message)
                            }
                            send(ws, "WG_CONFIG_ACK", result)
                        }
                    }
                }

                "CLOAK_CONFIG" -> {
                    // Deprecated — cloak functionality removed, ignore message silently
                    Log.d(TAG, "CLOAK_CONFIG received but ignored (deprecated)")
                }

                "KILL_SWITCH" -> {
                    val payload = msg.optJSONObject("payload")
                    val reason  = payload?.optString("reason") ?: "Server kill switch"
                    Log.w(TAG, "⛔ KILL_SWITCH received: $reason")
                    isJobActive = false
                    executor.cancelCurrentJob(reason)
                    if (reason.contains("revoked", ignoreCase = true)) {
                        isActive = false
                        com.phonenetwork.service.AgentForegroundService.instance
                            ?.updateNotification("Revoked")
                        onRevoked()
                    }
                    ws?.close(1001, "Kill switch: $reason")
                }

                "OTA_UPDATE" -> {
                    val p = msg.getJSONObject("payload")
                    val apkUrl = p.getString("apkUrl")
                    val sha256 = p.getString("apkSha256")
                    val signature = p.getString("apkSignature")
                    val versionCode = p.getInt("versionCode")
                    val version = p.optString("version", "?")
                    Log.i(TAG, "OTA_UPDATE received — downloading v$version")
                    com.phonenetwork.service.AgentForegroundService.instance
                        ?.updateNotification("Updating to v$version…")
                    scope.launch {
                        try {
                            val otaInstaller = com.phonenetwork.ota.OtaInstaller(context)
                            otaInstaller.downloadVerifyInstall(apkUrl, sha256, signature, versionCode, forceDowngrade = false)
                            Log.i(TAG, "OTA install complete — app will restart")
                        } catch (e: Exception) {
                            Log.e(TAG, "OTA install failed: ${e.message}")
                            com.phonenetwork.service.AgentForegroundService.instance
                                ?.updateNotification("Update failed")
                        }
                    }
                }

                "PING" -> Log.d(TAG, "PING received")
                "PONG" -> {
                    val now = System.currentTimeMillis()
                    val gap = now - lastPongReceived
                    lastPongReceived = now
                    Log.d(TAG, "PONG received (gap: ${gap}ms, connectionId=$connectionId)")
                }

                else -> Log.w(TAG, "Unknown message type: $type")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Message handling error: ${e.message}")
        }
    }

    // ─── Heartbeat ────────────────────────────────────────────────────────────

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                val interval = if (isJobActive) HEARTBEAT_ACTIVE_MS else HEARTBEAT_IDLE_MS
                delay(interval)
                sendHeartbeat()
            }
        }
    }

    private fun sendHeartbeat() {
        val deviceId = getDeviceId() ?: return  // no heartbeat until authenticated
        val health = healthMonitor.getHealth()
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("health", health.toJson())
        }
        send(ws, "HEARTBEAT", payload)
    }

    // ─── Reconnect with exponential backoff + jitter ─────────────────────────

    /**
     * Reconnect with exponential backoff starting at 1s, doubling each time,
     * capped at 60s, with ±30% jitter added each cycle.
     * 
     * Phase 2: Phone initiates outbound WebSocket to relay.
     * If connection drops, phone automatically reconnects to relay.
     * Relay keeps session in grace period (30s) for seamless resume.
     */
    private fun scheduleReconnect() {
        if (!isActive) return
        // Rapid reconnect breaker — detect unstable connections
        if (connectionOpenedAt > 0 && System.currentTimeMillis() - connectionOpenedAt < 10_000L) {
            rapidReconnectCount++
            if (rapidReconnectCount >= 5) {
                Log.w(TAG, "⚠️ Rapid reconnect detected ($rapidReconnectCount times) — forcing 2min cooldown")
                reconnectDelay = 120_000L
                rapidReconnectCount = 0
            }
        } else if (connectionOpenedAt > 0 && System.currentTimeMillis() - connectionOpenedAt > 60_000L) {
            rapidReconnectCount = 0
        }
        // Cancel any existing pending reconnect before scheduling a new one.
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            val delayMs = reconnectDelay
            Log.i(TAG, "Reconnecting in ${delayMs}ms (backoff, attempt=$rapidReconnectCount, next=${minOf(reconnectDelay * 2, MAX_RECONNECT_DELAY)}ms)…")
            delay(delayMs)
            if (!isActive) return@launch
            // Exponential backoff: double each time, cap at MAX_RECONNECT_DELAY
            // Add ±30% jitter to prevent thundering herd when many phones reconnect
            val jitter = (reconnectDelay * 0.3 * Random.nextDouble()).toLong()
            reconnectDelay = minOf(reconnectDelay * 2, MAX_RECONNECT_DELAY) + jitter
            attemptConnect()
        }
    }

    // ─── Send helpers ─────────────────────────────────────────────────────────

    private fun send(webSocket: WebSocket?, type: String, payload: JSONObject) {
        webSocket?.let {
            val msg = JSONObject().apply {
                put("type", type)
                put("payload", payload)
                put("ts", System.currentTimeMillis())
            }
            it.send(msg.toString())
        }
    }

    /**
     * Send a health report to the server (used by WifiWatchdog and other monitors).
     * Wraps the report in a HEALTH_REPORT message type.
     */
    fun sendHealthReport(report: JSONObject) {
        val deviceId = getDeviceId() ?: return  // no report until authenticated
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("report", report)
        }
        send(ws, "HEALTH_REPORT", payload)
        Log.i(TAG, "Health report sent: ${report.optString("type", "unknown")}")
    }

    // ─── URL resolution ───────────────────────────────────────────────────────

    /**
     * Build the target WebSocket URL.
     * If relay.host / relay.port are configured, use them (outbound to relay).
     * Path is always /relay for the relay server.
     * Otherwise fall back to WireGuardManager (local WG tunnel if active, else public relay).
     * 
     * Phase 2: Phone initiates outbound connection to relay.
     * This solves NAT/firewall traversal — phone is client, relay is server.
     */
    private fun buildTargetUrl(): String {
        val host = relayHost
        val port = relayPort
        return if (host != null && port != null) {
            // Direct relay connection — use wss for port 18792 (TLS)
            val scheme = if (port == 18792) "wss" else "ws"
            "$scheme://$host:$port/relay"
        } else {
            // Fall back to WireGuardManager URL — use /relay path
            val baseUrl = com.phonenetwork.wireguard.WireGuardManager.getServerUrl()
            baseUrl.replaceFirst(Regex("/ws$"), "/relay")
        }
    }
}
