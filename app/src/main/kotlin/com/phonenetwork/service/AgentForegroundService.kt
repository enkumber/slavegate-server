package com.phonenetwork.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import com.phonenetwork.accessibility.AgentAccessibilityService
import com.phonenetwork.anti_detection.DnsBackgroundService
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.auth.TokenStore
import com.phonenetwork.capture.CaptureController
import com.phonenetwork.connection.NetworkLockManager
import com.phonenetwork.connection.WifiWatchdog
import com.phonenetwork.connection.WsClient
import com.phonenetwork.executor.JobExecutor
import com.phonenetwork.health.HealthMonitor
import com.phonenetwork.ota.OtaInstaller
import com.phonenetwork.wireguard.WireGuardManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * AgentForegroundService — sticky foreground service, owns all agent components.
 *
 * DI strategy: manual construction (no Hilt) — flat dependency graph,
 * components are singletons within service lifetime.
 *
 * Lifecycle:
 *   onCreate()        → create NotificationChannel, NetworkLockManager
 *   onStartCommand()  → startForeground, acquire locks, init components, connect WS
 *   onDestroy()       → disconnect WS, stop DNS, release locks, cancel scope
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

        /** Singleton ref — used by WsClient to update notification text */
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

    private lateinit var networkLocks:  NetworkLockManager
    private lateinit var tokenStore:    TokenStore
    private lateinit var captureCtrl:   CaptureController
    private lateinit var healthMonitor: HealthMonitor
    private lateinit var otaInstaller:  OtaInstaller
    private lateinit var automation:    AutomationController
    private lateinit var jobExecutor:   JobExecutor
    private lateinit var wsClient:      WsClient
    private lateinit var wifiWatchdog:  WifiWatchdog

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "Service created")
        networkLocks = NetworkLockManager(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "Service starting (startId=$startId)")

        // Must call startForeground() within 5s — do it immediately
        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"))

        // Acquire WiFi + CPU locks
        networkLocks.acquire()

        // Build dependency graph — manual DI, no framework needed
        initComponents()

        // Start DNS background traffic diversification (A4)
        DnsBackgroundService.start(serviceScope)

        // Start WiFi watchdog — monitors and recovers stuck WiFi connections
        wifiWatchdog = WifiWatchdog(applicationContext, serviceScope) { report ->
            if (::wsClient.isInitialized) {
                wsClient.sendHealthReport(report)
            }
        }
        wifiWatchdog.start()

        // Enable AccessibilityService via root (Magisk) — no user interaction needed
        enableAccessibilityServiceViaRoot()

        // Wire A11y if it already connected before this service started (race condition fix)
        pendingA11y?.let { onAccessibilityServiceConnected(it) }

        // Start WireGuard tunnel (GoBackend) before WebSocket connection
        serviceScope.launch {
            startWireGuard()
            // Connect WebSocket after WireGuard is up (or failed — still connect to relay)
            wsClient.connect()
            Log.i(TAG, "WsClient started → ${getServerUrl()}")
        }

        return START_STICKY  // Android restarts service after OOM kill
    }

    override fun onDestroy() {
        Log.i(TAG, "Service stopping")
        instance = null

        if (::wsClient.isInitialized)      wsClient.disconnect()
        if (::wifiWatchdog.isInitialized)  wifiWatchdog.stop()
        // Stop WireGuard tunnel (GoBackend)
        WireGuardManager.stopTunnel()
        DnsBackgroundService.stop()
        if (::networkLocks.isInitialized)  networkLocks.release()
        serviceScope.cancel()

        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ─── Dependency construction ──────────────────────────────────────────────

    private fun enableAccessibilityServiceViaRoot() {
        // Use build variant-aware component name (debug vs release package suffix)
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
            // Double-quote the value to handle colons safely in shell
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

        // TokenStore kept for deviceId persistence compatibility (other components may use it)
        tokenStore    = TokenStore(ctx)
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

        wsClient = WsClient(
            relayHost     = null,  // set relay.host in config to override WireGuardManager URL
            relayPort     = null,  // set relay.port in config to override WireGuardManager URL
            executor      = jobExecutor,
            healthMonitor = healthMonitor,
            scope         = serviceScope,
            onRevoked     = {
                Log.w(TAG, "Device revoked — stopping service")
                updateNotification("Blocked — contact admin")
                stopSelf()
            },
            onConnected   = { deviceId ->
                Log.i(TAG, "Authenticated. deviceId=$deviceId")
                // Notify WiFi watchdog — sends accumulated event history from offline period
                if (::wifiWatchdog.isInitialized) {
                    wifiWatchdog.onReconnected()
                }
            }
        )
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

    // ─── WireGuard ──────────────────────────────────────────────────────────────

    private suspend fun startWireGuard() {
        updateNotification("Starting WireGuard tunnel…")

        // Initialize GoBackend if not yet done
        WireGuardManager.initBackend(this)

        // Check if we have saved config from QR scan
        if (!WireGuardManager.hasConfig(this)) {
            Log.e(TAG, "No WireGuard config — need QR scan first")
            updateNotification("No WG config — scan QR in app")
            return
        }

        // Check if already active
        if (WireGuardManager.isActive()) {
            Log.i(TAG, "WireGuard tunnel already active")
            updateNotification("WG connected")
            return
        }

        // Check VPN permission — auto-grant via root if needed
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent != null) {
            Log.w(TAG, "VPN permission not granted — attempting auto-grant via root")
            try {
                val proc = Runtime.getRuntime().exec(arrayOf(
                    "su", "-c",
                    "appops set $packageName ACTIVATE_VPN allow"
                ))
                val exitCode = proc.waitFor()
                proc.inputStream.close()
                proc.errorStream.close()
                proc.destroy()
                if (exitCode == 0) {
                    Log.i(TAG, "VPN permission auto-granted via root ✓")
                } else {
                    Log.e(TAG, "VPN auto-grant failed (exit=$exitCode)")
                    updateNotification("VPN permission denied")
                    return
                }
            } catch (e: Exception) {
                Log.e(TAG, "VPN auto-grant failed: ${e.message}")
                updateNotification("VPN permission denied")
                return
            }
        }

        // Start tunnel using GoBackend
        val success = WireGuardManager.startTunnel(this)
        if (success) {
            Log.i(TAG, "WireGuard tunnel started successfully")
            updateNotification("WG connected")
        } else {
            Log.e(TAG, "WireGuard tunnel failed to start")
            updateNotification("WG failed — check config")
        }
    }

    // ─── Config ───────────────────────────────────────────────────────────────

    private fun getServerUrl(): String = WireGuardManager.getServerUrl()
}
