package com.phonenetwork.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import com.phonenetwork.accessibility.AgentAccessibilityService
import com.phonenetwork.anti_detection.DnsBackgroundService
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.capture.CaptureController
import com.phonenetwork.connection.DirectWsClient
import com.phonenetwork.connection.WifiWatchdog
import com.phonenetwork.executor.JobExecutor
import com.phonenetwork.health.HealthMonitor
import com.phonenetwork.nostr.DefaultNostrMessageHandler
import com.phonenetwork.nostr.EnrollmentStore
import com.phonenetwork.nostr.NostrClient
import com.phonenetwork.nostr.NostrEventKinds
import com.phonenetwork.nostr.NostrConfig
import com.phonenetwork.nostr.NostrMessageHandler
import com.phonenetwork.ota.OtaInstaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import rust.nostr.sdk.Event

/**
 * AgentForegroundService — sticky foreground service, owns all agent components.
 *
 * DI strategy: manual construction (no Hilt) — flat dependency graph,
 * components are singletons within service lifetime.
 *
 * Lifecycle:
 *   onCreate()        → create NotificationChannel
 *   onStartCommand()  → startForeground, init components, connect Nostr
 *   onDestroy()       → disconnect Nostr, stop DNS, cancel scope
 *
 * Connectivity state is reflected in the notification text.
 *
 * AccessibilityService integration:
 *   AgentAccessibilityService is a separate component; it registers itself here via
 *   [registerAccessibilityService] when connected. JobExecutor then routes automation
 *   through it. Until registered, gesture-based actions will fail gracefully.
 */
class AgentForegroundService : Service() {

    companion object {
        const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID      = "phone_network_agent"
        const val CHANNEL_NAME    = "Phone Network Agent"
        private const val TAG     = "PhoneNet/FgService"

        @Volatile var instance: AgentForegroundService? = null

        fun start(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java)
            context.stopService(intent)
        }

        /** Called by AgentAccessibilityService.onServiceConnected() */
        fun registerAccessibilityService(svc: AgentAccessibilityService) {
            pendingA11y = svc
            instance?.onAccessibilityServiceConnected(svc)
        }

