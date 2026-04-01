package com.phonenetwork.utils

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.view.WindowMetrics

/**
 * ScreenMetrics — Utility to get REAL screen dimensions (including nav bar).
 *
 * CRITICAL BUG FIX:
 * - displayMetrics.heightPixels returns height EXCLUDING navigation bar (e.g., 2034px)
 * - UI tree bounds use the FULL screen including nav bar (2160px)
 * - This mismatch caused skill_tap with normalized coords to tap in wrong locations
 *
 * Solution: Use getRealDimensions() everywhere for consistent dimensions.
 * - API 30+ (Android 11+): Uses WindowMetrics
 * - API < 30: Uses getRealMetrics() (deprecated but functional)
 */
object ScreenMetrics {
    private const val TAG = "ScreenMetrics"
    
    /**
     * Get real screen dimensions including navigation bar.
     * Returns Pair(width, height) in pixels.
     */
    fun getRealDimensions(context: Context): Pair<Int, Int> {
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // API 30+ (Android 11+): Use WindowMetrics
            val windowMetrics: WindowMetrics = windowManager.currentWindowMetrics
            val bounds = windowMetrics.bounds
            val width = bounds.width()
            val height = bounds.height()
            Log.d(TAG, "getRealDimensions (WindowMetrics API 30+): ${width}x${height}")
            Pair(width, height)
        } else {
            // API < 30: Use deprecated getRealMetrics
            val realMetrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getRealMetrics(realMetrics)
            val width = realMetrics.widthPixels
            val height = realMetrics.heightPixels
            Log.d(TAG, "getRealDimensions (getRealMetrics legacy): ${width}x${height}")
            Pair(width, height)
        }
    }
    
    /**
     * Get real screen width including any system UI.
     */
    fun getRealWidth(context: Context): Int = getRealDimensions(context).first
    
    /**
     * Get real screen height including navigation bar.
     */
    fun getRealHeight(context: Context): Int = getRealDimensions(context).second
    
    /**
     * Debug: Log comparison between different dimension methods.
     * Call this during testing to verify correct values.
     */
    fun logDimensionComparison(context: Context) {
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        
        // Method 1: displayMetrics (WRONG - excludes nav bar)
        val displayMetrics = context.resources.displayMetrics
        val wrongWidth = displayMetrics.widthPixels
        val wrongHeight = displayMetrics.heightPixels
        
        // Method 2: getRealDimensions (CORRECT)
        val (realWidth, realHeight) = getRealDimensions(context)
        
        Log.i(TAG, "=== SCREEN DIMENSION COMPARISON ===")
        Log.i(TAG, "displayMetrics (WRONG): ${wrongWidth}x${wrongHeight}")
        Log.i(TAG, "getRealDimensions (CORRECT): ${realWidth}x${realHeight}")
        Log.i(TAG, "Difference: ${realHeight - wrongHeight}px (nav bar height)")
        Log.i(TAG, "Android API: ${Build.VERSION.SDK_INT}, Device: ${Build.MODEL}")
        Log.i(TAG, "===================================")
    }
}
