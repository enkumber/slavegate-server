/**
 * nostr/handlers.ts
 * Wires Nostr message router to existing services.
 *
 * Sprint 2: Full integration with dispatcherService, devicesService.
 */

import type { Event as NostrEvent } from "nostr-tools";
import type { MessageHandlers } from "./message-router";
import { DeviceRegistry } from "./device-registry";
import { getDb } from "../db/client";
import { devicesService } from "../modules/devices/devices.service";
import { getNostrAdapterImpl } from "./adapter";

// ─── Payload Types ──────────────────────────────────────────────────────────

interface JobResultPayload {
  success?: boolean;
  result?: unknown;
  error?: string;
}

interface HeartbeatPayload {
  batteryLevel?: number;
  charging?: boolean;
  networkType?: string;
  publicIp?: string;
  activeApp?: string;
  thermalStatus?: string;
  storageFreeBytes?: number;
}

interface DeviceHelloPayload {
  model?: string;
  androidVersion?: string;
  agentVersion?: string;
  imei?: string;
}

interface VisionRequestPayload {
  screenshot?: string; // base64
  query?: string;
  jobId?: string;
}

// ─── Handler Factory ────────────────────────────────────────────────────────

export function createHandlers(
  registry: DeviceRegistry,
  _serverSk: Uint8Array // Reserved for future use (signing responses)
): MessageHandlers {
  return {
    // ───────────────────────────────────────────────────────────────────────
    // JOB_RESULT: Device completed a job
    // ───────────────────────────────────────────────────────────────────────
    onJobResult: async (
      pubkey: string,
      payload: object,
      event: NostrEvent
    ): Promise<void> => {
      const deviceId = registry.lookupDeviceId(pubkey);
      if (!deviceId) {
        console.warn(
          `[handlers] JOB_RESULT from unknown pubkey ${pubkey.slice(0, 8)}`
        );
        return;
      }

      // Extract job ID from tags
      const jobIdTag = event.tags.find((t) => t[0] === "job");
      const jobId = jobIdTag?.[1];

      console.log(
        `[handlers] JOB_RESULT: device=${deviceId.slice(0, 8)} job=${jobId?.slice(0, 8)}`
      );

      const typedPayload = payload as JobResultPayload;

      // Resolve pending job (T3: Job Timeout Handler)
      if (jobId) {
        const adapter = getNostrAdapterImpl();
        if (adapter) {
          adapter.resolveJob(
            jobId,
            typedPayload.success ? typedPayload.result : typedPayload.error,
            typedPayload.success ?? false
          );
        }
      }

      // Log result for debugging
      console.log(
        `[handlers] Result: success=${typedPayload.success}${
          typedPayload.error ? ` error="${typedPayload.error}"` : ""
        }`
      );

      // TODO Sprint 3: Wire to dispatcherService.handleJobResult() or orchestrator
      // Example:
      // await dispatcherService.handleJobResult(deviceId, jobId, typedPayload);
    },

    // ───────────────────────────────────────────────────────────────────────
    // HEARTBEAT: Device sent health status
    // ───────────────────────────────────────────────────────────────────────
    onHeartbeat: async (
      pubkey: string,
      payload: object,
      _event: NostrEvent
    ): Promise<void> => {
      let deviceId = registry.lookupDeviceId(pubkey);
      if (!deviceId) {
        // Auto-register unknown device from heartbeat
        console.log(`[handlers] HEARTBEAT from new pubkey ${pubkey.slice(0, 8)} — auto-registering`);
        const db = getDb();
        const { v4: uuidv4 } = await import("uuid");
        deviceId = uuidv4();
        await db.query(
          `INSERT INTO devices (id, friendly_name, status, nostr_pubkey, created_at) VALUES ($1, $2, 'pending', $3, NOW())`,
          [deviceId, `Device-${pubkey.slice(0, 8)}`, pubkey]
        );
        registry.register(pubkey, deviceId);
        console.log(`[handlers] Auto-registered device ${deviceId} for pubkey ${pubkey.slice(0, 8)}`);
      }

      // Update DB last_seen_at
      const db = getDb();
      await db.query("UPDATE devices SET last_seen_at = NOW() WHERE id = $1", [
        deviceId,
      ]);

      // Parse health data
      const health = payload as HeartbeatPayload;

      // Update device health via existing service
      // Cast to appropriate union types defined in shared/protocol/messages.ts
      const networkType = (health.networkType ?? "none") as "wifi" | "mobile" | "ethernet" | "none";
      const thermalStatus = (health.thermalStatus ?? "nominal") as "nominal" | "light" | "moderate" | "severe" | "critical";

      await devicesService.updateHealth(deviceId, {
        batteryLevel: health.batteryLevel ?? 0,
        charging: health.charging ?? false,
        networkType,
        networkQuality: "good", // Default — not provided in heartbeat payload
        activeApp: health.activeApp ?? "",
        thermalStatus,
        storageFreeBytes: health.storageFreeBytes ?? 0,
        agentVersion: "", // Not provided in heartbeat — comes from DEVICE_HELLO
      });

      console.log(
        `[handlers] HEARTBEAT: device=${deviceId.slice(0, 8)} battery=${health.batteryLevel}%${
          health.charging ? " (charging)" : ""
        }`
      );
    },

    // ───────────────────────────────────────────────────────────────────────
    // DEVICE_HELLO: Device coming online / registration
    // ───────────────────────────────────────────────────────────────────────
    onDeviceHello: async (
      pubkey: string,
      payload: object,
      _event: NostrEvent
    ): Promise<void> => {
      const helloPayload = payload as DeviceHelloPayload;

      console.log(
        `[handlers] DEVICE_HELLO: pubkey=${pubkey.slice(0, 8)} model=${helloPayload.model}`
      );

      // Check if pubkey is already registered
      let deviceId = registry.lookupDeviceId(pubkey);
      const adapter = getNostrAdapterImpl();

      if (deviceId) {
        // ── Known device — send ACK ─────────────────────────────────────────
        console.log(
          `[handlers] Known device ${deviceId.slice(0, 8)} — sending ACK`
        );

        // Update device info in DB
        const db = getDb();
        await db.query(
          `UPDATE devices 
           SET model = COALESCE($2, model),
               android_version = COALESCE($3, android_version),
               agent_version = COALESCE($4, agent_version),
               last_seen_at = NOW(),
               status = CASE WHEN status = 'offline' THEN 'online' ELSE status END
           WHERE id = $1`,
          [
            deviceId,
            helloPayload.model,
            helloPayload.androidVersion,
            helloPayload.agentVersion,
          ]
        );

        // Send ACK via adapter
        if (adapter) {
          await adapter.sendDeviceAck(deviceId, "approved");
        }
      } else {
        // ── Unknown pubkey — check if deviceId from payload matches an enrolled device ──
        const db = getDb();
        const enrolledDeviceId = (helloPayload as any).deviceId as string | undefined;

        if (enrolledDeviceId) {
          // Try to bind pubkey to existing enrolled device
          const existing = await db.query(
            "SELECT id, status FROM devices WHERE id = $1",
            [enrolledDeviceId]
          );
          if (existing.rows.length > 0) {
            await db.query(
              `UPDATE devices SET nostr_pubkey = $1, model = COALESCE($2, model),
               android_version = COALESCE($3, android_version),
               agent_version = COALESCE($4, agent_version), last_seen_at = NOW()
               WHERE id = $5`,
              [pubkey, helloPayload.model, helloPayload.androidVersion, helloPayload.agentVersion, enrolledDeviceId]
            );
            await registry.register(pubkey, enrolledDeviceId);
            deviceId = enrolledDeviceId;
            console.log(`[handlers] Bound pubkey ${pubkey.slice(0, 8)} to enrolled device ${enrolledDeviceId.slice(0, 8)}`);
          } else {
            const newId = enrolledDeviceId;
            await db.query(
              `INSERT INTO devices (id, nostr_pubkey, model, android_version, agent_version, status, created_at)
               VALUES ($1, $2, $3, $4, $5, 'pending', NOW()) ON CONFLICT DO NOTHING`,
              [newId, pubkey, helloPayload.model, helloPayload.androidVersion, helloPayload.agentVersion]
            );
            await registry.register(pubkey, newId);
            deviceId = newId;
            console.log(`[handlers] New device ${newId.slice(0, 8)} — pending approval`);
          }
        } else {
          const newId = crypto.randomUUID();
          await db.query(
            `INSERT INTO devices (id, nostr_pubkey, model, android_version, agent_version, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
             ON CONFLICT (nostr_pubkey) DO UPDATE SET
               model = EXCLUDED.model,
               android_version = EXCLUDED.android_version,
               agent_version = EXCLUDED.agent_version`,
            [newId, pubkey, helloPayload.model, helloPayload.androidVersion, helloPayload.agentVersion]
          );
          await registry.register(pubkey, newId);
          deviceId = newId;
          console.log(`[handlers] New device ${newId.slice(0, 8)} — pending approval`);
        }

        // Send pending ACK so device knows we received HELLO
        if (adapter) {
          await adapter.sendDeviceAck(deviceId, "pending");
        }
      }
    },

    // ───────────────────────────────────────────────────────────────────────
    // VISION_REQUEST: Device requests vision analysis
    // ───────────────────────────────────────────────────────────────────────
    onVisionRequest: async (
      pubkey: string,
      payload: object,
      _event: NostrEvent
    ): Promise<void> => {
      const deviceId = registry.lookupDeviceId(pubkey);
      if (!deviceId) {
        console.warn(
          `[handlers] VISION_REQUEST from unknown pubkey ${pubkey.slice(0, 8)}`
        );
        return;
      }

      const visionPayload = payload as VisionRequestPayload;

      console.log(
        `[handlers] VISION_REQUEST: device=${deviceId.slice(0, 8)} query="${visionPayload.query?.slice(0, 50) ?? "(no query)"}"`
      );

      // TODO Sprint 3: Wire to visionService.analyze()
      // Example:
      // const result = await visionService.analyze(deviceId, visionPayload.screenshot, visionPayload.query);
      // await adapter.getClient().publishVisionResult(pubkey, visionPayload.jobId, result);

      // For now, log the request
      if (visionPayload.screenshot) {
        const sizeKb = Math.round(
          (visionPayload.screenshot.length * 3) / 4 / 1024
        );
        console.log(`[handlers] Screenshot size: ~${sizeKb}KB`);
      }
    },
  };
}