        // Holds A11y reference if it connected before AgentForegroundService started.
        var pendingA11y: AgentAccessibilityService? = null
    }

    // ─── Component lifetime tied to service ───────────────────────────────────
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var captureCtrl:   CaptureController
    private lateinit var healthMonitor: HealthMonitor
    private lateinit var otaInstaller:  OtaInstaller
    private lateinit var automation:    AutomationController
    private lateinit var jobExecutor:   JobExecutor
    private lateinit var nostrClient:    NostrClient
    private          var directWsClient: DirectWsClient? = null
    private lateinit var wifiWatchdog:   WifiWatchdog

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "Service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "Service starting (startId=$startId)")

        // Must call startForeground() within 5s — do it immediately
        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"))

        // Build dependency graph — manual DI
        initComponents()

        // Start DNS background traffic diversification
        DnsBackgroundService.start(serviceScope)

        // Start WiFi watchdog — monitors and recovers stuck WiFi connections
        wifiWatchdog = WifiWatchdog(applicationContext, serviceScope) { report ->
            if (::nostrClient.isInitialized) {
                serviceScope.launch {
                    try {
                        nostrClient.sendHeartbeat(report)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to send WiFi health report: ${e.message}")
                    }
                }
            }
        }
        wifiWatchdog.start()

        // Enable AccessibilityService via root (Magisk) — no user interaction needed
        enableAccessibilityServiceViaRoot()

        // Wire A11y if it already connected before this service started (race condition fix)
        pendingA11y?.let { onAccessibilityServiceConnected(it) }

        // Check enrollment — if not enrolled, use hardcoded defaults (auto-discovery)
        val enrollment = EnrollmentStore.getEnrollment(applicationContext)
        if (enrollment == null) {
            Log.i(TAG, "No enrollment — using default config (auto-discovery mode)")
            updateNotification("Connecting (auto-discovery)...")
        }

        // Connect to Nostr relays
        serviceScope.launch {
            nostrClient.connect()
            Log.i(TAG, "NostrClient started")
        }

        // Start DirectWs transport if configured and enabled
        serviceScope.launch {
            try {
                val dwc = DirectWsClient(
                    context    = applicationContext,
                    executor   = jobExecutor,
                    scope      = serviceScope,
                    onConnected = { deviceId ->
                        Log.i(TAG, "DirectWs connected: deviceId=$deviceId")
                        updateNotification("Connected (DirectWs)")
                    },
                    onDisconnected = {
                        Log.i(TAG, "DirectWs disconnected")
                    },
                )
                directWsClient = dwc
                if (dwc.isEnabled) {
                    dwc.connect()
                    Log.i(TAG, "DirectWsClient started")
                } else {
                    Log.d(TAG, "DirectWs transport disabled — skipped")
                }
            } catch (e: Exception) {
                Log.w(TAG, "DirectWsClient init failed: ${e.message}")
            }
        }

        return START_STICKY  // Android restarts service after OOM kill
    }

    override fun onDestroy() {
        Log.i(TAG, "Service stopping")
        instance = null

        if (::nostrClient.isInitialized) {
            serviceScope.launch {
                try { nostrClient.disconnect() } catch (e: Exception) {
                    Log.w(TAG, "Disconnect error: ${e.message}")
                }
            }
        }
        directWsClient?.disconnect()
        if (::wifiWatchdog.isInitialized)  wifiWatchdog.stop()
        DnsBackgroundService.stop()
        serviceScope.cancel()

        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ─── Dependency construction ──────────────────────────────────────────────

    private fun enableAccessibilityServiceViaRoot() {
        val component = "$packageName/${AgentAccessibilityService::class.java.name}"
        try {
            val current = Settings.Secure.getString(
                contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            if (component in current) {
                Log.i(TAG, "A11y service already enabled")
                return
            }
            val newList = if (current.isEmpty()) component else "$current:$component"
            val proc = Runtime.getRuntime().exec(arrayOf(
                "su", "-c",
                "settings put secure enabled_accessibility_services \"$newList\" " +
                "&& settings put secure accessibility_enabled 1"
            ))
            val exitCode = proc.waitFor()
            if (exitCode == 0) {
                Log.i(TAG, "A11y service enabled via root (exitCode=0)")
            } else {
                Log.w(TAG, "su command exited with code $exitCode")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to enable a11y via root: ${e.message}")
        }
    }

    private fun initComponents() {
        val ctx = applicationContext
        val enrollment = EnrollmentStore.getEnrollment(ctx)

        captureCtrl   = CaptureController()
        healthMonitor = HealthMonitor(ctx)
        otaInstaller  = OtaInstaller(ctx)

        // AutomationController: AccessibilityService may not be connected yet —
        // it will be injected via registerAccessibilityService() when ready.
        automation = AutomationController(service = null)

        jobExecutor = JobExecutor(
            context      = ctx,
            automation   = automation,
            capture      = captureCtrl,
            otaInstaller = otaInstaller,
        )

        // Build NostrClient — use enrollment data or hardcoded defaults (auto-discovery)
        val relayUrls    = enrollment?.relayUrls?.takeIf { it.isNotEmpty() } ?: NostrConfig.DEFAULT_RELAYS
        val serverPubkey = enrollment?.serverPubkey?.takeIf { it.isNotEmpty() } ?: NostrConfig.SERVER_PUBKEY
        val deviceId     = enrollment?.deviceId ?: android.provider.Settings.Secure.getString(
            ctx.contentResolver, android.provider.Settings.Secure.ANDROID_ID
        )

        nostrClient = NostrClient(
            context      = ctx,
            relayUrls    = relayUrls,
            serverPubkey = serverPubkey,
            deviceId     = deviceId,
            scope        = serviceScope
        )

        // Wire message handler: routes incoming Nostr events to service components
        nostrClient.messageHandler = object : DefaultNostrMessageHandler() {

            override suspend fun onJobDispatch(payload: JSONObject, rawEvent: Event) {
                Log.i(TAG, "JOB_DISPATCH received: ${payload.optString("jobId", "?").take(8)}")
                jobExecutor.execute(payload) { result ->
                    serviceScope.launch {
                        try {
                            nostrClient.sendJobResult(
                                jobId   = result.getString("jobId"),
                                result  = result,
                                success = result.optString("status") == "completed"
                            )
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to send JOB_RESULT: ${e.message}")
                        }
                    }
                }
            }

            override suspend fun onKillSwitch(payload: JSONObject, rawEvent: Event) {
                val reason = payload.optString("reason", "unspecified")
                Log.w(TAG, "KILL_SWITCH received: $reason — stopping service")
                updateNotification("Kill switch activated")
                jobExecutor.cancelCurrentJob(reason)
                stopSelf()
            }

            override suspend fun onOta(payload: JSONObject, rawEvent: Event) {
                val version = payload.optString("version", "?")
                val apkUrl  = payload.optString("apkUrl", "")
                Log.i(TAG, "OTA received: version=$version")
                try {
                    otaInstaller.downloadVerifyInstall(
                        apkUrl        = apkUrl,
                        expectedSha256 = payload.getString("apkSha256"),
                        signature     = payload.getString("apkSignature"),
                        versionCode   = payload.getInt("versionCode"),
                        forceDowngrade = payload.optBoolean("forceDowngrade", false)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "OTA install failed: ${e.message}")
                }
            }

            override suspend fun onDeviceAck(payload: JSONObject, rawEvent: Event) {
                Log.i(TAG, "DEVICE_ACK — device approved by server")
                updateNotification("Connected ✓")
                // Notify WiFi watchdog about reconnection
                if (::wifiWatchdog.isInitialized) {
                    wifiWatchdog.onReconnected()
                }
            }

            override suspend fun onDeviceReject(payload: JSONObject, rawEvent: Event) {
                val reason = payload.optString("reason", "unspecified")
                Log.w(TAG, "DEVICE_REJECT: $reason — stopping service")
                updateNotification("Blocked — contact admin")
                stopSelf()
            }
        }

        // Start periodic heartbeat (30s interval)
        nostrClient.startHeartbeat {
            healthMonitor.getHealth().toJson()
        }
    }

    // ─── AccessibilityService integration ────────────────────────────────────

    private fun onAccessibilityServiceConnected(svc: AgentAccessibilityService) {
        Log.i(TAG, "AccessibilityService connected — wiring to executor")
        if (::jobExecutor.isInitialized) {
            jobExecutor.setAccessibilityService(svc)
            // Replace stub AutomationController with live one in BOTH places
            automation = AutomationController(service = svc)
            jobExecutor.setAutomationController(automation)
            Log.i(TAG, "AutomationController wired to live AccessibilityService")
        } else {
            Log.w(TAG, "jobExecutor not initialized yet — A11y wiring deferred")
        }
        updateNotification("Connected")
    }

    // ─── Notifications ────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW  // No sound/popup, stays in tray
        ).apply {
            description = "Phone Network Agent — keeps device connected to control server"
            setShowBadge(false)
        }
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    fun updateNotification(status: String) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, buildNotification(status))
    }

    private fun buildNotification(status: String): Notification =
        Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Phone Network Agent")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
}
