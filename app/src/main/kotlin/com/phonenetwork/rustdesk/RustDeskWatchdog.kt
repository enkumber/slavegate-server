package com.phonenetwork.rustdesk

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import com.phonenetwork.utils.BoundedProcessRunner

/**
 * RustDeskWatchdog — monitors and auto-configures RustDesk on rooted devices.
 *
 * Responsibilities:
 *   1. Detect if RustDesk is installed
 *   2. Auto-configure server/key via root (writes TOML + shared_prefs)
 *   3. Keep RustDesk running (restart if killed)
 *   4. Read RustDesk device ID for remote access
 *
 * Server/key are HARDCODED — not configurable via server push (security).
 */
object RustDeskWatchdog {

    private const val TAG = "PhoneNet/RustDesk"

    private const val RUSTDESK_PKG = "com.rustdesk.rustdesk"
    private const val RUSTDESK_DATA = "/data/data/$RUSTDESK_PKG"

    // ─── Hardcoded server config (security: never accept from server push) ───
    private const val RENDEZVOUS_SERVER = "enkzoned.go.ro"
    private const val RELAY_SERVER = "enkzoned.go.ro"
    private const val API_SERVER = "https://enkzoned.go.ro"
    private const val SERVER_KEY = "f2HnB5tetkZP+E6p+ff1d1knwfvI7rpBNzfRdhx33yE="
    private const val PERMANENT_PASSWORD = "Kukuruku123@"

    // ─── Config paths ────────────────────────────────────────────────────────
    private const val TOML_CONFIG_DIR = "$RUSTDESK_DATA/files/config"
    private const val TOML_CONFIG_FILE = "$TOML_CONFIG_DIR/RustDesk2.toml"
    private const val TOML_ID_FILE = "$TOML_CONFIG_DIR/RustDesk.toml"
    private const val SHARED_PREFS_DIR = "$RUSTDESK_DATA/shared_prefs"
    private const val SHARED_PREFS_FILE = "$SHARED_PREFS_DIR/${RUSTDESK_PKG}_preferences.xml"

    data class RustDeskStatus(
        val installed: Boolean,
        val configured: Boolean,
        val running: Boolean,
        val deviceId: String?
    )

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Full watchdog check — returns current RustDesk status.
     * Safe to call even if RustDesk is not installed.
     */
    fun check(context: Context): RustDeskStatus {
        val installed = isInstalled(context)
        if (!installed) {
            return RustDeskStatus(
                installed = false,
                configured = false,
                running = false,
                deviceId = null
            )
        }
        return RustDeskStatus(
            installed = true,
            configured = isConfigured(),
            running = isRunning(),
            deviceId = getDeviceId()
        )
    }

    /**
     * Ensure RustDesk is configured and running. Call from service heartbeat.
     * No-op if not installed.
     */
    fun ensureHealthy(context: Context): RustDeskStatus {
        val status = check(context)
        if (!status.installed) return status

        var configured = status.configured
        var running = status.running

        if (!configured) {
            Log.i(TAG, "RustDesk not configured — writing config")
            configureRustDesk()
            configured = isConfigured()
        }

        if (!running) {
            Log.i(TAG, "RustDesk not running — starting")
            startRustDesk()
            running = isRunning()
        }

        return RustDeskStatus(
            installed = true,
            configured = configured,
            running = running,
            deviceId = getDeviceId()
        )
    }

    // ─── Detection ───────────────────────────────────────────────────────────

