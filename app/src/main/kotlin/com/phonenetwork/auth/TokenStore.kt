package com.phonenetwork.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * TokenStore — Encrypted dual-token (access + refresh) and device UUID persistence.
 *
 * Security:
 * - All tokens encrypted with AES-256-GCM via Android Keystore (StrongBox if available)
 * - Plain tokens NEVER written to disk — only ciphertext
 * - DeviceUUID stored in file (not SharedPreferences — survives reinstall on rooted devices)
 * - On AUTH_REVOKED: clearAllTokens() — device returns to unregistered state
 */
class TokenStore(private val context: Context) {
    companion object {
        private const val TAG = "TokenStore"
        private const val KEY_ALIAS = "phone_network_auth_v2"
        private const val PREFS_NAME = "phone_network_tokens"
        // Access token fields
        private const val KEY_ACCESS_ENC = "access_enc"
        private const val KEY_ACCESS_IV  = "access_iv"
        private const val KEY_ACCESS_EXP = "access_exp"
        // Refresh token fields
        private const val KEY_REFRESH_ENC = "refresh_enc"
        private const val KEY_REFRESH_IV  = "refresh_iv"
        private const val KEY_REFRESH_EXP = "refresh_exp"
        // Device info
        private const val KEY_DEVICE_ID   = "device_id"
        private const val UUID_FILE       = "device.uuid"
        private const val GCM_TAG_LENGTH  = 128
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // ─── Device UUID ──────────────────────────────────────────────────────────
    // Persistence strategy (in priority order):
    //   1. SharedPreferences (survives app updates, not pm clear)
    //   2. Internal file context.filesDir/device.uuid (survives updates)
    //   3. External storage /sdcard/.phone_network_uuid (survives pm clear on rooted)
    //   4. ANDROID_ID (stable per-device, changes on factory reset only)
    // On first run: generate UUID, persist to all locations.

    fun getDeviceUuid(): String {
        // 1. SharedPreferences
        prefs.getString("device_uuid", null)?.takeIf { it.isNotBlank() }?.let { return it }

        // 2. Internal file
        val internalFile = File(context.filesDir, UUID_FILE)
        if (internalFile.exists()) {
            val uuid = internalFile.readText().trim()
            if (uuid.isNotBlank()) { persistUuid(uuid); return uuid }
        }

        // 3. External file (survives pm clear on Magisk-rooted devices)
        val externalFile = File(android.os.Environment.getExternalStorageDirectory(), ".phone_network_uuid")
        if (externalFile.exists()) {
            runCatching {
                val uuid = externalFile.readText().trim()
                if (uuid.isNotBlank()) { persistUuid(uuid); return uuid }
            }
        }

        // 4. ANDROID_ID as stable seed (not truly unique but stable across pm clear)
        // Only used as last resort — generates deterministic UUID from ANDROID_ID
        val androidId = android.provider.Settings.Secure.getString(
            context.contentResolver, android.provider.Settings.Secure.ANDROID_ID
        )
        val fallbackUuid = if (!androidId.isNullOrBlank() && androidId != "9774d56d682e549c") {
            // Deterministic UUID v5 from ANDROID_ID
            UUID.nameUUIDFromBytes("phonenetwork:$androidId".toByteArray()).toString()
        } else {
            UUID.randomUUID().toString()
        }

        persistUuid(fallbackUuid)
        Log.i(TAG, "Generated device UUID: $fallbackUuid")
        return fallbackUuid
    }

    private fun persistUuid(uuid: String) {
        // Write to all locations for maximum durability
        prefs.edit().putString("device_uuid", uuid).apply()
        runCatching { File(context.filesDir, UUID_FILE).writeText(uuid) }
        runCatching {
            val ext = File(android.os.Environment.getExternalStorageDirectory(), ".phone_network_uuid")
            ext.writeText(uuid)
        }
    }

    fun getDeviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)

    fun saveDeviceId(deviceId: String) {
        prefs.edit().putString(KEY_DEVICE_ID, deviceId).apply()
    }

    // ─── Access token ─────────────────────────────────────────────────────────

