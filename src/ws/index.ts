/**
 * ws/index.ts
 * WebSocket module exports
 */

import { WebSocketGateway, wsGateway } from "./gateway";
import type { Server } from "http";
import type { Express } from "express";

/**
 * Create and attach WebSocket Gateway to HTTP server.
 * This is the main WebSocket transport endpoint for Phone Network.
 */
export function createWsGateway(server: Server, app?: Express): WebSocketGateway {
  wsGateway.attach(server);
  return wsGateway;
}

export { wsGateway, WebSocketGateway };
export { wsServer } from "./ws.server";
export { directWsServer } from "./direct-ws.server";