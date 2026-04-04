package com.phonenetwork.nostr

/**
 * Default Nostr configuration.
 * These values are used when no enrollment data is present,
 * allowing auto-discovery flow (DEVICE_HELLO → pending → approve in dashboard).
 */
object NostrConfig {
    /** Server public key (hex, 64 chars) */
    const val SERVER_PUBKEY = "32f8ea9266125773e9100496d9744ca827379caa09f55593b5e649d480cbaf9d"

    /** Default relay URLs — public relays for remote devices */
    val DEFAULT_RELAYS = listOf(
        "wss://relay.damus.io",
        "wss://nos.lol"
    )
}
