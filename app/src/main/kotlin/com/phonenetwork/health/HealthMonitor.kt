package com.phonenetwork.health

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.util.Log
import com.phonenetwork.rustdesk.RustDeskWatchdog
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * HealthMonitor — collects device health metrics for heartbeat reports.
 * All metrics read from Android system APIs — no root required.
 */
class HealthMonitor(private val context: Context) {

    companion object {
        private const val TAG = "HealthMonitor"
    }

    // ─── Public IP cache (max 1 fetch per 5 minutes) ─────────────────────────
    @Volatile private var cachedPublicIp: String = "unknown"
    @Volatile private var publicIpFetchedAt: Long = 0L
    private val PUBLIC_IP_CACHE_MS = 5 * 60 * 1000L  // 5 minutes
    private val PUBLIC_IP_TIMEOUT_MS = 2000            // 2s timeout

    data class Health(
        val batteryLevel: Int,
        val charging: Boolean,
        val storageFreeBytes: Long,
        val thermalStatus: String,
        val networkType: String,
        val networkQuality: String,
        val activeApp: String?,
        val publicIp: String,
        val rustdeskId: String? = null,
        val rustdeskRunning: Boolean = false
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("batteryLevel", batteryLevel)
            put("charging", charging)
            put("storageFreeBytes", storageFreeBytes)
            put("thermalStatus", thermalStatus)
            put("networkType", networkType)
            put("networkQuality", networkQuality)
            put("activeApp", activeApp ?: JSONObject.NULL)
            put("publicIp", publicIp)
            put("rustdeskId", rustdeskId ?: JSONObject.NULL)
            put("rustdeskRunning", rustdeskRunning)
        }
    }

    fun getHealth(): Health {
        // Single registerReceiver call for all battery metrics — avoids two system calls
        val batteryIntent = context.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )

        // RustDesk status — safe even if not installed
        val rustdeskStatus = try {
            RustDeskWatchdog.check(context)
        } catch (e: Exception) {
            Log.w(TAG, "RustDesk status check failed: ${e.message}")
            null
        }

        return Health(
            batteryLevel = getBatteryLevel(batteryIntent),
            charging = isCharging(batteryIntent),
            storageFreeBytes = getFreeStorage(),
            thermalStatus = getThermalStatus(),
            networkType = getNetworkType(),
            networkQuality = getNetworkQuality(),
            activeApp = null, // requires UsageStatsManager permission — opt-in
            publicIp = getPublicIp(),
            rustdeskId = rustdeskStatus?.deviceId,
            rustdeskRunning = rustdeskStatus?.running ?: false
        )
    }

    /**
     * Get public IP with 5-minute cache. Non-blocking: returns cached or "unknown" on failure.
     * Uses HttpURLConnection (no extra dependency) with 2s timeout.
     */
    private fun getPublicIp(): String {
        val now = System.currentTimeMillis()
        if (now - publicIpFetchedAt < PUBLIC_IP_CACHE_MS && cachedPublicIp != "unknown") {
            return cachedPublicIp
        }
        return try {
            val conn = URL("https://api.ipify.org").openConnection() as HttpURLConnection
            conn.connectTimeout = PUBLIC_IP_TIMEOUT_MS
            conn.readTimeout = PUBLIC_IP_TIMEOUT_MS
            conn.requestMethod = "GET"
            val ip = conn.inputStream.bufferedReader().readText().trim()
            conn.disconnect()
            if (ip.isNotEmpty() && ip.length <= 45) { // valid IPv4/IPv6 length
                cachedPublicIp = ip
                publicIpFetchedAt = now
                Log.d(TAG, "Public IP fetched: $ip")
                ip
            } else {
                cachedPublicIp
            }
        } catch (e: Exception) {
            Log.w(TAG, "Public IP fetch failed: ${e.message}")
            cachedPublicIp // return cached (may be "unknown" on first failure)
        }
    }

    private fun getBatteryLevel(intent: Intent?): Int {
        intent ?: return -1
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level == -1 || scale == -1) return -1
        return (level * 100 / scale)
    }

    private fun isCharging(intent: Intent?): Boolean {
        intent ?: return false
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
               status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun getFreeStorage(): Long {
        val stat = android.os.StatFs(context.filesDir.absolutePath)
        return stat.availableBlocksLong * stat.blockSizeLong
    }

    private fun getThermalStatus(): String {
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            when (pm.currentThermalStatus) {
                PowerManager.THERMAL_STATUS_NONE -> "nominal"
                PowerManager.THERMAL_STATUS_LIGHT -> "light"
                PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
                PowerManager.THERMAL_STATUS_SEVERE -> "severe"
                PowerManager.THERMAL_STATUS_CRITICAL,
                PowerManager.THERMAL_STATUS_EMERGENCY,
                PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
                else -> "nominal"
            }
        } else {
            "nominal" // thermal API not available pre-Q
        }
    }

    private fun getNetworkType(): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(network) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "none"
        }
    }

    private fun getNetworkQuality(): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(network) ?: return "none"

        // Use LinkDownstreamBandwidthKbps as proxy for quality
        val downKbps = caps.linkDownstreamBandwidthKbps
        return when {
            downKbps <= 0 -> "none"
            downKbps < 1_000 -> "poor"     // < 1 Mbps
            downKbps < 5_000 -> "good"     // 1-5 Mbps
            else -> "excellent"             // > 5 Mbps
        }
    }
}
