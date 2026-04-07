package com.phonenetwork

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.phonenetwork.service.AgentForegroundService

/**
 * MainActivity — shows connection status, version, and download button.
 * No enrollment needed — DirectWs auto-discovers the server.
 */
class MainActivity : AppCompatActivity() {

    private val tag = "PhoneNet/Main"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(tag, "MainActivity created")

        // Start the agent service
        AgentForegroundService.start(this)

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

        // Status
        val statusText = TextView(this).apply {
            tag = "status"
            textSize = 16f
            setTextColor(0xFFaaaaaa.toInt())
            setPadding(0, 0, 0, 48)
        }
        layout.addView(statusText)

        // Download Update Button
        val downloadButton = Button(this).apply {
            text = "⬇️ Download Update"
            textSize = 16f
            setOnClickListener {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("http://enkzoned.go.ro:3000/api/apk/download"))
                startActivity(intent)
            }
        }
        layout.addView(downloadButton)

        // Version
        val versionText = TextView(this).apply {
            tag = "version"
            textSize = 14f
            setTextColor(0xFF666666.toInt())
        }
        try {
            val version = packageManager.getPackageInfo(packageName, 0).versionName
            versionText.text = "v$version"
        } catch (e: Exception) {
            versionText.text = "v?"
        }
        layout.addView(versionText)

        setContentView(layout)
        updateUI()
    }

    private fun updateUI() {
        val statusText = window.decorView.findViewWithTag<TextView>("status")

        // Check DirectWs status
        val directWsPrefs = getSharedPreferences("phone_network_direct", MODE_PRIVATE)
        val dwEnabled = directWsPrefs.getBoolean("direct_ws_enabled", false)
        val dwDeviceId = directWsPrefs.getString("direct_ws_device_id", null)

        if (dwEnabled && dwDeviceId != null) {
            val shortId = dwDeviceId.take(8)
            statusText?.text = "✅ Connected\nDevice: $shortId…"
        } else {
            statusText?.text = "⏳ Connecting…"
        }
    }
}
