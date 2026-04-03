package com.phonenetwork.nostr

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * EnrollmentStore.kt
 * Persists Nostr enrollment data from QR code scan.
 *
 * QR payload format (v2):
 * {
 *   "v": 2,                        // enrollment version
 *   "s": "<server_pubkey_hex>",    // server pubkey (64 chars)
 *   "r": ["ws://relay1", ...],     // relay URLs
 *   "d": "<device_id_uuid>"        // pre-assigned device ID
 * }
 */
object EnrollmentStore {
    private const val TAG = "EnrollmentStore"
    private const val PREFS_NAME = "nostr_enrollment"
    private const val KEY_VERSION = "version"
    private const val KEY_SERVER_PUBKEY = "server_pubkey"
    private const val KEY_RELAY_URLS = "relay_urls"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_ENROLLED_AT = "enrolled_at"
    
    /**
     * Enrollment data container.
     */
    data class Enrollment(
        val serverPubkey: String,
        val relayUrls: List<String>,
        val deviceId: String,
        val enrolledAt: Long
    )
    
    /**
     * Parse and save enrollment from QR code payload.
     * @param qrContent Raw QR code content (JSON string or base64)
     * @return true if valid v2 enrollment saved, false otherwise
     */
    fun saveFromQrContent(context: Context, qrContent: String): Boolean {
        return try {
            // Try direct JSON parse first
            val payload = try {
                JSONObject(qrContent)
            } catch (e: Exception) {
                // Try base64 decode
                val decoded = android.util.Base64.decode(qrContent, android.util.Base64.DEFAULT)
                JSONObject(String(decoded))
            }
            
            saveFromQr(context, payload)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse QR content: ${e.message}")
            false
        }
    }
    
    /**
     * Save enrollment from parsed QR payload.
     */
    fun saveFromQr(context: Context, payload: JSONObject): Boolean {
        val version = payload.optInt("v", 0)
        if (version != 2) {
            Log.e(TAG, "Invalid enrollment version: $version (expected 2)")
            return false
        }
        
        val serverPubkey = payload.optString("s", "")
        if (serverPubkey.length != 64) {
            Log.e(TAG, "Invalid server pubkey length: ${serverPubkey.length}")
            return false
        }
        
        val relaysArray = payload.optJSONArray("r")
        if (relaysArray == null || relaysArray.length() == 0) {
            Log.e(TAG, "No relay URLs in enrollment")
            return false
        }
        
        val deviceId = payload.optString("d", "")
        if (deviceId.isEmpty()) {
            Log.e(TAG, "No device ID in enrollment")
            return false
        }
        
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit()
            .putInt(KEY_VERSION, version)
            .putString(KEY_SERVER_PUBKEY, serverPubkey)
            .putString(KEY_RELAY_URLS, relaysArray.toString())
            .putString(KEY_DEVICE_ID, deviceId)
            .putLong(KEY_ENROLLED_AT, System.currentTimeMillis())
            .apply()
        
        Log.i(TAG, "Enrollment saved: deviceId=${deviceId.take(8)} relays=${relaysArray.length()}")
        return true
    }
    
    /**
     * Get stored enrollment data.
     * @return Enrollment or null if not enrolled
     */
    fun getEnrollment(context: Context): Enrollment? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        
        val serverPubkey = prefs.getString(KEY_SERVER_PUBKEY, null) ?: return null
        val relaysJson = prefs.getString(KEY_RELAY_URLS, null) ?: return null
        val deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: return null
        val enrolledAt = prefs.getLong(KEY_ENROLLED_AT, 0L)
        
        val relays = try {
            val arr = JSONArray(relaysJson)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse relay URLs: ${e.message}")
            return null
        }
        
        if (relays.isEmpty()) return null
        
        return Enrollment(serverPubkey, relays, deviceId, enrolledAt)
    }
    
    /**
     * Check if device is enrolled.
     */
    fun hasEnrollment(context: Context): Boolean {
        return getEnrollment(context) != null
    }
    
    /**
     * Clear enrollment data (factory reset / re-enrollment).
     */
    fun clear(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .apply()
        Log.i(TAG, "Enrollment cleared")
    }
    
    /**
     * Get device ID if enrolled.
     */
    fun getDeviceId(context: Context): String? {
        return getEnrollment(context)?.deviceId
    }
}
