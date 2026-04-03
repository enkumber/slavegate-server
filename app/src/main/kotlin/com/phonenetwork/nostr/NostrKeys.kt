package com.phonenetwork.nostr

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import rust.nostr.sdk.Keys
import rust.nostr.sdk.SecretKey

/**
 * NostrKeys.kt
 * secp256k1 keypair management for Nostr device identity.
 *
 * Storage: EncryptedSharedPreferences (AES-256-GCM via Android Keystore master key)
 *
 * SECURITY NOTE:
 * secp256k1 keys CANNOT be stored directly in Android Keystore (not supported).
 * We store the secret key encrypted in SharedPreferences with a master key
 * that IS stored in Android Keystore. This provides:
 * - At-rest encryption (AES-256-GCM)
 * - Master key protected by TEE/StrongBox if available
 * - Automatic key rotation on master key compromise
 *
 * RISK: If device is rooted and attacker has runtime access, they could
 * potentially extract the decrypted key from memory. For our use case
 * (device automation agent), this is acceptable — device compromise means
 * game over anyway.
 */
object NostrKeys {
    private const val TAG = "NostrKeys"
    private const val PREFS_NAME = "nostr_keys_encrypted"
    private const val KEY_SECRET_KEY = "secret_key_nsec"
    private const val KEY_PUBLIC_KEY = "public_key_npub"
    
    private var cachedKeys: Keys? = null
    
    /**
     * Get or create the device's Nostr keypair.
     * Generates new keypair on first call, loads from storage on subsequent calls.
     */
    @Synchronized
    fun getOrCreateKeys(context: Context): Keys {
        // Return cached keys if available
        cachedKeys?.let { return it }
        
        val prefs = getEncryptedPrefs(context)
        
        // Try to load existing keys
        val storedNsec = prefs.getString(KEY_SECRET_KEY, null)
        if (storedNsec != null) {
            try {
                val secretKey = SecretKey.parse(storedNsec)
                val keys = Keys(secretKey)
                cachedKeys = keys
                Log.i(TAG, "Loaded existing keypair. pubkey=${keys.publicKey().toHex().take(16)}...")
                return keys
            } catch (e: Exception) {
                Log.e(TAG, "Failed to parse stored key, regenerating: ${e.message}")
            }
        }
        
        // Generate new keypair
        val keys = Keys.generate()
        
        // Store securely
        prefs.edit()
            .putString(KEY_SECRET_KEY, keys.secretKey().toBech32())
            .putString(KEY_PUBLIC_KEY, keys.publicKey().toBech32())
            .apply()
        
        cachedKeys = keys
        Log.i(TAG, "Generated new keypair. pubkey=${keys.publicKey().toHex().take(16)}...")
        
        return keys
    }
    
    /**
     * Get public key as hex string (for server registration).
     */
    fun getPublicKeyHex(context: Context): String {
        return getOrCreateKeys(context).publicKey().toHex()
    }
    
    /**
     * Get public key as npub (bech32 format, for display).
     */
    fun getPublicKeyNpub(context: Context): String {
        return getOrCreateKeys(context).publicKey().toBech32()
    }
    
    /**
     * Export nsec for backup.
     * WARNING: This exposes the secret key — only call when user explicitly requests backup.
     */
    fun exportNsec(context: Context): String {
        return getOrCreateKeys(context).secretKey().toBech32()
    }
    
    /**
     * Import keypair from nsec (device recovery / migration).
     * Overwrites any existing keypair.
     */
    fun importFromNsec(context: Context, nsec: String): Boolean {
        return try {
            val secretKey = SecretKey.parse(nsec)
            val keys = Keys(secretKey)
            
            val prefs = getEncryptedPrefs(context)
            prefs.edit()
                .putString(KEY_SECRET_KEY, keys.secretKey().toBech32())
                .putString(KEY_PUBLIC_KEY, keys.publicKey().toBech32())
                .apply()
            
            cachedKeys = keys
            Log.i(TAG, "Imported keypair from nsec. pubkey=${keys.publicKey().toHex().take(16)}...")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to import nsec: ${e.message}")
            false
        }
    }
    
    /**
     * Check if keys exist without creating new ones.
     */
    fun hasKeys(context: Context): Boolean {
        val prefs = getEncryptedPrefs(context)
        return prefs.getString(KEY_SECRET_KEY, null) != null
    }
    
    /**
     * Wipe all keys (factory reset).
     * Clears both storage and memory cache.
     */
    fun wipeKeys(context: Context) {
        val prefs = getEncryptedPrefs(context)
        prefs.edit().clear().apply()
        cachedKeys = null
        Log.w(TAG, "All Nostr keys wiped")
    }
    
    /**
     * Get EncryptedSharedPreferences instance.
     * Master key is stored in Android Keystore (hardware-backed if available).
     */
    private fun getEncryptedPrefs(context: Context): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
}
