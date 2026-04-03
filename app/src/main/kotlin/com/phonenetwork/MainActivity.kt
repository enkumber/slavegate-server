package com.phonenetwork

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
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
import com.phonenetwork.nostr.EnrollmentStore
import com.phonenetwork.qr.QrScannerActivity
import com.phonenetwork.service.AgentForegroundService

/**
 * MainActivity — setup screen for Nostr enrollment via QR code.
 *
 * Flow:
 * 1. Check if device is enrolled (EnrollmentStore has valid v2 data)
 * 2. If NO → show "Scan QR" button, open QrScannerActivity
 * 3. If YES → start AgentForegroundService
 *
 * QR payload format (v2):
 * {
 *   "v": 2,
 *   "s": "<serverPubkey_hex>",  // 64 chars
 *   "r": ["wss://relay1", ...], // relay URLs
 *   "d": "<deviceId_uuid>"      // pre-assigned device ID
 * }
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
            Log.i(tag, "QR enrollment saved — starting service")
            AgentForegroundService.start(this)
            updateUI()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(tag, "MainActivity created")

        // Request battery optimization exclusion on first launch
        requestBatteryOptimizationExclusion()

        if (EnrollmentStore.hasEnrollment(this)) {
            Log.i(tag, "Device enrolled — starting service")
            AgentForegroundService.start(this)
        } else {
            Log.i(tag, "Device not enrolled — show QR scan UI")
        }

        buildUI()
    }

    override fun onResume() {
        super.onResume()
        updateUI()
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

        // Scan QR button (enrollment)
        val scanButton = Button(this).apply {
            tag = "scan_btn"
            text = "📷 Scan Enrollment QR"
            textSize = 16f
            setOnClickListener {
                qrScannerLauncher.launch(Intent(this@MainActivity, QrScannerActivity::class.java))
            }
        }
        layout.addView(scanButton)

        // Re-enroll button (if already enrolled)
        val rescanButton = Button(this).apply {
            tag = "rescan_btn"
            text = "🔄 Re-enroll (scan new QR)"
            textSize = 14f
            setOnClickListener {
                EnrollmentStore.clear(this@MainActivity)
                AgentForegroundService.stop(this@MainActivity)
                qrScannerLauncher.launch(Intent(this@MainActivity, QrScannerActivity::class.java))
            }
        }
        layout.addView(rescanButton)

        setContentView(layout)
        updateUI()
    }

    private fun updateUI() {
        val isEnrolled = EnrollmentStore.hasEnrollment(this)
        val statusText = window.decorView.findViewWithTag<TextView>("status")
        val scanButton = window.decorView.findViewWithTag<Button>("scan_btn")
        val rescanButton = window.decorView.findViewWithTag<Button>("rescan_btn")

        if (isEnrolled) {
            val enrollment = EnrollmentStore.getEnrollment(this)
            val deviceId = enrollment?.deviceId?.take(8) ?: "?"
            val relayCount = enrollment?.relayUrls?.size ?: 0
            statusText?.text = "✅ Enrolled (device: $deviceId…)\n🔌 Service running — $relayCount relay(s)"
            scanButton?.visibility = android.view.View.GONE
            rescanButton?.visibility = android.view.View.VISIBLE
        } else {
            statusText?.text = "⚠️ Not enrolled\nScan enrollment QR code to connect"
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
