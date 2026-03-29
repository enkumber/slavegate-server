package com.phonenetwork.capture

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * CloakConfigStore — saves CLOAK_CONFIG payload to SharedPreferences.
 *
 * The agent (com.phonenetwork) writes here.
 * The LSPosed module (com.phonenetwork.cloak) reads cross-process via XSharedPreferences.
 *
 * SharedPreferences name MUST match CloakConfig.PREFS_NAME in lspmod-cloak.
 * Key MUST match CloakConfig.KEY_CONFIG in lspmod-cloak.
 *
 * Note: MODE_WORLD_READABLE is required for XSharedPreferences cross-process access.
 * On Android 9+ this flag is "deprecated" but still functional with LSPosed.
 */
object CloakConfigStore {
    private const val TAG        = "PhoneNet/CloakStore"
    private const val PREFS_NAME = "phone_network_cloak"  // matches CloakConfig.PREFS_NAME
    private const val KEY_CONFIG = "cloak_config_v1"      // matches CloakConfig.KEY_CONFIG

    /** Save raw CLOAK_CONFIG payload JSON so LSPosed module can read it */
    @Suppress("DEPRECATION")  // MODE_WORLD_READABLE needed for XSharedPreferences
    fun save(context: Context, payload: JSONObject) {
        try {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_WORLD_READABLE)
                .edit()
                .putString(KEY_CONFIG, payload.toString())
                .apply()
            Log.d(TAG, "CloakConfig saved for LSPosed cross-process read")
        } catch (e: SecurityException) {
            // Fallback: MODE_PRIVATE (LSPosed may still access via root-level XSharedPreferences)
            Log.w(TAG, "MODE_WORLD_READABLE denied, falling back to MODE_PRIVATE: ${e.message}")
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_CONFIG, payload.toString())
                .apply()
        }
    }
}
