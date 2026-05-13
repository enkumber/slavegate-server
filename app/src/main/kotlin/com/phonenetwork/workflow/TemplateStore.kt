package com.phonenetwork.workflow

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * TemplateStore — local cache of workflow templates on device.
 *
 * Templates are pushed from server via WORKFLOW_START messages or
 * pulled via HTTP GET /api/edge/templates. Stored locally as JSON files.
 *
 * Version-based update: if a template with same ID but newer version
 * is received, the old one is replaced.
 *
 * Storage: Internal storage directory "workflow_templates/"
 * Each template stored as: {templateId}_{version}.json
 *
 * Usage:
 *   val store = TemplateStore(context)
 *   store.saveTemplate(templateJson)  // save from WORKFLOW_START
 *   val tmpl = store.getTemplate("reddit_karma_farm")  // load locally
 *   val all = store.listTemplates()  // list all cached
 */
class TemplateStore(private val context: Context) {

    companion object {
        private const val TAG = "TemplateStore"
        private const val TEMPLATES_DIR = "workflow_templates"
        private const val PREFS = "template_prefs"
        private const val PREF_VERSIONS = "template_versions"  // templateId -> version
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val templatesDir = File(context.filesDir, TEMPLATES_DIR).also {
        if (!it.exists()) it.mkdirs()
    }

    /**
     * Save a template JSON to local storage.
     * Only saves if the version is newer than what's cached.
     *
     * @param templateJson Full template JSON (from WORKFLOW_START or HTTP pull)
     * @return true if template was saved (new or updated), false if already up-to-date
     */
    fun saveTemplate(templateJson: JSONObject): Boolean {
        val templateId = templateJson.optString("id", "")
        val version = templateJson.optString("version", "0.0.0")

        if (templateId.isEmpty()) {
            Log.w(TAG, "Template missing 'id' — cannot save")
            return false
        }

        // Check version
        val cachedVersion = prefs.getString("${PREF_VERSIONS}_$templateId", null)
        if (cachedVersion == version) {
            Log.d(TAG, "Template $templateId v$version already cached — skipping")
            return false
        }

        // Save to file
        val file = File(templatesDir, "${templateId}.json")
        file.writeText(templateJson.toString(2))

        // Update version mapping
        prefs.edit()
            .putString("${PREF_VERSIONS}_$templateId", version)
            .apply()

        Log.i(TAG, "Template saved: $templateId v$version")
        return true
    }

    /**
     * Load a template from local storage.
     *
     * @param templateId Template ID (e.g., "reddit_karma_farm")
     * @return Template JSON or null if not found
     */
    fun getTemplate(templateId: String): JSONObject? {
        val file = File(templatesDir, "$templateId.json")
        if (!file.exists()) {
            Log.d(TAG, "Template $templateId not cached")
            return null
        }

        return try {
            JSONObject(file.readText())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse template $templateId: ${e.message}")
            null
        }
    }

    /**
     * List all cached templates with their versions.
     */
    fun listTemplates(): List<TemplateInfo> {
        val templates = mutableListOf<TemplateInfo>()
        val files = templatesDir.listFiles { f -> f.extension == "json" } ?: return templates

        for (file in files) {
            try {
                val json = JSONObject(file.readText())
                templates.add(TemplateInfo(
                    id = json.optString("id", file.nameWithoutExtension),
                    name = json.optString("name", ""),
                    version = json.optString("version", "unknown"),
                    platform = json.optString("platform", "unknown"),
                    stepCount = json.optJSONArray("steps")?.length() ?: 0,
                ))
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read template ${file.name}: ${e.message}")
            }
        }

        return templates
    }

    /**
     * Delete a cached template.
     */
    fun deleteTemplate(templateId: String): Boolean {
        val file = File(templatesDir, "$templateId.json")
        val deleted = file.delete()
        prefs.edit().remove("${PREF_VERSIONS}_$templateId").apply()
        return deleted
    }

    /**
     * Get the version of a cached template.
     */
    fun getCachedVersion(templateId: String): String? {
        return prefs.getString("${PREF_VERSIONS}_$templateId", null)
    }

    /**
     * Check if a template needs update (newer version available).
     */
    fun needsUpdate(templateId: String, newVersion: String): Boolean {
        val cached = getCachedVersion(templateId) ?: return true
        return cached != newVersion
    }
}

data class TemplateInfo(
    val id: String,
    val name: String,
    val version: String,
    val platform: String,
    val stepCount: Int,
)
