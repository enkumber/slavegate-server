import http from "http";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { DirectWsServer } from "./direct-ws.server";
import { DashboardWorkflowWsServer } from "../modules/workflow-events/workflow-event.service";

describe("websocket upgrade routing", () => {
  it("routes /ws-direct without a second websocket server writing HTTP to the upgraded socket", async () => {
    const direct = new DirectWsServer();
    const dashboard = new DashboardWorkflowWsServer();
    const server = http.createServer();

    direct.attach();
    dashboard.attach();
    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url ?? "", "http://localhost").pathname;
      if (pathname === "/ws-direct") {
        direct.handleUpgrade(req, socket, head);
        return;
      }
      if (pathname === "/ws-dashboard") {
        dashboard.handleUpgrade(req, socket, head);
        return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws-direct`, {
        perMessageDeflate: false,
      });
      const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket close")), 5_000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "PING" }));
      });
      ws.on("error", reject);
      ws.on("close", (code) => {
        clearTimeout(timer);
        expect(code).toBe(4001);
        resolve();
      });
    });

    await direct.close();
    await dashboard.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
});
