package com.phonenetwork.connection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * WifiWatchdog — monitors WiFi connection state and forces reconnection when stuck.
 *
 * Problem: WiFi adapter sometimes enters a "zombie" state where it's enabled but
 * not connected to any network, and won't auto-reconnect. This breaks the WebSocket
 * connection and leaves the device unreachable.
 *
 * Solution: Periodically check WiFi state. If WiFi is ON but disconnected for >2 minutes,
 * toggle it OFF→ON to force reconnection. Never give up — keep retrying forever.
 *
 * Edge cases handled:
 * - Mobile data fallback: Don't toggle if mobile data is active (connection still works)
 * - User action cooldown: Don't toggle within 5 min of user manually disconnecting
 * - Battery Saver: Respect battery saver mode (skip toggle)
 *
 * Recovery reporting:
 * - All events logged locally during offline period
 * - When WebSocket reconnects → call onReconnected() to send history to server
 *
 * Usage:
 *   val watchdog = WifiWatchdog(context, scope) { report -> wsClient.sendHealthReport(report) }
 *   watchdog.start()
 *   // When WebSocket reconnects:
 *   watchdog.onReconnected()
 */
class WifiWatchdog(
    private val context: Context,
    private val scope: CoroutineScope,
    private val onHealthReport: ((JSONObject) -> Unit)? = null
) {
    companion object {
        private const val TAG = "PhoneNet/WifiWatchdog"
        
        // Check interval
        private const val CHECK_INTERVAL_MS = 60_000L  // 60 seconds
        
        // Disconnect threshold before toggle
        private const val DISCONNECT_THRESHOLD_MS = 2 * 60 * 1000L  // 2 minutes
        
        // Cooldown after user action (manual disconnect)
        private const val USER_ACTION_COOLDOWN_MS = 5 * 60 * 1000L  // 5 minutes
        
        // Toggle delay (WiFi OFF → wait → WiFi ON)
        private const val TOGGLE_DELAY_MS = 2500L  // 2.5 seconds
        
        // Max events to keep in history (prevent memory bloat)
        private const val MAX_EVENT_HISTORY = 100
    }
    
    private val wifiManager: WifiManager by lazy {
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    }
    
    private val connectivityManager: ConnectivityManager by lazy {
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    }
    
    private val powerManager: PowerManager by lazy {
        context.getSystemService(Context.POWER_SERVICE) as PowerManager
    }
    
    private var monitorJob: Job? = null
    
    // Tracking state
    private val disconnectedSinceMs = AtomicLong(0L)
    private val lastUserActionMs = AtomicLong(0L)
    private var lastConnectedState = true
    
    // Stats for health reports
    private var totalToggles = 0
    private var successfulReconnects = 0
    private var failedToggles = 0
    
    // Event history for offline period reporting
    private val eventHistory = mutableListOf<JSONObject>()
    private val eventHistoryLock = Any()
    
    /**
     * Start the WiFi watchdog monitoring loop.
     */
    fun start() {
        if (monitorJob?.isActive == true) {
            Log.w(TAG, "Watchdog already running")
            return
        }
        
        Log.i(TAG, "Starting WiFi watchdog (interval=${CHECK_INTERVAL_MS}ms, threshold=${DISCONNECT_THRESHOLD_MS}ms)")
        
        // Register for WiFi state changes to detect user actions
        registerUserActionDetector()
        
        // Start monitoring loop
        monitorJob = scope.launch {
            while (isActive) {
                try {
                    checkAndRecover()
                } catch (e: Exception) {
                    Log.e(TAG, "Error in watchdog loop: ${e.message}", e)
                }
                delay(CHECK_INTERVAL_MS)
            }
        }
    }
    
    /**
     * Stop the WiFi watchdog.
     */
    fun stop() {
        Log.i(TAG, "Stopping WiFi watchdog")
        monitorJob?.cancel()
        monitorJob = null
        unregisterUserActionDetector()
    }
    
    /**
     * Check WiFi state and trigger recovery if needed.
     * Never gives up — keeps retrying forever until connection is restored.
     */
    private suspend fun checkAndRecover() {
        val wifiState = getWifiState()
        
        Log.d(TAG, "Check: wifiEnabled=${wifiState.wifiEnabled}, wifiConnected=${wifiState.wifiConnected}, " +
                   "mobileActive=${wifiState.mobileDataActive}, batterySaver=${wifiState.batterySaverOn}")
        
        // Update connected state tracking
        if (wifiState.wifiConnected) {
            if (!lastConnectedState) {
                Log.i(TAG, "WiFi reconnected after recovery")
                successfulReconnects++
                logEvent("wifi_recovered", "WiFi connection restored")
            }
            disconnectedSinceMs.set(0L)
            lastConnectedState = true
            return
        }
        
        lastConnectedState = false
        
        // WiFi is enabled but not connected - start/update disconnect timer
        if (wifiState.wifiEnabled && !wifiState.wifiConnected) {
            val now = System.currentTimeMillis()
            val disconnectedSince = disconnectedSinceMs.get()
            
            if (disconnectedSince == 0L) {
                disconnectedSinceMs.set(now)
                Log.i(TAG, "WiFi disconnected - starting timer")
                logEvent("wifi_disconnected", "WiFi ON but not connected - monitoring started")
                return
            }
            
            val disconnectedDuration = now - disconnectedSince
            
            if (disconnectedDuration < DISCONNECT_THRESHOLD_MS) {
                Log.d(TAG, "Disconnected for ${disconnectedDuration}ms, threshold not reached")
                return
            }
            
            // Threshold reached - check if we should toggle
            if (!shouldToggle(wifiState)) {
                val reason = getSkipReason(wifiState)
                Log.d(TAG, "Toggle skipped: $reason")
                return
            }
            
            // Execute toggle — never give up, keep retrying forever
            Log.w(TAG, "WiFi disconnected for ${disconnectedDuration}ms - triggering recovery toggle #${totalToggles + 1}")
            logEvent("wifi_toggle_attempt", "Attempting WiFi toggle after ${disconnectedDuration / 1000}s disconnected")
            
            val success = executeToggle()
            
            if (success) {
                totalToggles++
                disconnectedSinceMs.set(0L)  // Reset timer for next cycle
                
                // Wait and check if reconnection succeeded
                delay(10_000L)  // 10 seconds to reconnect
                
                if (!isWifiConnected()) {
                    failedToggles++
                    Log.w(TAG, "Toggle #$totalToggles failed - will retry in next cycle (total failures: $failedToggles)")
                    logEvent("wifi_toggle_failed", "Toggle completed but WiFi still not connected")
                    // Timer was reset — will trigger again after threshold
                } else {
                    Log.i(TAG, "Reconnection successful after toggle #$totalToggles")
                    successfulReconnects++
                    logEvent("wifi_toggle_success", "WiFi reconnected after toggle")
                }
            } else {
                failedToggles++
                Log.e(TAG, "Toggle execution failed - will retry in next cycle")
                logEvent("wifi_toggle_error", "Failed to execute WiFi toggle (security/permission error)")
                // Reset timer so we try again after threshold
                disconnectedSinceMs.set(System.currentTimeMillis())
            }
        }
    }
    
    /**
     * Log event to local history for later reporting.
     */
    private fun logEvent(type: String, message: String) {
        synchronized(eventHistoryLock) {
            val event = JSONObject().apply {
                put("type", type)
                put("message", message)
                put("timestamp", System.currentTimeMillis())
                put("totalToggles", totalToggles)
                put("failedToggles", failedToggles)
                put("successfulReconnects", successfulReconnects)
            }
            eventHistory.add(event)
            
            // Trim history to prevent memory bloat
            while (eventHistory.size > MAX_EVENT_HISTORY) {
                eventHistory.removeAt(0)
            }
        }
        Log.i(TAG, "Event logged: $type - $message")
    }
    
    /**
     * Called when WebSocket reconnects successfully.
     * Sends accumulated event history to server and clears it.
     */
    fun onReconnected() {
        synchronized(eventHistoryLock) {
            if (eventHistory.isEmpty()) {
                Log.d(TAG, "onReconnected: no WiFi events to report")
                return
            }
            
            val report = JSONObject().apply {
                put("type", "wifi_watchdog_history")
                put("eventCount", eventHistory.size)
                put("totalToggles", totalToggles)
                put("failedToggles", failedToggles)
                put("successfulReconnects", successfulReconnects)
                put("events", JSONArray(eventHistory.toList()))
                put("reportTimestamp", System.currentTimeMillis())
            }
            
            Log.i(TAG, "Sending WiFi watchdog history: ${eventHistory.size} events")
            
            try {
                onHealthReport?.invoke(report)
                // Clear history after successful send
                eventHistory.clear()
                Log.i(TAG, "WiFi watchdog history sent and cleared")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send history: ${e.message}")
                // Keep history — will try again on next reconnect
            }
        }
    }
    
    /**
     * Check if toggle should be executed based on edge cases.
     */
    private fun shouldToggle(state: WifiState): Boolean {
        // Don't toggle if mobile data is active (fallback OK)
        if (state.mobileDataActive) {
            return false
        }
        
        // Don't toggle if battery saver is on
        if (state.batterySaverOn) {
            return false
        }
        
        // Don't toggle if user recently interacted (cooldown)
        val lastAction = lastUserActionMs.get()
        if (lastAction > 0) {
            val elapsed = System.currentTimeMillis() - lastAction
            if (elapsed < USER_ACTION_COOLDOWN_MS) {
                return false
            }
        }
        
        return true
    }
    
    /**
     * Get reason why toggle was skipped (for logging).
     */
    private fun getSkipReason(state: WifiState): String {
        return when {
            state.mobileDataActive -> "mobile data active"
            state.batterySaverOn -> "battery saver on"
            else -> {
                val lastAction = lastUserActionMs.get()
                if (lastAction > 0) {
                    val elapsed = System.currentTimeMillis() - lastAction
                    if (elapsed < USER_ACTION_COOLDOWN_MS) {
                        "user action cooldown (${elapsed / 1000}s/${USER_ACTION_COOLDOWN_MS / 1000}s)"
                    } else "unknown"
                } else "unknown"
            }
        }
    }
    
    /**
     * Execute WiFi OFF → delay → ON toggle.
     */
    @Suppress("DEPRECATION")
    private suspend fun executeToggle(): Boolean {
        return try {
            Log.i(TAG, "Executing WiFi toggle: OFF")
            
            // Disable WiFi
            val disableResult = wifiManager.setWifiEnabled(false)
            if (!disableResult) {
                Log.e(TAG, "Failed to disable WiFi")
                return false
            }
            
            // Wait for state change
            delay(TOGGLE_DELAY_MS)
            
            Log.i(TAG, "Executing WiFi toggle: ON")
            
            // Re-enable WiFi
            val enableResult = wifiManager.setWifiEnabled(true)
            if (!enableResult) {
                Log.e(TAG, "Failed to enable WiFi")
                return false
            }
            
            Log.i(TAG, "WiFi toggle complete")
            true
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException during toggle: ${e.message}")
            false
        } catch (e: Exception) {
            Log.e(TAG, "Error during toggle: ${e.message}", e)
            false
        }
    }
    
    /**
     * Get current WiFi/network state.
     */
    private fun getWifiState(): WifiState {
        val wifiEnabled = wifiManager.isWifiEnabled
        val wifiConnected = isWifiConnected()
        val mobileActive = isMobileDataActive()
        val batterySaver = powerManager.isPowerSaveMode
        
        return WifiState(
            wifiEnabled = wifiEnabled,
            wifiConnected = wifiConnected,
            mobileDataActive = mobileActive,
            batterySaverOn = batterySaver
        )
    }
    
    private fun isWifiConnected(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
               caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
               caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
    
    private fun isMobileDataActive(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
               caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
    
    /**
     * Detect user WiFi actions to avoid interfering with manual control.
     */
    private var wifiStateReceiver: BroadcastReceiver? = null
    
    private fun registerUserActionDetector() {
        wifiStateReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == WifiManager.WIFI_STATE_CHANGED_ACTION) {
                    val state = intent.getIntExtra(
                        WifiManager.EXTRA_WIFI_STATE,
                        WifiManager.WIFI_STATE_UNKNOWN
                    )
                    
                    // If WiFi was just disabled, assume user action and set cooldown
                    // (Our toggle always re-enables immediately, so a sustained disable = user)
                    if (state == WifiManager.WIFI_STATE_DISABLED) {
                        Log.d(TAG, "WiFi disabled detected - setting user action cooldown")
                        lastUserActionMs.set(System.currentTimeMillis())
                    }
                }
            }
        }
        
        val filter = IntentFilter(WifiManager.WIFI_STATE_CHANGED_ACTION)
        context.registerReceiver(wifiStateReceiver, filter)
    }
    
    private fun unregisterUserActionDetector() {
        wifiStateReceiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (e: Exception) {
                Log.w(TAG, "Error unregistering receiver: ${e.message}")
            }
        }
        wifiStateReceiver = null
    }
    
    /**
     * Get watchdog stats for health reports.
     */
    fun getStats(): JSONObject = JSONObject().apply {
        put("totalToggles", totalToggles)
        put("failedToggles", failedToggles)
        put("successfulReconnects", successfulReconnects)
        put("disconnectedSinceMs", disconnectedSinceMs.get())
        put("pendingEvents", synchronized(eventHistoryLock) { eventHistory.size })
        put("isRunning", monitorJob?.isActive == true)
    }
    
    data class WifiState(
        val wifiEnabled: Boolean,
        val wifiConnected: Boolean,
        val mobileDataActive: Boolean,
        val batterySaverOn: Boolean
    )
}
