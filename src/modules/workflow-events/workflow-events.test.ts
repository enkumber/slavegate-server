import crypto from "crypto";
import type { IncomingMessage } from "http";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_WORKFLOW_EVENT_BYTES,
  WorkflowEventBus,
  normalizeWorkflowEventPayload,
  serializeWorkflowEventForSend,
  tokenFromRequest,
  verifyDashboardJwt,
} from ".";
import type { WorkflowEvent } from "./workflow-event.types";

function signJwt(payload: Record<string, unknown>, secret = "test-secret"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

describe("workflow events", () => {
  it("publishes normalized events to subscribers", () => {
    const bus = new WorkflowEventBus();
    const subscriber = vi.fn();
    bus.subscribe(subscriber);

    const event = bus.publish({
      source: "workflow_compiler",
      event: "step_started",
      workflowId: "workflow-1",
      stepIndex: 2,
      totalSteps: 5,
      details: {
        prompt: "do not forward this",
        nested: { token: "secret", value: "ok" },
        long: "x".repeat(700),
      },
    });

    expect(event.type).toBe("workflow_event");
    expect(event.eventType).toBe("step_started");
    expect(event.event).toBe("step_started");
    expect(event.timestamp).toBe(event.occurredAt);
    expect(subscriber).toHaveBeenCalledWith(event);
    expect(event.details).toMatchObject({
      prompt: "[omitted]",
      nested: { token: "[redacted]", value: "ok" },
      long: `${"x".repeat(500)}...`,
    });
  });

  it("unsubscribes subscribers", () => {
    const bus = new WorkflowEventBus();
    const subscriber = vi.fn();
    const unsubscribe = bus.subscribe(subscriber);

    unsubscribe();
    bus.publish({ source: "edge_device", event: "checkpoint_updated", workflowId: "workflow-1" });

    expect(subscriber).not.toHaveBeenCalled();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("caps arrays and object traversal", () => {
    const normalized = normalizeWorkflowEventPayload({
      values: Array.from({ length: 50 }, (_, index) => index),
      deep: { a: { b: { c: { d: "nope" } } } },
      screenshotBase64: "raw-image",
    }) as Record<string, unknown>;

    expect(normalized.values).toHaveLength(20);
    expect(normalized.deep).toEqual({ a: { b: "[truncated]" } });
    expect(normalized.screenshotBase64).toBe("[omitted]");
  });

  it("accepts only dashboard access JWTs", () => {
    process.env.JWT_SECRET = "test-secret";
    const exp = Math.floor(Date.now() / 1000) + 60;

    const access = signJwt({ sub: "admin", role: "admin", aud: "dashboard_access", exp });
    const refresh = signJwt({ sub: "admin", role: "admin", aud: "dashboard_refresh", refresh: true, exp });
    const expired = signJwt({ sub: "admin", role: "admin", aud: "dashboard_access", exp: Math.floor(Date.now() / 1000) - 1 });
    const wrongRole = signJwt({ sub: "admin", role: "viewer", aud: "dashboard_access", exp });
    const wrongAudience = signJwt({ sub: "admin", role: "admin", exp });

    expect(verifyDashboardJwt(access)).toBe(true);
    expect(verifyDashboardJwt(refresh)).toBe(false);
    expect(verifyDashboardJwt(expired)).toBe(false);
    expect(verifyDashboardJwt(wrongRole)).toBe(false);
    expect(verifyDashboardJwt(wrongAudience)).toBe(false);
    expect(verifyDashboardJwt(`${access.slice(0, -1)}x`)).toBe(false);
  });

  it("extracts bearer subprotocol before query fallback", () => {
    const req = {
      headers: {
        host: "localhost",
        "sec-websocket-protocol": "chat, bearer.protocol-token",
      },
      url: "/ws-dashboard?token=query-token",
    } as unknown as IncomingMessage;

    expect(tokenFromRequest(req)).toBe("protocol-token");
  });

  it("caps serialized websocket payload size", () => {
    const event: WorkflowEvent = {
      type: "workflow_event",
      eventId: "event-1",
      eventType: "checkpoint_updated",
      event: "checkpoint_updated",
      timestamp: new Date().toISOString(),
      occurredAt: new Date().toISOString(),
      source: "edge_device",
      workflowId: "workflow-1",
      details: { large: "x".repeat(MAX_WORKFLOW_EVENT_BYTES * 2) },
    };

    const serialized = serializeWorkflowEventForSend(event);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_WORKFLOW_EVENT_BYTES);
    expect(JSON.parse(serialized).details).toMatchObject({
      truncated: true,
      reason: "workflow_event_payload_too_large",
    });
  });
});
