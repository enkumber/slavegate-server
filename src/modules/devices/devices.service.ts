/**
 * modules/devices/devices.service.ts
 * Fleet registry — CRUD, status management, health tracking.
 * v3: +location_id, fleet of 7, WiFi with native IPs per physical location.
 */

import { getDb } from "../../db/client";
import type { DeviceHealth } from "../../../shared/protocol/messages";
import type {
  Device,
  DeviceStatus,
  UpdateDeviceRequest,
  PaginatedResponse,
} from "../../../shared/protocol/api-types";

export class DevicesService {
  // ─── Queries ──────────────────────────────────────────────────────────────

  async listDevices(page = 1, pageSize = 50, statusFilter?: string): Promise<PaginatedResponse<Device>> {
    const db = getDb();
    const offset = (page - 1) * pageSize;

    const whereClause = statusFilter ? `WHERE status = $3` : "";
    const params      = statusFilter
      ? [pageSize, offset, statusFilter]
      : [pageSize, offset];

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT * FROM devices ${whereClause}
         ORDER BY location_id NULLS LAST, friendly_name ASC LIMIT $1 OFFSET $2`,
        params
      ),
      db.query(
        statusFilter ? `SELECT COUNT(*) FROM devices WHERE status = $1` : `SELECT COUNT(*) FROM devices`,
        statusFilter ? [statusFilter] : []
      ),
    ]);

    return {
      items: rows.rows.map(rowToDevice),
      total: parseInt(countRow.rows[0].count, 10),
      page,
      pageSize,
    };
  }

  async listDevicesByLocation(): Promise<Record<string, Device[]>> {
    const db = getDb();
    const rows = await db.query(
      "SELECT * FROM devices WHERE status != 'maintenance' ORDER BY location_id NULLS LAST, friendly_name"
    );
    const grouped: Record<string, Device[]> = {};
    for (const row of rows.rows) {
      const device = rowToDevice(row);
      const key = device.locationId ?? "unassigned";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(device);
    }
    return grouped;
  }

  async getDevice(id: string): Promise<Device | null> {
    const db = getDb();
    const result = await db.query("SELECT * FROM devices WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;
    return rowToDevice(result.rows[0]);
  }

  async updateDevice(id: string, req: UpdateDeviceRequest): Promise<Device | null> {
    const db = getDb();
    const updates: string[] = [];
    const values: unknown[] = [id];

    const addField = (col: string, val: unknown) => {
      values.push(val);
      updates.push(`${col} = $${values.length}`);
    };

    if (req.friendlyName !== undefined) addField("friendly_name", req.friendlyName);
    if (req.locationId   !== undefined) addField("location_id",   req.locationId);
    if (req.isCanary     !== undefined) addField("is_canary",     req.isCanary);
    if (req.status       !== undefined) addField("status",        req.status);

    if (updates.length === 0) return this.getDevice(id);

    const result = await db.query(
      `UPDATE devices SET ${updates.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    if (result.rows.length === 0) return null;
    return rowToDevice(result.rows[0]);
  }

  async deleteDevice(id: string): Promise<boolean> {
    const db = getDb();

    // Hard delete — remove device and all related data.
    // Order matters: delete from referencing tables first to avoid FK violations.
    // Tables with device_id FK: accounts, auth_challenges, command_log, detection_events,
    // extracted_data, jobs, ota_deployment_devices, vlm_usage_log, workflows, device_tokens
    // Safe delete from all related tables (some may not exist in all deployments)
    const relatedTables = [
      'accounts', 'auth_challenges', 'command_log', 'detection_events',
      'extracted_data', 'jobs', 'ota_deployment_devices', 'vlm_usage_log',
      'workflows', 'device_tokens'
    ];
    for (const table of relatedTables) {
      await db.query(`DELETE FROM ${table} WHERE device_id = $1`, [id]).catch(() => {});
    }

    // Finally delete the device itself
    const result = await db.query(
      "DELETE FROM devices WHERE id = $1 RETURNING id",
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ─── WebSocket layer calls ────────────────────────────────────────────────

  async markOnline(deviceId: string, ipAddress: string): Promise<void> {
    const db = getDb();
    await db.query(
      `UPDATE devices
       SET status = 'online', last_seen_at = NOW(), last_ip = $1
       WHERE id = $2
         AND status NOT IN ('pending', 'maintenance')`,
      [ipAddress, deviceId]
    );
  }

  async markOffline(deviceId: string): Promise<void> {
    const db = getDb();
    await db.query(
      "UPDATE devices SET status = 'offline' WHERE id = $1 AND status = 'online'",
      [deviceId]
    );
  }

  async markAllOffline(): Promise<void> {
    const db = getDb();
    await db.query("UPDATE devices SET status = 'offline' WHERE status = 'online'");
    console.log("[devices] Startup: all devices marked offline — will go online at HELLO");
  }

  async updateHealth(deviceId: string, health: DeviceHealth): Promise<void> {
    const db = getDb();
    await db.query(
      "UPDATE devices SET health = $1, last_seen_at = NOW(), status = CASE WHEN status IN ('approved', 'online', 'offline') THEN 'online' ELSE status END WHERE id = $2",
      [JSON.stringify(health), deviceId]
    );

    // Alert thresholds — logs for now, Phase 4 adds Telegram alerting
    if (health.batteryLevel < 15 && !health.charging) {
      console.warn(`[health] Device ${deviceId}: low battery ${health.batteryLevel}% (not charging)`);
    }
    if (health.thermalStatus === "severe" || health.thermalStatus === "critical") {
      console.warn(`[health] Device ${deviceId}: thermal status = ${health.thermalStatus}`);
    }
    if (health.storageFreeBytes < 500 * 1024 * 1024) { // < 500MB
      console.warn(`[health] Device ${deviceId}: low storage ${Math.round(health.storageFreeBytes / 1024 / 1024)}MB free`);
    }
  }
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToDevice(row: Record<string, unknown>): Device {
  return {
    id:             row.id as string,
    hardwareUuid:   row.hardware_uuid as string,
    friendlyName:   row.friendly_name as string,
    model:          (row.model as string) ?? null,
    androidVersion: (row.android_version as string) ?? null,
    agentVersion:   (row.agent_version as string) ?? null,
    locationId:     (row.location_id as string) ?? null,
    isCanary:       (row.is_canary as boolean) ?? false,
    status:         row.status as DeviceStatus,
    lastSeenAt:     row.last_seen_at ? (row.last_seen_at as Date).toISOString() : null,
    lastIp:         (row.last_ip as string) ?? null,
    health:         (row.health as DeviceHealth) ?? null,
    createdAt:      (row.created_at as Date).toISOString(),
  };
}

export const devicesService = new DevicesService();
