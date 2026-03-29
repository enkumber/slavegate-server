package com.phonenetwork

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.phonenetwork.qr.QrScannerActivity
import com.phonenetwork.service.AgentForegroundService
import com.phonenetwork.wireguard.WireGuardManager

/**
 * MainActivity — setup screen with WireGuard QR scanning and VPN permission.
 *
 * Flow:
 * 1. Check if WireGuard config exists
 * 2. If NO → show "Scan QR" button, open QrScannerActivity
 * 3. If YES → request VPN permission if needed → start service
 *
 * VPN permission: GoBackend requires Android VPN consent dialog (one-time).
 * On rooted devices, autoGrantVpnPermission() bypasses the dialog via appops.
 *
 * Note: This activity is for device operator setup only.
 * All automation happens in AgentForegroundService (headless).
 */
class MainActivity : AppCompatActivity() {

    private val tag = "PhoneNet/Main"

    private val qrScannerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == QrScannerActivity.RESULT_CONFIG_SAVED) {
            Log.i(tag, "QR config saved — requesting VPN permission and starting service")
            requestVpnPermissionAndStart()
            updateUI()
        }
    }

    private val vpnPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        Log.i(tag, "VPN permission result: ${result.resultCode}")
        // Start service regardless — it will handle VPN state internally
        AgentForegroundService.start(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(tag, "MainActivity created")

        // Request battery optimization exclusion on first launch
        requestBatteryOptimizationExclusion()

        // Initialize WireGuard GoBackend
        WireGuardManager.initBackend(this)

        // Auto-grant VPN permission via root (Magisk) — no user interaction needed
        autoGrantVpnPermission()

        // Always start the service — WireGuard config is optional.
        // Config will be pushed via WebSocket (WG_CONFIG) after authentication.
        if (WireGuardManager.hasConfig(this)) {
            Log.i(tag, "Has WG config — requesting VPN permission and starting service")
            requestVpnPermissionAndStart()
        } else {
            Log.i(tag, "No WG config — starting service without VPN (will use relay)")
            AgentForegroundService.start(this)
        }

        buildUI()
    }

    override fun onResume() {
        super.onResume()
        updateUI()
    }

    /**
     * Request VPN permission via system dialog, then start service.
     * If already granted (or auto-granted via root), starts immediately.
     */
    private fun requestVpnPermissionAndStart() {
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent != null) {
            Log.i(tag, "VPN permission needed — launching consent dialog")
            vpnPermissionLauncher.launch(vpnIntent)
        } else {
            Log.i(tag, "VPN permission already granted ✓")
            AgentForegroundService.start(this)
        }
    }

    /**
     * Auto-grant VPN permission via root (appops set ACTIVATE_VPN allow).
     * Bypasses the Android VPN consent dialog on rooted (Magisk) devices.
     * Safe to call multiple times — idempotent.
     */
    private fun autoGrantVpnPermission() {
        try {
            val proc = Runtime.getRuntime().exec(arrayOf(
                "su", "-c",
                "appops set $packageName ACTIVATE_VPN allow"
            ))
            val exitCode = proc.waitFor()
            if (exitCode == 0) {
                Log.i(tag, "VPN permission auto-granted via root ✓")
            } else {
                Log.w(tag, "appops set ACTIVATE_VPN failed (exit=$exitCode)")
            }
            proc.inputStream.close()
            proc.errorStream.close()
            proc.destroy()
        } catch (e: Exception) {
            Log.w(tag, "autoGrantVpnPermission failed: ${e.message}")
        }
    }

    private fun buildUI() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
            setBackgroundColor(0xFF1a1a2e.toInt())
        }

        // Title
        val title = TextView(this).apply {
            text = "📱 Phone Network Agent"
            textSize = 24f
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(0, 0, 0, 32)
        }
        layout.addView(title)

        // Status text
        val statusText = TextView(this).apply {
            tag = "status"
            textSize = 16f
            setTextColor(0xFFaaaaaa.toInt())
            setPadding(0, 0, 0, 48)
        }
        layout.addView(statusText)

        // Scan QR button
        val scanButton = Button(this).apply {
            tag = "scan_btn"
            text = "📷 Scan WireGuard QR"
            textSize = 16f
            setOnClickListener {
                qrScannerLauncher.launch(Intent(this@MainActivity, QrScannerActivity::class.java))
            }
        }
        layout.addView(scanButton)

        // Re-scan button (if already configured)
        val rescanButton = Button(this).apply {
            tag = "rescan_btn"
            text = "🔄 Re-scan QR (new config)"
            textSize = 14f
            setOnClickListener {
                WireGuardManager.clearConfig(this@MainActivity)
                qrScannerLauncher.launch(Intent(this@MainActivity, QrScannerActivity::class.java))
            }
        }
        layout.addView(rescanButton)

        setContentView(layout)
        updateUI()
    }

    private fun updateUI() {
        val hasConfig = WireGuardManager.hasConfig(this)
        val statusText = window.decorView.findViewWithTag<TextView>("status")
        val scanButton = window.decorView.findViewWithTag<Button>("scan_btn")
        val rescanButton = window.decorView.findViewWithTag<Button>("rescan_btn")

        if (hasConfig) {
            statusText?.text = "✅ WireGuard configured\n🔌 Service running"
            scanButton?.visibility = android.view.View.GONE
            rescanButton?.visibility = android.view.View.VISIBLE
        } else {
            statusText?.text = "⚠️ No WireGuard config\nScan QR code to connect"
            scanButton?.visibility = android.view.View.VISIBLE
            rescanButton?.visibility = android.view.View.GONE
        }
    }

    /**
     * Request battery optimization exclusion via system dialog.
     */
    private fun requestBatteryOptimizationExclusion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            Log.i(tag, "Battery optimization already excluded ✓")
            return
        }
        Log.i(tag, "Requesting battery optimization exclusion")
        AlertDialog.Builder(this)
            .setTitle("Battery Optimization")
            .setMessage(
                "Phone Network Agent needs to be excluded from battery optimization " +
                "to maintain a stable connection when the screen is off.\n\n" +
                "Tap OK to open the system dialog."
            )
            .setPositiveButton("OK") { _, _ ->
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    Log.w(tag, "Could not open battery optimization dialog: ${e.message}")
                }
            }
            .setNegativeButton("Later", null)
            .show()
    }
}
