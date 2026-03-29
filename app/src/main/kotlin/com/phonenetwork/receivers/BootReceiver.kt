package com.phonenetwork.receivers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.phonenetwork.anti_detection.DnsPrivacyApplier
import com.phonenetwork.service.AgentForegroundService

/**
 * BootReceiver — restarts the agent after device reboot.
 * Also re-applies Private DNS config (A4) — survives reboot.
 * Requires RECEIVE_BOOT_COMPLETED permission in AndroidManifest.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i("PhoneNet/Boot", "Boot completed — applying DNS + starting service")
            // A4: re-apply Private DNS before service connects to server
            DnsPrivacyApplier.applyOnBoot(context)
            AgentForegroundService.start(context)
        }
    }
}
