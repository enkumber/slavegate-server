package com.phonenetwork.anti_detection

import android.util.Log
import kotlinx.coroutines.*
import java.net.InetAddress
import kotlin.random.Random

/**
 * DnsBackgroundService — periodic DNS queries for traffic diversification.
 *
 * Why: A device that ONLY resolves social media domains has a suspicious DNS profile.
 * Real human devices query news, weather, maps, shopping, etc.
 *
 * Strategy:
 * - Resolve 3-8 domains every 5-15 minutes (random interval)
 * - Domain pool: popular consumer sites across categories
 * - DNS queries are non-blocking, fire-and-forget
 * - NO actual HTTP connections — just DNS resolution (zero bandwidth cost)
 *
 * Lifecycle: start() in AgentForegroundService.onStartCommand()
 *            stop() in AgentForegroundService.onDestroy()
 */
object DnsBackgroundService {
    private const val TAG = "PhoneNet/Dns"

    private val DOMAIN_POOL = listOf(
        // News
        "bbc.com", "cnn.com", "reuters.com", "theguardian.com", "digi24.ro",
        // Weather
        "weather.com", "yr.no", "accuweather.com",
        // Shopping
        "amazon.com", "emag.ro", "ebay.com", "aliexpress.com",
        // Maps / travel
        "maps.google.com", "waze.com", "booking.com", "airbnb.com",
        // Video / entertainment
        "youtube.com", "netflix.com", "spotify.com", "twitch.tv",
        // Tech
        "github.com", "stackoverflow.com", "reddit.com",
        // Finance
        "paypal.com", "revolut.com",
        // Social (not the target platforms — already in app traffic)
        "linkedin.com", "pinterest.com",
        // Local / CDNs
        "cloudflare.com", "fastly.net", "akamaiedge.net",
    )

    private val MIN_INTERVAL_MS = 5 * 60_000L   // 5 minutes
    private val MAX_INTERVAL_MS = 15 * 60_000L  // 15 minutes
    private val MIN_DOMAINS     = 3
    private val MAX_DOMAINS     = 8

    private var job: Job? = null

    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            Log.i(TAG, "DNS diversification started")
            while (isActive) {
                val delayMs = MIN_INTERVAL_MS + (Random.nextFloat() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS)).toLong()
                delay(delayMs)
                resolveBatch()
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        Log.i(TAG, "DNS diversification stopped")
    }

    private suspend fun resolveBatch() {
        val count   = MIN_DOMAINS + Random.nextInt(MAX_DOMAINS - MIN_DOMAINS + 1)
        val domains = DOMAIN_POOL.shuffled().take(count)
        Log.d(TAG, "Resolving ${domains.size} domains for traffic diversification")

        for (domain in domains) {
            try {
                withContext(Dispatchers.IO) {
                    InetAddress.getByName(domain)  // DNS lookup only — no connection
                }
                // Small random pause between lookups (2-8s) — human-like browsing
                delay(2_000L + (Random.nextFloat() * 6_000).toLong())
            } catch (e: Exception) {
                // DNS failures are expected and ignored — some domains may be geo-blocked
                Log.v(TAG, "DNS miss for $domain: ${e.message}")
            }
        }
    }
}
