package com.phonenetwork.capture

import org.json.JSONObject

object ScreenshotController {
    suspend fun screenshot(): JSONObject {
        return JSONObject().apply { put("availability", "stub") }
    }
    suspend fun screenRecord(params: JSONObject): JSONObject {
        return JSONObject().apply { put("availability", "stub") }
    }
}
