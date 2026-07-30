import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLONE_EGRESS_CHANNELS,
  runCloneHttpE2eHarness,
  validateCloneHttpGateEnv,
  writeEmptyCloneEgressCapture,
} from "../../src/harness/post-3-9-312/clone-egress-deny";
import { redact } from "../../src/harness/post-3-9-312/redaction";

describe("post-3.9.312 live-derived clone HTTP gate egress seam", () => {
  let server: http.Server;
  let serverUrl = "";
  let requests: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      if (req.method === "GET" && req.url === "/__post312/egress-probe") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          candidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e",
          egressCapture: {
            mode: "deny",
            enforcement: "process-preload",
            candidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e",
            sourceIdentity: "forge-local-pg17-fixture",
            capturedAt: "2026-07-30T08:00:00Z",
            channels: Object.fromEntries(CLONE_EGRESS_CHANNELS.map((channel) => [channel, [{
              channel,
              action: "fixture",
              target: "denied://fixture",
              denied: true,
              capturedAt: "2026-07-30T08:00:00Z",
            }]])),
          },
        }));
        return;
      }
      if (req.method !== "GET" || req.url !== "/api/audits/daily?fixture=clone") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, candidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e", data: { fixture: "clone" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  it("redacts credential keys without hiding unrelated audit booleans", () => {
    expect(redact({
      apiKey: "secret",
      databaseUrl: "postgresql://user:password@localhost/test",
      dailyAuditOkEnvelope: true,
    })).toEqual({
      apiKey: "[REDACTED]",
      databaseUrl: "[REDACTED]",
      dailyAuditOkEnvelope: true,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails closed without candidate, fixture DSN, source identity, API config, and deny capture", () => {
    expect(validateCloneHttpGateEnv({})).toEqual(expect.arrayContaining([
      "PN_POST_312_CLONE_CANDIDATE_SHA",
      "PN_POST_312_CLONE_DATABASE_URL",
      "PN_POST_312_CLONE_SOURCE_IDENTITY",
      "PN_POST_312_CLONE_API_BASE_URL or PN_POST_312_CLONE_LAUNCH_COMMAND",
      "PN_POST_312_CLONE_EGRESS_DENY=true",
      "PN_POST_312_CLONE_EGRESS_CAPTURE_PATH",
      "PN_POST_312_CLONE_CLEAN_CHECKOUT_COMMAND",
      "PN_POST_312_CLONE_INGRESS_PATH",
    ]));
  });

  it("writes mandatory zero-egress capture channels without leaking credentials", async () => {
    const capturePath = path.join(os.tmpdir(), `clone-egress-${process.pid}-${Date.now()}.json`);
    const capture = await writeEmptyCloneEgressCapture({
      candidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e",
      fixtureDatabaseUrl: "postgresql://pnqtest:super-secret@127.0.0.1:55432/pnq001_test",
      sourceIdentity: "forge-local-pg17-fixture",
      apiBaseUrl: "http://127.0.0.1:3000",
      apiKey: "fixture-api-key",
      egressDeny: "true",
      egressCapturePath: capturePath,
      cleanCheckoutCommand: "git clean -ffdx && git checkout .",
      ingressPath: "/api/audits/daily?fixture=clone",
    }, new Date("2026-07-30T08:00:00Z"));

    expect(Object.keys(capture.channels)).toEqual([...CLONE_EGRESS_CHANNELS]);
    expect(Object.values(capture.channels).every((events) => events.length === 0)).toBe(true);

    const persisted = await fs.readFile(capturePath, "utf8");
    expect(persisted).not.toContain("super-secret");
    expect(persisted).not.toContain("fixture-api-key");
    expect(JSON.parse(persisted)).toMatchObject({
      mode: "deny",
      sourceIdentity: "forge-local-pg17-fixture",
    });
  });

  it("runs replay/concurrency through real HTTP ingress and redacts hostile values", async () => {
    requests = [];
    const capturePath = path.join(os.tmpdir(), `clone-http-e2e-${process.pid}-${Date.now()}.json`);
    const evidence = await runCloneHttpE2eHarness({
      candidateSha: "c0c590b0473cd7da5be4c52e30cd0a799952a33e",
      fixtureDatabaseUrl: "postgresql://pnqtest:super-secret@127.0.0.1:55432/pnq001_test",
      sourceIdentity: "forge-local-pg17-fixture",
      apiBaseUrl: serverUrl,
      apiKey: "fixture-api-key",
      egressDeny: "true",
      egressCapturePath: capturePath,
      cleanCheckoutCommand: "git fetch origin && git checkout c0c590b0473cd7da5be4c52e30cd0a799952a33e && git clean -ffdx",
      ingressPath: "/api/audits/daily?fixture=clone",
      replayCount: "2",
      concurrency: "3",
    });

    expect(evidence.status).toBe("PASS");
    expect(requests.filter((entry) => entry.startsWith("GET /api/audits/daily"))).toHaveLength(7);
    expect(requests.some((entry) => entry.startsWith("GET /__post312/egress-probe"))).toBe(true);
    expect(evidence.sideEffects).toEqual({
      productionAccess: false,
      phoneDispatch: false,
      deviceDispatch: false,
      vlmCalls: false,
      websocket: false,
      dns: false,
    });
    expect(evidence.assertions).toMatchObject({
      exactCandidateSha: true,
      egressCaptureAvailable: true,
      forbiddenEgressDenied: true,
      zeroForbiddenSideEffects: true,
    });

    const persisted = await fs.readFile(capturePath, "utf8");
    expect(persisted).not.toContain("fixture-api-key");
    expect(persisted).not.toContain("super-secret");
    expect(JSON.parse(persisted)).toMatchObject({
      status: "PASS",
      ingress: { replayCount: 2, concurrency: 3 },
    });
  });

  it("blocks hostile ingress routes before command or phone-like side effects", () => {
    expect(validateCloneHttpGateEnv({
      candidateSha: "sha",
      fixtureDatabaseUrl: "postgresql://pnqtest:secret@127.0.0.1:55432/pnq001_test",
      sourceIdentity: "source\nAuthorization: Bearer leaked",
      apiBaseUrl: "http://127.0.0.1:1",
      apiKey: "secret",
      egressDeny: "true",
      egressCapturePath: "/tmp/capture.json",
      cleanCheckoutCommand: "git checkout sha; curl http://prod",
      ingressPath: "/api/devices/restart;curl http://prod",
    })).toContain("PN_POST_312_CLONE_INGRESS_PATH must be read-only and must not target phone/device/restart/release routes");
  });
});
