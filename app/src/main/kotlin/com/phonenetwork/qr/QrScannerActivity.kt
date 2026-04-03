package com.phonenetwork.qr

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.phonenetwork.nostr.EnrollmentStore
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * QrScannerActivity — scans Nostr enrollment QR codes (v2 format).
 *
 * Uses CameraX + ML Kit Barcode Scanning.
 * On successful scan, saves enrollment via EnrollmentStore and returns success.
 *
 * Expected QR payload:
 * { "v": 2, "s": "<serverPubkey>", "r": ["wss://relay..."], "d": "<deviceId>" }
 * OR base64-encoded version of the same JSON.
 */
class QrScannerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PhoneNet/QR"
        const val RESULT_CONFIG_SAVED = 100
    }

    private lateinit var previewView: PreviewView
    private lateinit var statusText: TextView
    private lateinit var cameraExecutor: ExecutorService
    private val isProcessing = AtomicBoolean(false)

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startCamera()
        } else {
            Toast.makeText(this, "Camera permission required for QR scanning", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Create UI programmatically (no XML)
        val container = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(0xFF000000.toInt())
        }

        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        container.addView(previewView)

        // Overlay text
        statusText = TextView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 100
            }
            text = "📱 Point camera at enrollment QR code"
            textSize = 18f
            setTextColor(0xFFFFFFFF.toInt())
            textAlignment = TextView.TEXT_ALIGNMENT_CENTER
            setPadding(32, 16, 32, 16)
            setBackgroundColor(0x88000000.toInt())
        }
        container.addView(statusText)

        setContentView(container)

        cameraExecutor = Executors.newSingleThreadExecutor()

        // Check/request camera permission
        when {
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED -> {
                startCamera()
            }
            else -> {
                requestPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)

        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            val imageAnalyzer = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also {
                    it.setAnalyzer(cameraExecutor, QrCodeAnalyzer { qrContent ->
                        handleQrCode(qrContent)
                    })
                }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageAnalyzer
                )
                Log.i(TAG, "Camera started")
            } catch (e: Exception) {
                Log.e(TAG, "Camera bind failed: ${e.message}")
                Toast.makeText(this, "Camera error: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun handleQrCode(content: String) {
        // Prevent multiple processing
        if (!isProcessing.compareAndSet(false, true)) return

        Log.i(TAG, "QR scanned: ${content.take(80)}...")

        runOnUiThread {
            statusText.text = "✅ QR detected! Processing..."
        }

        // Try to parse as v2 Nostr enrollment payload
        val saved = try {
            EnrollmentStore.saveFromQrContent(this, content)
        } catch (e: Exception) {
            Log.e(TAG, "EnrollmentStore.saveFromQrContent failed: ${e.message}")
            false
        }

        if (!saved) {
            Log.w(TAG, "Invalid QR — not a valid v2 enrollment payload: ${content.take(80)}")
            runOnUiThread {
                statusText.text = "❌ Invalid QR — expected enrollment code\n{v:2, s:..., r:[...], d:...}"
                Toast.makeText(this, "Scan a valid enrollment QR code (v2)", Toast.LENGTH_LONG).show()
            }
            isProcessing.set(false)
            return
        }

        val enrollment = EnrollmentStore.getEnrollment(this)
        Log.i(TAG, "Enrollment saved: deviceId=${enrollment?.deviceId?.take(8)} relays=${enrollment?.relayUrls?.size}")

        runOnUiThread {
            statusText.text = "✅ Enrolled! Starting agent..."
            Toast.makeText(this, "Enrollment successful!", Toast.LENGTH_SHORT).show()
        }

        // Return success to MainActivity
        setResult(RESULT_CONFIG_SAVED)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
    }

    /**
     * QR Code Analyzer using ML Kit
     */
    private inner class QrCodeAnalyzer(
        private val onQrDetected: (String) -> Unit
    ) : ImageAnalysis.Analyzer {

        private val scanner = BarcodeScanning.getClient()

        @androidx.camera.core.ExperimentalGetImage
        override fun analyze(imageProxy: androidx.camera.core.ImageProxy) {
            val mediaImage = imageProxy.image
            if (mediaImage != null) {
                val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)

                scanner.process(image)
                    .addOnSuccessListener { barcodes ->
                        for (barcode in barcodes) {
                            if (barcode.valueType == Barcode.TYPE_TEXT) {
                                barcode.rawValue?.let { content ->
                                    onQrDetected(content)
                                }
                            }
                        }
                    }
                    .addOnFailureListener { e ->
                        Log.w(TAG, "Barcode scan failed: ${e.message}")
                    }
                    .addOnCompleteListener {
                        imageProxy.close()
                    }
            } else {
                imageProxy.close()
            }
        }
    }
}
