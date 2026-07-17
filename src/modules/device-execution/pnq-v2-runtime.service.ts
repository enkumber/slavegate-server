import { v4 as uuidv4 } from "uuid";
import { getPnqV2RuntimeConfig, isPnqV2ShadowRuntimeEnabled } from "./pnq-v2-runtime-config";
import { PnqV2RuntimeRepository } from "./pnq-v2-runtime.repository";

export interface ShadowObservation {
  ok: boolean;
  observed_error?: string;
  metadata?: Record<string, unknown>;
}

export class PnqV2RuntimeService {
  private readonly repo = new PnqV2RuntimeRepository();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  async enqueueShadowJob(args: {
    legacyJobId: string;
    deviceId: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<ShadowObservation> {
    if (!isPnqV2ShadowRuntimeEnabled()) return { ok: true, metadata: { mode: "disabled" } };
    return this.observe("enqueue", async () => {
      const mapping = await this.repo.enqueueMappedJob({
        legacyJobId: args.legacyJobId,
        nodeId: args.deviceId,
        payload: this.redactPayload(args.payload),
        timeoutMs: args.timeoutMs,
      });
      return { mapping };
    });
  }

  async onConnectionAuthenticated(deviceId: string): Promise<number | null> {
    if (!isPnqV2ShadowRuntimeEnabled()) return null;
    try {
      const node = await this.repo.registerNode(deviceId);
      return await this.repo.bumpEpoch(deviceId, node.connectionEpoch);
    } catch (err) {
      console.error("[pnq-v2-shadow] connection epoch observation failed:", (err as Error).message);
      return null;
    }
  }

  async prepareShadowDispatch(legacyJobId: string, socketEpoch: number | null | undefined): Promise<ShadowObservation> {
    if (!isPnqV2ShadowRuntimeEnabled()) return { ok: true, metadata: { mode: "disabled" } };
    if (socketEpoch == null) return { ok: false, observed_error: "missing_socket_epoch" };
    return this.observe("dispatch", async () => {
      const mapping = await this.repo.claimAndStart(legacyJobId, socketEpoch, uuidv4());
      return { mapping };
    });
  }

  async recordShadowResult(args: {
    legacyJobId: string;
    socketEpoch: number | null | undefined;
    success: boolean;
    result: Record<string, unknown>;
  }): Promise<ShadowObservation> {
    if (!isPnqV2ShadowRuntimeEnabled()) return { ok: true, metadata: { mode: "disabled" } };
    if (args.socketEpoch == null) return { ok: false, observed_error: "missing_socket_epoch" };
    const socketEpoch = args.socketEpoch;
    return this.observe("result", async () => ({
      job: await this.repo.recordResult(args.legacyJobId, socketEpoch, args.success, this.redactPayload(args.result)),
    }));
  }

  async reconcileStartup(): Promise<ShadowObservation> {
    if (!isPnqV2ShadowRuntimeEnabled()) return { ok: true, metadata: { mode: "disabled" } };
    return this.observe("reconcile_startup", async () => ({
      stuck: await this.repo.markExpiredActiveStuck("startup_recovery_required"),
    }));
  }

  async sweepDeadlines(): Promise<ShadowObservation> {
    if (!isPnqV2ShadowRuntimeEnabled()) return { ok: true, metadata: { mode: "disabled" } };
    return this.observe("sweep_deadlines", async () => ({
      stuck: await this.repo.markExpiredActiveStuck("deadline_or_crash_window_recovery_required"),
    }));
  }

  startPeriodicSweep(): void {
    if (!isPnqV2ShadowRuntimeEnabled() || this.sweepTimer) return;
    const { sweepIntervalMs } = getPnqV2RuntimeConfig();
    this.sweepTimer = setInterval(() => {
      this.sweepDeadlines().catch((err) =>
        console.error("[pnq-v2-shadow] periodic sweep failed:", (err as Error).message),
      );
    }, sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private async observe(operation: string, fn: () => Promise<Record<string, unknown>>): Promise<ShadowObservation> {
    try {
      return { ok: true, metadata: { operation, ...(await fn()) } };
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[pnq-v2-shadow] ${operation} observation failed:`, message);
      return { ok: false, observed_error: message, metadata: { operation } };
    }
  }

  private redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(payload, (key, value) => (
      /token|secret|password|key/i.test(key) ? "[redacted]" : value
    ))) as Record<string, unknown>;
  }
}

export const pnqV2RuntimeService = new PnqV2RuntimeService();