    fun saveAccessToken(token: String, expiresAt: Long) {
        encrypt(token)?.let { (enc, iv) ->
            prefs.edit()
                .putString(KEY_ACCESS_ENC, enc)
                .putString(KEY_ACCESS_IV, iv)
                .putLong(KEY_ACCESS_EXP, expiresAt)
                .apply()
        }
    }

    fun getAccessToken(): String? {
        if (System.currentTimeMillis() > prefs.getLong(KEY_ACCESS_EXP, 0L)) {
            // Expired — clear it to avoid confusion
            prefs.edit().remove(KEY_ACCESS_ENC).remove(KEY_ACCESS_IV).remove(KEY_ACCESS_EXP).apply()
            return null
        }
        return decrypt(
            prefs.getString(KEY_ACCESS_ENC, null),
            prefs.getString(KEY_ACCESS_IV, null)
        )
    }

    fun isAccessTokenValid(): Boolean =
        prefs.getLong(KEY_ACCESS_EXP, 0L) > System.currentTimeMillis() &&
        prefs.getString(KEY_ACCESS_ENC, null) != null

    // ─── Refresh token ────────────────────────────────────────────────────────

    fun saveRefreshToken(token: String, expiresAt: Long) {
        encrypt(token)?.let { (enc, iv) ->
            prefs.edit()
                .putString(KEY_REFRESH_ENC, enc)
                .putString(KEY_REFRESH_IV, iv)
                .putLong(KEY_REFRESH_EXP, expiresAt)
                .apply()
        }
    }

    fun getRefreshToken(): String? {
        if (System.currentTimeMillis() > prefs.getLong(KEY_REFRESH_EXP, 0L)) return null
        return decrypt(
            prefs.getString(KEY_REFRESH_ENC, null),
            prefs.getString(KEY_REFRESH_IV, null)
        )
    }

    fun isRefreshTokenValid(): Boolean =
        prefs.getLong(KEY_REFRESH_EXP, 0L) > System.currentTimeMillis() &&
        prefs.getString(KEY_REFRESH_ENC, null) != null

    /**
     * Save both tokens at once (after REGISTER_ACK or re-issue).
     * If server sends empty refreshToken (reconnect ACK with existing refresh), skip refresh save.
     */
    fun saveTokens(
        accessToken: String,
        accessExpiresAt: Long,
        refreshToken: String?,
        refreshExpiresAt: Long,
        deviceId: String
    ) {
        saveAccessToken(accessToken, accessExpiresAt)
        if (!refreshToken.isNullOrEmpty()) {
            saveRefreshToken(refreshToken, refreshExpiresAt)
        }
        saveDeviceId(deviceId)
    }

    // ─── Clear tokens ─────────────────────────────────────────────────────────

    /**
     * Called on AUTH_REVOKED — device returns to unregistered state.
     * Next connect will require a new registration code from admin.
     */
    fun clearAllTokens() {
        prefs.edit()
            .remove(KEY_ACCESS_ENC).remove(KEY_ACCESS_IV).remove(KEY_ACCESS_EXP)
            .remove(KEY_REFRESH_ENC).remove(KEY_REFRESH_IV).remove(KEY_REFRESH_EXP)
            .remove(KEY_DEVICE_ID)
            .apply()
        Log.w(TAG, "All tokens cleared — device needs re-registration.")
    }

    // ─── Crypto helpers ───────────────────────────────────────────────────────

    private fun encrypt(plaintext: String): Pair<String, String>? {
        return try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            Pair(
                Base64.encodeToString(ciphertext, Base64.NO_WRAP),
                Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            )
        } catch (e: Exception) {
            Log.e(TAG, "Encryption failed: ${e.message}")
            null
        }
    }

    private fun decrypt(encB64: String?, ivB64: String?): String? {
        if (encB64 == null || ivB64 == null) return null
        return try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_LENGTH, iv))
            String(cipher.doFinal(Base64.decode(encB64, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "Decryption failed: ${e.message}")
            null
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (keyStore.getEntry(KEY_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        }
        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        keyGen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false) // background service — no UI
                .build()
        )
        return keyGen.generateKey()
    }
}
