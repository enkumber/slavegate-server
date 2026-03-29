package com.phonenetwork.wireguard

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.io.BufferedReader
import java.io.StringReader

/**
 * WireGuardManager — manages WireGuard tunnel using GoBackend (userspace VPN).
 *
 * Uses wireguard-android GoBackend which creates a VPN tunnel via Android's VpnService API.
 * No root needed for the tunnel itself, but root is used to auto-grant VPN permission.
 *
 * Flow:
 * 1. QR scan or WS push → saveConfig()
 * 2. initBackend() → creates GoBackend instance (once per app lifecycle)
 * 3. startTunnel() → parses config, sets tunnel state UP
 * 4. stopTunnel() → sets tunnel state DOWN
 *
 * DNS: Config received from server has DNS stripped (server-side).
 *      Split tunneling via AllowedIPs = 10.8.0.0/24, 192.168.50.0/24 (server-side).
 *      Internet traffic (RustDesk, browsing) goes through normal WiFi route.
 */
object WireGuardManager {
    private const val TAG = "PhoneNet/WG"
    private const val PREFS_NAME = "wireguard_config"
    private const val KEY_CONFIG = "wg_config"

    const val SERVER_WS_URL = "ws://192.168.50.57:18791/ws"
    const val SERVER_WS_URL_PUBLIC = "wss://relay.pozesexy.com/ws"

    private var backend: GoBackend? = null
    private var tunnel: PhoneNetTunnel? = null

    // ─── Tunnel implementation ────────────────────────────────────────────────

    /**
     * Simple Tunnel implementation for GoBackend.
     */
    private class PhoneNetTunnel : Tunnel {
        override fun getName(): String = "wg0"
        override fun onStateChange(newState: Tunnel.State) {
            Log.i(TAG, "Tunnel state changed: $newState")
        }
    }

    // ─── Config management ────────────────────────────────────────────────────

    fun hasConfig(context: Context): Boolean {
        val prefs = getEncryptedPrefs(context)
        return prefs.getString(KEY_CONFIG, null) != null
    }

    fun saveConfig(context: Context, configText: String) {
        val prefs = getEncryptedPrefs(context)
        prefs.edit().putString(KEY_CONFIG, configText).apply()
        Log.i(TAG, "Config saved (${configText.length} chars)")
    }

    fun getSavedConfig(context: Context): String? {
        return getEncryptedPrefs(context).getString(KEY_CONFIG, null)
    }

    fun clearConfig(context: Context) {
        getEncryptedPrefs(context).edit().remove(KEY_CONFIG).apply()
        Log.i(TAG, "Config cleared")
    }

    /**
     * Returns WireGuard local URL if tunnel is active, otherwise public relay URL.
     * Allows device to connect even without WireGuard config.
     */
    fun getServerUrl(): String = if (isActive()) SERVER_WS_URL else SERVER_WS_URL_PUBLIC

    /**
     * Extract WireGuard interface address from saved config.
     * Returns IP without CIDR suffix (e.g., "10.8.0.13" from "10.8.0.13/32").
     */
    fun getInterfaceAddress(context: Context): String? {
        val configText = getSavedConfig(context) ?: return null
        val regex = Regex("""Address\s*=\s*([0-9.]+)""")
        return regex.find(configText)?.groupValues?.get(1)
    }

    // ─── Backend management ───────────────────────────────────────────────────

    /**
     * Initialize GoBackend. Must be called once before startTunnel().
     * Requires application context.
     */
    fun initBackend(context: Context) {
        if (backend == null) {
            backend = GoBackend(context.applicationContext)
            Log.i(TAG, "GoBackend initialized")
        }
    }

    /**
     * Returns the GoBackend instance (for VpnService.prepare() check).
     */
    fun getBackend(): GoBackend? = backend

    // ─── Tunnel control ───────────────────────────────────────────────────────

    /**
     * Start tunnel from saved config using GoBackend.
     * Parses config text into wireguard-android Config object, then sets state UP.
     */
    fun startTunnel(context: Context): Boolean {
        val configText = getSavedConfig(context) ?: run {
            Log.e(TAG, "No saved config — cannot start tunnel")
            return false
        }

        if (isActive()) {
            Log.i(TAG, "Tunnel already active — skipping start")
            return true
        }

        val be = backend ?: run {
            Log.e(TAG, "GoBackend not initialized — call initBackend() first")
            return false
        }

        return try {
            // Parse config text to wireguard-android Config object
            val config = Config.parse(BufferedReader(StringReader(configText)))
            Log.i(TAG, "Config parsed successfully")

            // Create tunnel if needed
            if (tunnel == null) {
                tunnel = PhoneNetTunnel()
            }

            // Set tunnel state to UP
            be.setState(tunnel!!, Tunnel.State.UP, config)
            Log.i(TAG, "Tunnel started successfully ✓")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start tunnel: ${e.message}", e)
            false
        }
    }

    /**
     * Stop active tunnel by setting state to DOWN.
     */
    fun stopTunnel(): Boolean {
        val be = backend ?: run {
            Log.d(TAG, "No backend — nothing to stop")
            return true
        }
        val t = tunnel ?: run {
            Log.d(TAG, "No tunnel — nothing to stop")
            return true
        }

        return try {
            be.setState(t, Tunnel.State.DOWN, null)
            Log.i(TAG, "Tunnel stopped ✓")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop tunnel: ${e.message}", e)
            false
        }
    }

    /**
     * Check if tunnel is currently active via GoBackend state query.
     */
    fun isActive(): Boolean {
        val be = backend ?: return false
        val t = tunnel ?: return false
        return try {
            be.getState(t) == Tunnel.State.UP
        } catch (e: Exception) {
            Log.w(TAG, "isActive check failed: ${e.message}")
            false
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun getEncryptedPrefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
}
