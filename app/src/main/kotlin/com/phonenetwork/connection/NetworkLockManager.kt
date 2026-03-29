package com.phonenetwork.connection

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Log

/**
 * NetworkLockManager — keeps WiFi and CPU alive when screen is off.
 *
 * Without these locks, Android suspends WiFi and CPU after screen-off,
 * breaking the WebSocket connection within 30-60s on real hardware.
 *
 * Usage:
 *   val locks = NetworkLockManager(applicationContext)
 *   locks.acquire()      // on WsClient connect (or service start)
 *   locks.release()      // on service onDestroy() ONLY
 *
 * IMPORTANT:
 * - Do NOT release on low battery — server decides pause via heartbeat health check.
 * - Do NOT release on screen-off — that's exactly when locks are needed.
 * - Always call release() in service onDestroy() to prevent resource leak.
 */
class NetworkLockManager(private val context: Context) {

    private val tag = "PhoneNet/Locks"

    private val wifiLock: WifiManager.WifiLock by lazy {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        // WIFI_MODE_FULL_HIGH_PERF: prevents power saving that would drop the TCP connection
        @Suppress("DEPRECATION")
        wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PhoneNetwork::WifiLock")
    }

    private val wakeLock: PowerManager.WakeLock by lazy {
        val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
        // PARTIAL_WAKE_LOCK: keeps CPU running, allows screen to turn off
        pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PhoneNetwork::WakeLock")
    }

    val isAcquired: Boolean
        get() = wifiLock.isHeld && wakeLock.isHeld

    fun acquire() {
        if (!wifiLock.isHeld) {
            wifiLock.acquire()
            Log.i(tag, "WifiLock acquired (FULL_HIGH_PERF)")
        }
        if (!wakeLock.isHeld) {
            wakeLock.acquire()
            Log.i(tag, "WakeLock acquired (PARTIAL)")
        }
    }

    fun release() {
        if (wifiLock.isHeld) {
            wifiLock.release()
            Log.i(tag, "WifiLock released")
        }
        if (wakeLock.isHeld) {
            wakeLock.release()
            Log.i(tag, "WakeLock released")
        }
    }
}
