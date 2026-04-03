/**
 * nostr/device-registry.ts
 * In-memory device registry: pubkey ↔ deviceId mapping + online status tracking.
 *
 * Populated at startup from DB and kept current via DEVICE_HELLO and HEARTBEAT events.
 * Online detection uses a 90-second threshold (3× heartbeat interval of 30s).
 */

import type { Pool } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeviceEntry {
  deviceId: string;
  pubkey: string;
  lastSeenAt: number;  // epoch ms
}

// ─── DeviceRegistry ───────────────────────────────────────────────────────────

export const OFFLINE_THRESHOLD_MS = 90_000; // 3× heartbeat interval

export class DeviceRegistry {
  /** pubkey → entry */
  private byPubkey = new Map<string, DeviceEntry>();
  /** deviceId → pubkey */
  private byDeviceId = new Map<string, string>();

  constructor(private readonly db: Pool) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Load existing pubkey <-> deviceId mappings from the DB at startup.
   * Devices that were online before a restart will appear offline until their
   * next heartbeat arrives (within 90s).
   */
  async loadFromDb(): Promise<void> {
    const result = await this.db.query<{
      id: string;
      nostr_pubkey: string | null;
    }>(
      "SELECT id, nostr_pubkey FROM devices WHERE nostr_pubkey IS NOT NULL"
    );

    for (const row of result.rows) {
      if (!row.nostr_pubkey) continue;
      const entry: DeviceEntry = {
        deviceId: row.id,
        pubkey: row.nostr_pubkey,
        lastSeenAt: 0,  // unknown — will update on first heartbeat
      };
      this.byPubkey.set(row.nostr_pubkey, entry);
      this.byDeviceId.set(row.id, row.nostr_pubkey);
    }

    console.log(
      `[nostr:registry] Loaded ${this.byPubkey.size} device(s) from DB.`
    );
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  /**
   * Register or update a pubkey ↔ deviceId mapping.
   * Updates the DB column and the in-memory maps.
   */
  async register(pubkey: string, deviceId: string): Promise<void> {
    // Remove old pubkey entry if this deviceId had a different pubkey
    const oldPubkey = this.byDeviceId.get(deviceId);
    if (oldPubkey && oldPubkey !== pubkey) {
      this.byPubkey.delete(oldPubkey);
    }

    const entry: DeviceEntry = {
      deviceId,
      pubkey,
      lastSeenAt: 0,  // Only markSeen() updates this — device not online until first heartbeat
    };
    this.byPubkey.set(pubkey, entry);
    this.byDeviceId.set(deviceId, pubkey);

    // Persist to DB
    await this.db.query(
      "UPDATE devices SET nostr_pubkey = $1 WHERE id = $2",
      [pubkey, deviceId]
    );
  }

  // ─── Lookups ───────────────────────────────────────────────────────────────

  lookupDeviceId(pubkey: string): string | null {
    return this.byPubkey.get(pubkey)?.deviceId ?? null;
  }

  lookupPubkey(deviceId: string): string | null {
    return this.byDeviceId.get(deviceId) ?? null;
  }

  // ─── Online tracking ───────────────────────────────────────────────────────

  /**
   * Mark a device as recently seen (call on every heartbeat or DEVICE_HELLO).
   */
  markSeen(pubkey: string): void {
    const entry = this.byPubkey.get(pubkey);
    if (entry) {
      entry.lastSeenAt = Date.now();
    } else {
      // Seen an unknown pubkey — create a placeholder entry
      // (will be properly registered on DEVICE_HELLO handling)
      this.byPubkey.set(pubkey, {
        deviceId: "",
        pubkey,
        lastSeenAt: Date.now(),
      });
    }
  }

  /**
   * Returns true if the device sent a heartbeat within the last 90 seconds.
   */
  isOnline(pubkey: string): boolean {
    const entry = this.byPubkey.get(pubkey);
    if (!entry || entry.lastSeenAt === 0) return false;
    return Date.now() - entry.lastSeenAt < OFFLINE_THRESHOLD_MS;
  }

  /**
   * Returns pubkeys of all devices currently considered online.
   */
  getOnlineDevices(): string[] {
    const now = Date.now();
    return [...this.byPubkey.values()]
      .filter(
        (e) => e.lastSeenAt > 0 && now - e.lastSeenAt < OFFLINE_THRESHOLD_MS
      )
      .map((e) => e.pubkey);
  }

  /**
   * Returns deviceIds of all devices currently considered online.
   */
  getOnlineDeviceIds(): string[] {
    return this.getOnlineDevices()
      .map((pk) => this.byPubkey.get(pk)?.deviceId)
      .filter((id): id is string => !!id && id.length > 0);
  }

  /**
   * Returns the last seen timestamp (epoch ms) for a pubkey, or 0 if unknown.
   */
  getLastSeen(pubkey: string): number {
    return this.byPubkey.get(pubkey)?.lastSeenAt ?? 0;
  }

  /** Total number of registered devices (online + offline). */
  get size(): number {
    return this.byPubkey.size;
  }
}
