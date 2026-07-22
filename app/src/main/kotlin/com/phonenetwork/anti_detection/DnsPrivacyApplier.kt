package com.phonenetwork.anti_detection

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import com.phonenetwork.utils.BoundedProcessRunner

/**
 * DnsPrivacyApplier — sets Android Private DNS (DoT) per device config.
 *
 * Android 9+ (API 28+) supports Private DNS via global settings:
 *   private_dns_mode       → "hostname" (manual) | "opportunistic" | "off"
 *   private_dns_specifier  → DoT hostname, e.g. "one.one.one.one"
 *
 * Fleet runs Android 10/11 → both support Private DNS natively.
 *
 * Requires root: `su -c settings put global ...` (Magisk shell).
 * Fails gracefully if root unavailable — logs warning, does not crash.
 *
 * Apply points:
 *   1. On CLOAK_CONFIG received (WsClient handler)
 *   2. On device boot (BootReceiver — reads saved config from SharedPreferences)
 *
 * Reference: PHASE4_PLAN.md A4
 */
object DnsPrivacyApplier {
    private const val TAG         = "PhoneNet/Dns"
    private const val PREFS_NAME  = "phone_network_cloak"
    private const val KEY_DNS_HOST = "dns_hostname_v1"
    private const val KEY_DNS_PROV = "dns_provider_v1"

    /**
     * Apply Private DNS config and persist for BootReceiver.
     * @param hostname  DoT hostname, e.g. "one.one.one.one"
     * @param provider  human-readable name for logging
     */
    fun apply(context: Context, hostname: String, provider: String) {
        // DISABLED: Private DNS conflicts with WireGuard VPN.
        // Setting Private DNS (DoT) breaks DNS resolution when VPN is active.
        // Reset to off instead of applying.
        Log.i(TAG, "Private DNS apply DISABLED — resetting to off (WG VPN compatibility)")
        reset(context)
    }

    /**
     * Re-apply on boot — reads hostname persisted by previous apply().
     * Called by BootReceiver after device restarts.
     */
    fun applyOnBoot(context: Context) {
        // DISABLED: Reset to off on boot — Private DNS conflicts with WG VPN
        Log.i(TAG, "Boot: resetting Private DNS to off (WG VPN compatibility)")
        reset(context)
    }

    /** Reset to system default (opportunistic) — used for canary/debug */
    fun reset(context: Context) {
        prefs(context).edit()
            .remove(KEY_DNS_HOST)
            .remove(KEY_DNS_PROV)
            .apply()
        runRootCommand("settings put global private_dns_mode opportunistic")
        Log.i(TAG, "Private DNS reset to opportunistic")
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    private fun applyToSystem(hostname: String, provider: String) {
        val setMode      = runRootCommand("settings put global private_dns_mode hostname")
        val setSpecifier = runRootCommand("settings put global private_dns_specifier $hostname")
        if (setMode && setSpecifier) {
            Log.i(TAG, "Private DNS applied: provider=$provider hostname=$hostname")
        } else {
            Log.w(TAG, "Private DNS apply failed (root unavailable?) — hostname=$hostname")
        }
    }

    /**
     * Execute a root shell command via Magisk su.
     * Returns true if command exited with code 0, false otherwise.
     * Never throws — catches all exceptions and returns false.
     */
    private fun runRootCommand(cmd: String): Boolean {
        return try {
            val result = BoundedProcessRunner.runBlocking(arrayOf("su", "-c", cmd), 10_000L)
            if (!result.success) {
                Log.w(TAG, "Root cmd failed (exit ${result.exitCode}, timeout=${result.timedOut}): $cmd")
            }
            result.success
        } catch (e: Exception) {
            Log.w(TAG, "Root cmd exception: $cmd — ${e.message}")
            false
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
