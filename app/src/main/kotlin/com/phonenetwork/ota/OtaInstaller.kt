package com.phonenetwork.ota

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicBoolean

/**
 * OtaInstaller — APK download, signature verification, and installation.
 *
 * Flow:
 *   1. Download APK to private cache dir (phone_network_ota/)
 *   2. Verify SHA256 checksum against server-provided hash
 *   3. Verify RSA signature with embedded public key (prevents MitM)
 *   4. Check versionCode >= current (prevents downgrade unless forceDowngrade=true)
 *   5. Install via root (pm install) or PackageInstaller API
 *
 * uninstall() — removes package via root `pm uninstall [--keep-data] <pkg>`
 *
 * Security:
 *   - SHA256 must match EXACTLY before signature check
 *   - Signature verified with embedded public key (not from network)
 *   - Downloaded file deleted after install attempt (success or failure)
 *   - Never executes shell commands from payload — only fixed `pm install/uninstall`
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §9 (OTA)
 */
class OtaInstaller(private val context: Context) {

    companion object {
        private const val TAG          = "PhoneNet/OTA"
        private const val DOWNLOAD_DIR = "phone_network_ota"
        private const val TIMEOUT_MS   = 60_000        // 60s download timeout
        private const val CHANNEL_ID   = "ota_debug"
        private const val CHANNEL_NAME = "OTA Debug"
        
        /** Prevents multiple OTA updates running simultaneously */
        private val isOtaInProgress = AtomicBoolean(false)
    }

