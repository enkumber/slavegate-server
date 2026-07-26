import crypto, { randomUUID } from "crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import type { WorkflowEvent, WorkflowEventInput, WorkflowEventSubscriber } from "./workflow-event.types";

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_DEPTH = 3;
export const MAX_WORKFLOW_EVENT_BYTES = 32 * 1024;

const SENSITIVE_KEY_RE = /(secret|password|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|cachekey|requestkey)/i;
const LARGE_OR_UNSAFE_KEY_RE = /(screenshot|image|base64|prompt|uitree|html|dom|accessibility|raw)/i;

function normalizeScalar(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) return `${value.slice(0, MAX_STRING_LENGTH)}...`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" ? normalizeScalar(value) as string : undefined;
}

export function normalizeWorkflowEventPayload(value: unknown, depth = 0): unknown {
  const scalar = normalizeScalar(value);
  if (scalar !== undefined) return scalar;

  if (depth >= MAX_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => normalizeWorkflowEventPayload(entry, depth + 1));
  }

  if (!value || typeof value !== "object") return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    if (LARGE_OR_UNSAFE_KEY_RE.test(key)) {
      output[key] = "[omitted]";
      continue;
    }

    const normalized = normalizeWorkflowEventPayload(entry, depth + 1);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

export class WorkflowEventBus {
  private subscribers = new Set<WorkflowEventSubscriber>();

  publish(input: WorkflowEventInput): WorkflowEvent {
    const eventType = input.eventType ?? input.event;
    if (!eventType) throw new Error("workflow eventType is required");

    const timestamp = input.timestamp ?? input.occurredAt ?? new Date().toISOString();
    const event: WorkflowEvent = {
      type: "workflow_event",
      eventId: input.eventId ?? randomUUID(),
      eventType,
      event: eventType,
      timestamp,
      occurredAt: timestamp,
      source: input.source,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.agencyWorkflowRunId ? { agencyWorkflowRunId: input.agencyWorkflowRunId } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
      ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.totalSteps !== undefined ? { totalSteps: input.totalSteps } : {}),
      ...(input.message ? { message: normalizeOptionalString(input.message) } : {}),
      ...(input.errorCode ? { errorCode: normalizeOptionalString(input.errorCode) } : {}),
      ...(input.error ? { error: normalizeOptionalString(input.error) } : {}),
      ...(input.counters ? { counters: normalizeWorkflowEventPayload(input.counters) as Record<string, unknown> } : {}),
      ...(input.details ? { details: normalizeWorkflowEventPayload(input.details) as Record<string, unknown> } : {}),
    };

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.warn("[workflow-events] subscriber failed:", (err as Error).message);
      }
    }
    return event;
  }

  subscribe(subscriber: WorkflowEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  clear(): void {
    this.subscribers.clear();
  }
}

export function verifyDashboardJwt(token: string): boolean {
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;

  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return false;

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${header}.${body}`)
      .digest("base64url");

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      aud?: unknown;
      exp?: unknown;
      refresh?: unknown;
      role?: unknown;
      sub?: unknown;
    };
    return payload.aud === "dashboard_access"
      && typeof payload.exp === "number"
      && payload.exp >= Math.floor(Date.now() / 1000)
      && payload.refresh !== true
      && payload.role === "admin"
      && typeof payload.sub === "string"
      && payload.sub.length > 0;
  } catch {
    return false;
  }
}

export function tokenFromRequest(req: IncomingMessage): string | null {
  const protocol = req.headers["sec-websocket-protocol"];
  if (typeof protocol === "string") {
    const tokenProtocol = protocol
      .split(",")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("bearer."));
    if (tokenProtocol) return tokenProtocol.slice("bearer.".length);
  }

  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "", `http://${host}`);
  return url.searchParams.get("token");
}

export function serializeWorkflowEventForSend(event: WorkflowEvent): string {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_WORKFLOW_EVENT_BYTES) return serialized;

  const truncated: WorkflowEvent = {
    ...event,
    message: normalizeOptionalString(event.message),
    error: normalizeOptionalString(event.error),
    counters: undefined,
    details: {
      truncated: true,
      reason: "workflow_event_payload_too_large",
      originalBytes: Buffer.byteLength(serialized, "utf8"),
    },
  };
  const truncatedSerialized = JSON.stringify(truncated);
  if (Buffer.byteLength(truncatedSerialized, "utf8") <= MAX_WORKFLOW_EVENT_BYTES) return truncatedSerialized;

  return JSON.stringify({
    type: "workflow_event",
    eventId: event.eventId,
    eventType: event.eventType,
    event: event.event,
    timestamp: event.timestamp,
    occurredAt: event.occurredAt,
    source: event.source,
    workflowId: event.workflowId,
    workflowRunId: event.workflowRunId,
    taskId: event.taskId,
    agencyWorkflowRunId: event.agencyWorkflowRunId,
    clientId: event.clientId,
    accountId: event.accountId,
    deviceId: event.deviceId,
    mode: event.mode,
    status: event.status,
    currentStep: event.currentStep,
    totalSteps: event.totalSteps,
    stepId: event.stepId,
    stepIndex: event.stepIndex,
    details: { truncated: true, reason: "workflow_event_payload_too_large" },
  } satisfies WorkflowEvent);
}

export class DashboardWorkflowWsServer {
  private wss: WebSocketServer | null = null;

  attach(): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => protocols.has("workflow-events") ? "workflow-events" : false,
    });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.wss.on("error", (err) => console.error("[dashboard-ws] WSS error:", err.message));
    console.log("[dashboard-ws] Ready for HTTP upgrade routing on /ws-dashboard");
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit("connection", ws, req);
    });
  }

  async close(): Promise<void> {
    if (!this.wss) return;
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    this.wss = null;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const token = tokenFromRequest(req);
    if (!token || !verifyDashboardJwt(token)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const unsubscribe = workflowEvents.subscribe((event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(serializeWorkflowEventForSend(event));
    });

    ws.send(JSON.stringify({
      type: "workflow_event_connection",
      ready: true,
      timestamp: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
    }));

    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  }
}

export const workflowEvents = new WorkflowEventBus();
export const dashboardWorkflowWsServer = new DashboardWorkflowWsServer();
