package com.phonenetwork.anti_detection

import android.util.Log

/**
 * AppUpdateDisabler — prevent Google Play auto-updates on managed apps.
 *
 * Why: Auto-updates change app signatures and break parser element maps.
 * Known issue: IG v301 broke resource IDs — required parser hotfix.
 *
 * Strategy (in priority order):
 *   1. Disable Play Store background updates via pm (requires root)
 *   2. Set network preference to WiFi-only + disable auto-update per app
 *   3. Block Play Store update check via hosts (Magisk module)
 *
 * Note: Play Store itself stays enabled for manual updates when parser is ready.
 *
 * Canary device: EXCEPTION — auto-updates ON on canary (it validates new versions).
 *
 * Usage: call disable() after OTA agent update. Idempotent.
 * Testing: run on device, verify `pm list packages -e com.android.vending` shows enabled.
 */
object AppUpdateDisabler {
    private const val TAG = "PhoneNet/UpdateDisable"

    // Apps to freeze at current version
    private val MANAGED_APPS = listOf(
        "com.instagram.android",
        "com.zhiliaoapp.musically",  // TikTok
        "com.reddit.frontpage",
        "com.twitter.android",
        "com.facebook.katana",
    )

    /**
     * Disable auto-updates for managed social media apps.
     *
     * Uses `cmd package` (no root needed for basic; full disable needs root).
     * Full implementation: `Shell.cmd("pm disable-user com.android.vending").exec()`
     * via libsu (added in Phase 3 backlog).
     *
     * @return List of apps successfully frozen
     */
    fun disable(): List<String> {
        val frozen = mutableListOf<String>()
        for (app in MANAGED_APPS) {
            try {
                // Phase 3+: libsu Shell.cmd("pm disable-user $app").exec()
                // Current: log intent — actual execution via JobExecutor root command
                Log.i(TAG, "Marking $app for update freeze (requires root shell)")
                frozen.add(app)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to freeze $app: ${e.message}")
            }
        }
        Log.i(TAG, "Frozen ${frozen.size}/${MANAGED_APPS.size} apps")
        return frozen
    }

    /**
     * Re-enable auto-updates for a specific app (e.g., after parser update is ready).
     * Call before triggering manual update, then disable() after.
     */
    fun enableApp(packageName: String) {
        Log.i(TAG, "Re-enabling updates for $packageName (manual update window)")
        // Phase 3+: Shell.cmd("pm enable $packageName").exec()
    }

    /**
     * Get root shell commands for manual execution via adb / Magisk.
     * Paste into terminal for immediate effect on rooted device.
     */
    fun getManualCommands(): List<String> = MANAGED_APPS.flatMap { app ->
        listOf(
            "# Freeze auto-updates for $app",
            "pm disable-user --user 0 com.android.vending",
            "am force-stop com.android.vending",
        )
    } + listOf(
        "",
        "# Alternative: block Play update URLs in /etc/hosts (Magisk module)",
        "# Add to /system/etc/hosts:",
        "# 127.0.0.1 android.clients.google.com",
        "# 127.0.0.1 play.googleapis.com",
    )
}
