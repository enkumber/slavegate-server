package com.phonenetwork.anti_detection

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * SensorNoiseCalculator — computes humanized sensor values for logging and validation.
 *
 * ⚠️ NOTE: This class does NOT inject sensor values into apps.
 * Real injection happens via LSPosed SensorHook.kt in the lspmod-cloak module.
 * This class is used for:
 *   1. Logging computed noise values for validation/audit
 *   2. Providing noise parameters to the agent for health reporting
 *   3. Reference implementation of the noise math (Box-Muller, drift, light)
 *
 * Actual injection flow:
 *   App → SensorManager.registerListener() → hooked by SensorHook.kt (LSPosed)
 *   → NoisyListenerProxy wraps original listener → modifies event.values before callback
 *
 * Reference: PHASE4_PLAN.md A3, lspmod-cloak/SensorHook.kt
 */
class SensorNoiseCalculator(context: Context) : SensorEventListener {

    companion object {
        private const val TAG = "PhoneNet/SensorNoise"
        private const val NOISE_SIGMA_ACCEL = 0.05f   // m/s² — Gaussian σ
        private const val GYRO_DRIFT_MAX    = 0.003f  // rad/s — max slow rotation
        private const val UPDATE_INTERVAL_MS = 500L
    }

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyroscope     = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val lightSensor   = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT)

    // Current noise offsets — slowly drifting over time
    private var tiltX = 0f
    private var tiltY = 0f
    private var gyroDriftX = 0f
    private var gyroDriftY = 0f
    private var gyroDriftZ = 0f
    private var targetLux  = 150f
    private var currentLux = 150f

    @Volatile private var running = false

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    fun start() {
        if (running) return
        running = true

        accelerometer?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        gyroscope?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        lightSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        Log.i(TAG, "Sensor noise injector started")
    }

    fun stop() {
        running = false
        sensorManager.unregisterListener(this)
        Log.i(TAG, "Sensor noise injector stopped")
    }

    // ─── SensorEventListener ──────────────────────────────────────────────────

    override fun onSensorChanged(event: SensorEvent) {
        if (!running) return
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> injectAccelNoise(event)
            Sensor.TYPE_GYROSCOPE     -> injectGyroNoise(event)
            Sensor.TYPE_LIGHT         -> injectLightVariation(event)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        // Not needed
    }

    // ─── Noise injection ──────────────────────────────────────────────────────

    private fun injectAccelNoise(event: SensorEvent) {
        // Gaussian noise: Box-Muller transform
        val noise = { gaussianUnit() * NOISE_SIGMA_ACCEL }

        // Slow tilt simulation: device moves slightly in hand
        tiltX += (Random.nextFloat() - 0.5f) * 0.002f
        tiltY += (Random.nextFloat() - 0.5f) * 0.002f
        tiltX = tiltX.coerceIn(-0.15f, 0.15f)
        tiltY = tiltY.coerceIn(-0.15f, 0.15f)

        // Apply noise + tilt to sensor values (does not modify real data — logging only)
        val x = event.values[0] + noise() + tiltX
        val y = event.values[1] + noise() + tiltY
        val z = event.values[2] + noise()

        // In a real Xposed module, these values would be intercepted and replaced.
        // Here we log the humanized values for validation.
        Log.v(TAG, "Accel: x=${"%.3f".format(x)} y=${"%.3f".format(y)} z=${"%.3f".format(z)}")
    }

    private fun injectGyroNoise(event: SensorEvent) {
        // Drift: very slow, realistic hand micro-movements
        gyroDriftX += (Random.nextFloat() - 0.5f) * 0.0002f
        gyroDriftY += (Random.nextFloat() - 0.5f) * 0.0002f
        gyroDriftZ += (Random.nextFloat() - 0.5f) * 0.0001f

        gyroDriftX = gyroDriftX.coerceIn(-GYRO_DRIFT_MAX, GYRO_DRIFT_MAX)
        gyroDriftY = gyroDriftY.coerceIn(-GYRO_DRIFT_MAX, GYRO_DRIFT_MAX)
        gyroDriftZ = gyroDriftZ.coerceIn(-GYRO_DRIFT_MAX / 2, GYRO_DRIFT_MAX / 2)

        val x = event.values[0] + gyroDriftX + gaussianUnit() * 0.001f
        val y = event.values[1] + gyroDriftY + gaussianUnit() * 0.001f
        val z = event.values[2] + gyroDriftZ + gaussianUnit() * 0.0005f

        Log.v(TAG, "Gyro: x=${"%.4f".format(x)} y=${"%.4f".format(y)} z=${"%.4f".format(z)}")
    }

    private fun injectLightVariation(event: SensorEvent) {
        // Ambient light: slow random walk (50-400 lux)
        if (Random.nextFloat() < 0.05f) {
            // Occasionally pick a new target lux (simulates environment change)
            targetLux = 50f + Random.nextFloat() * 350f
        }
        // Move toward target — slow transition
        currentLux += (targetLux - currentLux) * 0.02f
        val lux = currentLux + gaussianUnit() * 5f

        Log.v(TAG, "Light: ${"%.1f".format(lux)} lux")
    }

    // ─── Gaussian via Box-Muller ──────────────────────────────────────────────

    private var hasSpare = false
    private var spare    = 0f

    private fun gaussianUnit(): Float {
        if (hasSpare) {
            hasSpare = false
            return spare
        }
        var u: Float
        var v: Float
        var s: Float
        do {
            u = Random.nextFloat() * 2f - 1f
            v = Random.nextFloat() * 2f - 1f
            s = u * u + v * v
        } while (s >= 1f || s == 0f)
        val mul = sqrt(-2f * Math.log(s.toDouble()).toFloat() / s)
        spare    = v * mul
        hasSpare = true
        return u * mul
    }
}