    fun isInstalled(context: Context): Boolean {
        return try {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(RUSTDESK_PKG, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    fun isRunning(): Boolean {
        return try {
            val result = execRoot("pidof $RUSTDESK_PKG")
            result.exitCode == 0 && result.stdout.trim().isNotEmpty()
        } catch (e: Exception) {
            Log.w(TAG, "isRunning check failed: ${e.message}")
            false
        }
    }

    // ─── Configuration ───────────────────────────────────────────────────────

    fun isConfigured(): Boolean {
        return try {
            // Check TOML config first (preferred) — verify both server AND password
            val tomlResult = execRoot("cat $TOML_CONFIG_FILE 2>/dev/null")
            if (tomlResult.exitCode == 0 &&
                tomlResult.stdout.contains(RENDEZVOUS_SERVER) &&
                tomlResult.stdout.contains("permanent-password")) {
                return true
            }
            // Fallback: check shared_prefs
            val prefsResult = execRoot("cat $SHARED_PREFS_FILE 2>/dev/null")
            prefsResult.exitCode == 0 &&
                prefsResult.stdout.contains(RENDEZVOUS_SERVER) &&
                prefsResult.stdout.contains("permanent-password")
        } catch (e: Exception) {
            Log.w(TAG, "isConfigured check failed: ${e.message}")
            false
        }
    }

    fun configureRustDesk() {
        try {
            // 1. Discover what config paths exist
            val lsResult = execRoot("ls -la $RUSTDESK_DATA/ 2>/dev/null")
            Log.d(TAG, "RustDesk data dir: ${lsResult.stdout}")

            // 2. Get UID/GID of RustDesk data dir for correct ownership
            val ownerResult = execRoot("stat -c '%u:%g' $RUSTDESK_DATA")
            val owner = ownerResult.stdout.trim().ifEmpty { "10000:10000" }

            // 3. Force-stop RustDesk before writing config
            execRoot("am force-stop $RUSTDESK_PKG")

            // 4. Write TOML config (primary config format for RustDesk Android)
            writeTomlConfig(owner)

            // 5. Write shared_prefs config (fallback — some versions use this)
            writeSharedPrefsConfig(owner)

            // 6. Start RustDesk to pick up new config
            startRustDesk()

            // 7. Try setting password via broadcast (belt-and-suspenders — config file may suffice)
            try {
                Thread.sleep(2000) // Give RustDesk time to start
                execRoot(
                    "am broadcast -a com.rustdesk.rustdesk.SET_PASSWORD " +
                    "--es password '$PERMANENT_PASSWORD' " +
                    "-n $RUSTDESK_PKG/.MainReceiver"
                )
                Log.d(TAG, "Password broadcast sent")
            } catch (e: Exception) {
                Log.d(TAG, "Password broadcast failed (config file should still work): ${e.message}")
            }

            Log.i(TAG, "RustDesk configured successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to configure RustDesk: ${e.message}", e)
        }
    }

    private fun writeTomlConfig(owner: String) {
        try {
            // Ensure config directory exists
            execRoot("mkdir -p $TOML_CONFIG_DIR")

            // Read existing config to preserve other settings (like ID)
            val existing = execRoot("cat $TOML_CONFIG_FILE 2>/dev/null").stdout

            val tomlContent = if (existing.isNotEmpty() && existing.contains("=")) {
                // Update existing config — replace or append server settings
                var updated = existing
                updated = replaceOrAppendToml(updated, "rendezvous_server", "'$RENDEZVOUS_SERVER'")
                updated = replaceOrAppendToml(updated, "relay-server", "'$RELAY_SERVER'")
                updated = replaceOrAppendToml(updated, "key", "'$SERVER_KEY'")
                updated = replaceOrAppendToml(updated, "permanent-password", "'$PERMANENT_PASSWORD'")
                updated
            } else {
                // Write fresh config
                buildString {
                    appendLine("rendezvous_server = '$RENDEZVOUS_SERVER'")
                    appendLine("relay-server = '$RELAY_SERVER'")
                    appendLine("key = '$SERVER_KEY'")
                    appendLine("permanent-password = '$PERMANENT_PASSWORD'")
                }
            }

            // Write via heredoc
            execRoot("cat > $TOML_CONFIG_FILE << 'RUSTDESK_EOF'\n${tomlContent}RUSTDESK_EOF")
            execRoot("chmod 660 $TOML_CONFIG_FILE && chown $owner $TOML_CONFIG_FILE")
            execRoot("chmod 770 $TOML_CONFIG_DIR && chown $owner $TOML_CONFIG_DIR")

            Log.d(TAG, "TOML config written")
        } catch (e: Exception) {
            Log.w(TAG, "TOML config write failed: ${e.message}")
        }
    }

    private fun writeSharedPrefsConfig(owner: String) {
        try {
            execRoot("mkdir -p $SHARED_PREFS_DIR")

            val xml = """<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="custom-rendezvous-server">$RENDEZVOUS_SERVER</string>
    <string name="relay-server">$RELAY_SERVER</string>
    <string name="api-server">$API_SERVER</string>
    <string name="key">$SERVER_KEY</string>
    <string name="permanent-password">$PERMANENT_PASSWORD</string>
</map>"""

            execRoot("cat > $SHARED_PREFS_FILE << 'RUSTDESK_EOF'\n${xml}\nRUSTDESK_EOF")
            execRoot("chmod 660 $SHARED_PREFS_FILE && chown $owner $SHARED_PREFS_FILE")

            Log.d(TAG, "SharedPrefs config written")
        } catch (e: Exception) {
            Log.w(TAG, "SharedPrefs config write failed: ${e.message}")
        }
    }

    // ─── Start / Restart ─────────────────────────────────────────────────────

    fun startRustDesk() {
        try {
            execRoot("am start -n $RUSTDESK_PKG/.MainActivity")
            Log.i(TAG, "RustDesk start command sent")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start RustDesk: ${e.message}")
            // Fallback: use monkey
            try {
                execRoot("monkey -p $RUSTDESK_PKG -c android.intent.category.LAUNCHER 1")
            } catch (e2: Exception) {
                Log.e(TAG, "Monkey fallback also failed: ${e2.message}")
            }
        }
    }

    // ─── Device ID ───────────────────────────────────────────────────────────

    fun getDeviceId(): String? {
        return try {
            // RustDesk stores ID in RustDesk.toml (not RustDesk2.toml)
            val result = execRoot("cat $TOML_ID_FILE 2>/dev/null")
            if (result.exitCode != 0) {
                // Fallback: try RustDesk2.toml
                val result2 = execRoot("cat $TOML_CONFIG_FILE 2>/dev/null")
                return parseTomlValue(result2.stdout, "id")
            }
            parseTomlValue(result.stdout, "id")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read RustDesk ID: ${e.message}")
            null
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private fun replaceOrAppendToml(content: String, key: String, value: String): String {
        val regex = Regex("^\\s*${Regex.escape(key)}\\s*=.*$", RegexOption.MULTILINE)
        return if (regex.containsMatchIn(content)) {
            regex.replace(content, "$key = $value")
        } else {
            "$content\n$key = $value"
        }
    }

    private fun parseTomlValue(toml: String, key: String): String? {
        // Match: key = 'value' or key = "value" or key = value
        val regex = Regex("""^\s*${Regex.escape(key)}\s*=\s*['"]?([^'"\s]+)['"]?""", RegexOption.MULTILINE)
        return regex.find(toml)?.groupValues?.getOrNull(1)
    }

    /**
     * Execute a root command and return result. Properly closes all streams.
     */
    private fun execRoot(command: String): RootResult {
        try {
            val result = BoundedProcessRunner.runBlocking(arrayOf("su", "-c", command), 15_000L)
            return RootResult(result.exitCode ?: -1, result.output, if (result.success) "" else result.output)
        } catch (e: Exception) {
            Log.w(TAG, "Root exec failed: ${e.message}")
            return RootResult(-1, "", e.message ?: "unknown error")
        }
    }

    private data class RootResult(
        val exitCode: Int,
        val stdout: String,
        val stderr: String
    )
}
