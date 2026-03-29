package com.phonenetwork.ota

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver for MY_PACKAGE_REPLACED — auto-starts app after OTA install.
 * 
 * Android sends this broadcast AFTER the new APK is installed and the old process
 * is killed. The receiver in the NEW APK receives it, guaranteeing we run the
 * updated code.
 * 
 * This is more reliable than nohup/setsid/AlarmManager approaches because:
 * - It's a system-level broadcast, not dependent on our process surviving
 * - The receiver is registered in manifest, so it runs even if app wasn't running
 * - It only fires for our own package replacement
 */
class OtaRestartReceiver : BroadcastReceiver() {
    
    companion object {
        private const val TAG = "PhoneNet/OTA"
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Log.i(TAG, "MY_PACKAGE_REPLACED received — starting app")
            
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                context.startActivity(launchIntent)
                Log.i(TAG, "App started after OTA update")
            } else {
                Log.e(TAG, "Could not get launch intent for ${context.packageName}")
            }
        }
    }
}
