package com.phonenetwork

import android.app.Application
import android.util.Log

/**
 * PhoneNetworkApp — Application class.
 */
class PhoneNetworkApp : Application() {

    companion object {
        private const val TAG = "PhoneNet/App"
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Application onCreate")
    }
}
