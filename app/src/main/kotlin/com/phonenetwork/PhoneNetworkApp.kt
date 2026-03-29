package com.phonenetwork

import android.app.Application
import android.util.Log
import com.phonenetwork.wireguard.WireGuardManager

/**
 * PhoneNetworkApp — Application class.
 * 
 * Initializes WireGuard backend on app start.
 */
class PhoneNetworkApp : Application() {
    
    companion object {
        private const val TAG = "PhoneNet/App"
    }
    
    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Application onCreate")
        
        // Initialize WireGuard backend
        WireGuardManager.initBackend(this)
    }
}