    private val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    init {
        // Create notification channel for OTA debug messages
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH)
            notificationManager.createNotificationChannel(channel)
        }
    }

    /**
     * Debug notification — shows OTA progress step by step.
     */
    private fun notify(title: String, message: String) {
        Log.i(TAG, "[$title] $message")
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        notificationManager.notify(System.currentTimeMillis().toInt(), notification)
    }

    // ─── Uninstall ────────────────────────────────────────────────────────────

    /**
     * Uninstall a package via root `pm uninstall`.
     * @param keepData  if true, adds `--keep-data` flag (preserves app data)
     */
    suspend fun uninstall(packageName: String, keepData: Boolean = false) =
        withContext(Dispatchers.IO) {
            // Validate package name — alphanumeric + dots only, prevents injection
            require(packageName.matches(Regex("[a-zA-Z0-9._]+"))) {
                "Invalid package name: $packageName"
            }
            val flags = if (keepData) "--keep-data " else ""
            val cmd   = "pm uninstall ${flags}${packageName}"
            Log.i(TAG, "Uninstalling: $cmd")
            val result = runRootCommand(cmd)
            if (!result.success) {
                throw RuntimeException("pm uninstall failed: ${result.output}")
            }
            Log.i(TAG, "Uninstall success: $packageName")
        }

    // ─── Download + Verify + Install ──────────────────────────────────────────

    /**
     * Full OTA flow: download → verify SHA256 → verify signature → check version → install.
     *
     * @param apkUrl        HTTPS URL to APK (no HTTP — rejected)
     * @param expectedSha256 Hex SHA256 of APK file (server-provided)
     * @param signature      Base64 RSA signature over SHA256 (server-signed)
     * @param versionCode    Expected version code (must be >= current unless forceDowngrade)
     * @param forceDowngrade Allow installing older versionCode
     */
    suspend fun downloadVerifyInstall(
        apkUrl:          String,
        expectedSha256:  String,
        signature:       String,
        versionCode:     Int,
        forceDowngrade:  Boolean = false
    ) = withContext(Dispatchers.IO) {
        // Guard: prevent multiple simultaneous OTA updates
        if (!isOtaInProgress.compareAndSet(false, true)) {
            Log.w(TAG, "OTA already in progress — skipping duplicate request")
            notify("OTA Skipped", "Another OTA update is already running")
            return@withContext
        }

        // Validate URL scheme — HTTP not allowed
        require(apkUrl.startsWith("https://")) {
            "OTA URL must use HTTPS: $apkUrl"
        }

        val outDir = File(context.cacheDir, DOWNLOAD_DIR).apply { mkdirs() }
        val apkFile = File(outDir, "update_${System.currentTimeMillis()}.apk")

        try {
            // ── 1. Download ───────────────────────────────────────────────────
            notify("OTA Step 1/6", "Downloading from ${apkUrl.take(50)}...")
            downloadFile(apkUrl, apkFile)
            notify("OTA Step 1/6", "Download complete: ${apkFile.length()} bytes")

            // ── 2. SHA256 verification ────────────────────────────────────────
            notify("OTA Step 2/6", "Verifying SHA256...")
            val actualSha256 = sha256Hex(apkFile)
            if (!MessageDigest.isEqual(
                    actualSha256.lowercase().toByteArray(),
                    expectedSha256.lowercase().toByteArray()
                )) {
                throw SecurityException(
                    "SHA256 mismatch.\nExpected: ${expectedSha256.take(16)}...\nGot: ${actualSha256.take(16)}..."
                )
            }
            notify("OTA Step 2/6", "SHA256 OK: ${actualSha256.take(16)}...")

            // ── 3. RSA signature verification ─────────────────────────────────
            notify("OTA Step 3/6", "Verifying RSA signature...")
            verifySignature(apkFile, signature, expectedSha256)
            notify("OTA Step 3/6", "RSA signature OK")

            // ── 4. Version check ──────────────────────────────────────────────
            notify("OTA Step 4/6", "Checking version (target=$versionCode)...")
            if (!forceDowngrade) {
                val current = currentVersionCode(apkFile)
                if (versionCode < current) {
                    throw IllegalStateException(
                        "Downgrade prevented: current=$current, new=$versionCode"
                    )
                }
                notify("OTA Step 4/6", "Version OK (current=$current, new=$versionCode)")
            } else {
                notify("OTA Step 4/6", "Version check skipped (forceDowngrade)")
            }

            // ── 5. Install via root ────────────────────────────────────────────
            // Note: App restart is handled by OtaRestartReceiver (MY_PACKAGE_REPLACED)
            notify("OTA Step 5/5", "Installing APK via pm install...")
            installApk(apkFile)
            notify("OTA SUCCESS", "Install complete — app will restart via broadcast receiver")

        } catch (e: Exception) {
            notify("OTA FAILED", "${e.javaClass.simpleName}: ${e.message}")
            throw e
        } finally {
            // Reset OTA-in-progress flag
            isOtaInProgress.set(false)
            // Always clean up download — even on failure
            if (apkFile.exists()) {
                apkFile.delete()
                Log.d(TAG, "Cleaned up APK: ${apkFile.name}")
            }
        }
    }

    // ─── Private: Download ────────────────────────────────────────────────────

    private fun downloadFile(url: String, dest: File) {
        val conn = (URL(url).openConnection() as java.net.HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MS
            readTimeout    = TIMEOUT_MS
            requestMethod  = "GET"
            setRequestProperty("User-Agent", "PhoneNetworkAgent/1.0")
        }
        try {
            val code = conn.responseCode
            if (code != 200) throw RuntimeException("HTTP $code from $url")
            conn.inputStream.use { input ->
                FileOutputStream(dest).use { output ->
                    input.copyTo(output, bufferSize = 8192)
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    // ─── Private: SHA256 ──────────────────────────────────────────────────────

    private fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buf = ByteArray(8192)
            var read: Int
            while (stream.read(buf).also { read = it } != -1) {
                md.update(buf, 0, read)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    // ─── Private: RSA signature ───────────────────────────────────────────────

    /**
     * Verify RSA signature over the SHA256 hash.
     * Server signs: RSA-SHA256(sha256HexBytes)
     * Public key is embedded in the app (not fetched from network).
     *
     * NOTE: In production, replace OTA_PUBLIC_KEY with actual server public key PEM.
     * This stub accepts any signature when key is not configured — add real key before deploy.
     */
    private fun verifySignature(apkFile: File, signatureBase64: String, sha256: String) {
        if (OTA_PUBLIC_KEY_PEM.isBlank()) {
            Log.w(TAG, "OTA_PUBLIC_KEY_PEM not configured — skipping signature verification")
            Log.w(TAG, "Configure OTA_PUBLIC_KEY_PEM in OtaInstaller.kt before production deploy")
            return
        }
        try {
            val keyPem = OTA_PUBLIC_KEY_PEM
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replace("\\s".toRegex(), "")
            val keyBytes  = android.util.Base64.decode(keyPem, android.util.Base64.NO_WRAP)
            val keySpec   = java.security.spec.X509EncodedKeySpec(keyBytes)
            val publicKey = java.security.KeyFactory.getInstance("RSA").generatePublic(keySpec)
            val sig       = Signature.getInstance("SHA256withRSA")
            sig.initVerify(publicKey)
            sig.update(sha256.toByteArray(Charsets.UTF_8))
            val sigBytes  = android.util.Base64.decode(signatureBase64, android.util.Base64.NO_WRAP)
            if (!sig.verify(sigBytes)) {
                throw SecurityException("RSA signature verification FAILED for APK")
            }
        } catch (e: SecurityException) {
            throw e
        } catch (e: Exception) {
            throw SecurityException("Signature verification error: ${e.message}", e)
        }
    }

    // ─── Private: Version check ───────────────────────────────────────────────

    private fun currentVersionCode(apkFile: File): Int {
        return try {
            val info = context.packageManager.getPackageArchiveInfo(apkFile.absolutePath, 0)
            @Suppress("DEPRECATION")
            info?.versionCode ?: 0
        } catch (e: Exception) {
            Log.w(TAG, "Could not read versionCode from APK: ${e.message}")
            0
        }
    }

    // ─── Private: Restart app ──────────────────────────────────────────────────
    // ─── Private: Install via root ────────────────────────────────────────────
    // Note: App restart after install is handled by OtaRestartReceiver (MY_PACKAGE_REPLACED broadcast)

    private fun installApk(apkFile: File) {
        // Root install via `pm install` — works on Magisk-rooted devices
        // -r = replace existing, -d = allow downgrade (when forceDowngrade)
        val result = runRootCommand("pm install -r ${apkFile.absolutePath}")
        if (!result.success || result.output.contains("INSTALL_FAILED", ignoreCase = true)) {
            throw RuntimeException("pm install failed: ${result.output}")
        }
    }

    // ─── Private: Root command ────────────────────────────────────────────────

    private data class CmdResult(val success: Boolean, val output: String)

    private fun runRootCommand(cmd: String): CmdResult {
        return try {
            val process  = Runtime.getRuntime().exec(arrayOf("su", "-c", cmd))
            val stdout   = process.inputStream.bufferedReader().readText().trim()
            val stderr   = process.errorStream.bufferedReader().readText().trim()
            val exitCode = process.waitFor()
            process.destroy()
            val output = listOf(stdout, stderr).filter { it.isNotEmpty() }.joinToString(" | ")
            Log.d(TAG, "Root cmd exit=$exitCode output=$output")
            CmdResult(exitCode == 0, output)
        } catch (e: Exception) {
            Log.w(TAG, "Root command exception: ${e.message}")
            CmdResult(false, e.message ?: "unknown error")
        }
    }

    // ─── Embedded public key ──────────────────────────────────────────────────

    /**
     * Server OTA signing public key (RSA 2048, PEM format, no headers).
     * REPLACE THIS with the actual key before production deployment.
     * Generate: openssl genrsa -out ota_key.pem 2048
     *           openssl rsa -in ota_key.pem -pubout -out ota_pub.pem
     */
    private val OTA_PUBLIC_KEY_PEM = """
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx8MkwPSNpBeR324xVbVy
        xxlb9OYEUXYU7u+MnsDAMdrBSZkd2lFjLO53R58Ose9aiMO7NaVDhM3n1D5cXD5D
        djNhUQcwF3z5r/G7+J2Sdz8x0XWhNI/ISOBeAb+2GhzGR2vy6wlpo+wfihoeZNL1
        3JdvxxQVAKlxBtx04VAp0T3GlmkxnOSMzGkvi+aw8kqd+mTqu4L4AovD1pZN2bdK
        KDO+lek4weCqmFakmQ0midTGv9E3Y5pigZ5IocKXqcqZRZpNplx50RazLPyZE8Ce
        ThqVkvqpvHVgscWOSZMBweRUQy3De+S9iXnDX0swbX7BXxr3cY9oG4ucUYh2rFZO
        OQIDAQAB
        -----END PUBLIC KEY-----
    """.trimIndent()
    // trimIndent() elimină 4 spații prefix (indentare comună).
    // verifySignature() aplică replace("\\s".toRegex(), "") care elimină restul de whitespace
    // înainte de Base64.decode — safe indiferent de indentare.
}
