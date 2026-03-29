package com.phonenetwork.capture

import android.content.Context
import android.content.Intent
import android.media.ImageReader
import android.util.Log

/**
 * MediaProjectionHolder — STUB (inactive).
 *
 * MediaProjection has been replaced by root `su -c screencap` in CaptureController.
 * This file is kept as a stub to avoid breaking any import references.
 *
 * isReady always returns false.
 * All methods are no-ops.
 */
object MediaProjectionHolder {
    private const val TAG = "PhoneNet/Projection"

    const val PREFS_KEY_PERMISSION_GRANTED = "media_projection_granted"

    /** Always false — MediaProjection is not used. */
    val isReady: Boolean get() = false

    /** No-op — MediaProjection replaced by root screencap. */
    @Synchronized
    fun initialize(
        context: Context,
        grantIntent: Intent,
        width: Int   = 1080,
        height: Int  = 1920,
        density: Int = 420
    ) {
        Log.w(TAG, "initialize: MediaProjection is disabled — using root screencap instead")
    }

    /** Always null — no ImageReader in stub mode. */
    fun getImageReader(): ImageReader? = null

    /** Returns default dimensions (stub). */
    fun getScreenDimensions(): Triple<Int, Int, Int> = Triple(1080, 1920, 420)

    /** No-op. */
    @Synchronized
    fun release() {
        Log.d(TAG, "release: no-op (MediaProjection stub)")
    }
}
