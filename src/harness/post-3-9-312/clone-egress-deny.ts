import fs from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { HARNESS_BLOCKED, HARNESS_PASS, HARNESS_STATUS_FIELD, redactJson, redactString } from "./redaction";

export const CLONE_EGRESS_CHANNELS = [
  "dns",
  "http",
  "ws",
  "vlm",
  "device",
  "phone_dispatch",
] as const;

export type CloneEgressChannel = typeof CLONE_EGRESS_CHANNELS[number];

export interface CloneEgressCapture {
  mode: "deny";
  enforcement: "external-ld-preload-syscall-boundary";
  candidateSha: string;
  sourceIdentity: string;
  capturedAt: string;
  channels: Record<CloneEgressChannel, Array<CloneEgressEvent>>;
}

export interface CloneEgressEvent {
  channel: CloneEgressChannel;
  action: string;
  target: string;
  denied: boolean;
  capturedAt: string;
}

export interface CloneHttpGateEnv {
  candidateSha?: string;
  fixtureDatabaseUrl?: string;
  sourceIdentity?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  launchConfig?: string;
  launchCommand?: string;
  egressDeny?: string;
  egressCapturePath?: string;
  boundaryLogPath?: string;
  boundaryLibraryPath?: string;
  cleanCheckoutCommand?: string;
  ingressPath?: string;
  restartPath?: string;
  conflictPath?: string;
  replayCount?: string;
  concurrency?: string;
}

export interface CloneHttpGateEvidence {
  status: string;
  candidateSha?: string;
  sourceIdentity?: string;
  cleanCheckoutCommand?: string;
  ingress: {
    method: "GET";
    path?: string;
    replayCount: number;
    concurrency: number;
    httpStatuses: number[];
  };
  egressCapture?: CloneEgressCapture;
  blockedReasons?: string[];
  sideEffects: {
    productionAccess: boolean;
    phoneDispatch: boolean;
    deviceDispatch: boolean;
    vlmCalls: boolean;
    websocket: boolean;
    dns: boolean;
  };
  assertions?: Record<string, boolean>;
  candidateLaunch?: {
    command?: string;
    exactSha: boolean;
    restarts: number;
  };
}

export function readCloneHttpGateEnv(env: NodeJS.ProcessEnv = process.env): CloneHttpGateEnv {
  return {
    candidateSha: env.PN_POST_312_CLONE_CANDIDATE_SHA,
    fixtureDatabaseUrl: env.PN_POST_312_CLONE_DATABASE_URL,
    sourceIdentity: env.PN_POST_312_CLONE_SOURCE_IDENTITY,
    apiBaseUrl: env.PN_POST_312_CLONE_API_BASE_URL,
    apiKey: env.PN_POST_312_CLONE_API_KEY,
    launchConfig: env.PN_POST_312_CLONE_LAUNCH_CONFIG,
    launchCommand: env.PN_POST_312_CLONE_LAUNCH_COMMAND,
    egressDeny: env.PN_POST_312_CLONE_EGRESS_DENY,
    egressCapturePath: env.PN_POST_312_CLONE_EGRESS_CAPTURE_PATH,
    boundaryLogPath: env.PN_POST_312_CLONE_BOUNDARY_LOG_PATH,
    boundaryLibraryPath: env.PN_POST_312_CLONE_BOUNDARY_LIBRARY_PATH,
    cleanCheckoutCommand: env.PN_POST_312_CLONE_CLEAN_CHECKOUT_COMMAND,
    ingressPath: env.PN_POST_312_CLONE_INGRESS_PATH,
    restartPath: env.PN_POST_312_CLONE_RESTART_PATH,
    conflictPath: env.PN_POST_312_CLONE_CONFLICT_PATH,
    replayCount: env.PN_POST_312_CLONE_REPLAY_COUNT,
    concurrency: env.PN_POST_312_CLONE_CONCURRENCY,
  };
}

export function validateCloneHttpGateEnv(env: CloneHttpGateEnv): string[] {
  const missing: string[] = [];
  if (!env.candidateSha) missing.push("PN_POST_312_CLONE_CANDIDATE_SHA");
  if (!env.fixtureDatabaseUrl) missing.push("PN_POST_312_CLONE_DATABASE_URL");
  if (!env.sourceIdentity) missing.push("PN_POST_312_CLONE_SOURCE_IDENTITY");
  if (!env.apiBaseUrl && !env.launchCommand) {
    missing.push("PN_POST_312_CLONE_API_BASE_URL or PN_POST_312_CLONE_LAUNCH_COMMAND");
  }
  if (env.apiBaseUrl && !env.apiKey) missing.push("PN_POST_312_CLONE_API_KEY");
  if (env.egressDeny !== "1" && env.egressDeny !== "true") missing.push("PN_POST_312_CLONE_EGRESS_DENY=true");
  if (!env.egressCapturePath) missing.push("PN_POST_312_CLONE_EGRESS_CAPTURE_PATH");
  if (env.launchCommand && !env.boundaryLogPath) missing.push("PN_POST_312_CLONE_BOUNDARY_LOG_PATH");
  if (env.launchCommand && !env.boundaryLibraryPath) missing.push("PN_POST_312_CLONE_BOUNDARY_LIBRARY_PATH");
  if (!env.cleanCheckoutCommand) missing.push("PN_POST_312_CLONE_CLEAN_CHECKOUT_COMMAND");
  if (!env.ingressPath) missing.push("PN_POST_312_CLONE_INGRESS_PATH");
  if (env.ingressPath && !isAllowedIngressPath(env.ingressPath)) {
    missing.push("PN_POST_312_CLONE_INGRESS_PATH must be read-only and must not target phone/device/restart/release routes");
  }
  if (env.restartPath && !isAllowedIngressPath(env.restartPath)) {
    missing.push("PN_POST_312_CLONE_RESTART_PATH must be read-only and local-harness only");
  }
  if (env.conflictPath && !isAllowedIngressPath(env.conflictPath)) {
    missing.push("PN_POST_312_CLONE_CONFLICT_PATH must be read-only and local-harness only");
  }
  if (env.replayCount && !positiveInteger(env.replayCount)) missing.push("PN_POST_312_CLONE_REPLAY_COUNT must be a positive integer");
  if (env.concurrency && !positiveInteger(env.concurrency)) missing.push("PN_POST_312_CLONE_CONCURRENCY must be a positive integer");
  if (env.fixtureDatabaseUrl && !isFixtureDsn(env.fixtureDatabaseUrl)) {
    missing.push("PN_POST_312_CLONE_DATABASE_URL must target a disposable fixture/clone/test database");
  }
  return missing;
}

export async function runCloneHttpE2eHarness(env: CloneHttpGateEnv = readCloneHttpGateEnv()): Promise<CloneHttpGateEvidence> {
  const missing = validateCloneHttpGateEnv(env);
  if (missing.length > 0) return blockedCloneEvidence(env, missing);

  const replayCount = Number(env.replayCount ?? 2);
  const concurrency = Number(env.concurrency ?? 2);
  const launched = await launchCandidateIfRequested(env);
  let apiBaseUrl = launched.apiBaseUrl ?? env.apiBaseUrl!;
  let restarts = 0;
  const statuses: number[] = [];
  const responseBodies: unknown[] = [];

  try {
    const firstHealth = await fetchJson(apiBaseUrl, env.ingressPath!, env, "0");
    statuses.push(firstHealth.status);
    responseBodies.push(firstHealth.body);

    if (env.restartPath) {
      const restart = await fetchJson(apiBaseUrl, env.restartPath, env, "restart");
      statuses.push(restart.status);
      responseBodies.push(restart.body);
      restarts += restart.status >= 200 && restart.status < 300 ? 1 : 0;
      await launched.stop?.();
      const relaunched = await launchCandidateIfRequested(env);
      if (relaunched.apiBaseUrl) {
        launched.apiBaseUrl = relaunched.apiBaseUrl;
        apiBaseUrl = relaunched.apiBaseUrl;
      }
      if (relaunched.stop) launched.stop = relaunched.stop;
    }

    const jobs = Array.from({ length: replayCount }, async (_, replayIndex) => {
      const batch = Array.from({ length: concurrency }, async () => {
        const response = await fetchJson(apiBaseUrl, env.ingressPath!, env, String(replayIndex));
        statuses.push(response.status);
        responseBodies.push(response.body);
      });
      await Promise.all(batch);
    });
    await Promise.all(jobs);

    if (env.conflictPath) {
      const [first, replay, conflict] = await Promise.all([
        fetchJson(apiBaseUrl, `${env.conflictPath}?key=stable&value=alpha`, env, "conflict-a"),
        fetchJson(apiBaseUrl, `${env.conflictPath}?key=stable&value=alpha`, env, "conflict-replay"),
        fetchJson(apiBaseUrl, `${env.conflictPath}?key=stable&value=beta`, env, "conflict-b"),
      ]);
      statuses.push(first.status, replay.status, conflict.status);
      responseBodies.push(first.body, replay.body, conflict.body);
    }

    const egressProbe = await fetchJson(apiBaseUrl, "/__post312/egress-probe", env, "egress-probe");
    statuses.push(egressProbe.status);
    responseBodies.push(egressProbe.body);
    const capture = env.launchCommand
      ? await readBoundaryCapture(env)
      : normalizeCapture(egressProbe.body, env);
    const sideEffects = summarizeSideEffects(capture);
    const assertions = {
      exactCandidateSha: responseBodies.some((body) => bodyHasCandidateSha(body, env.candidateSha!)),
      httpIngress2xx: statuses.every((statusCode) => statusCode >= 200 && statusCode < 300 || statusCode === 409),
      replayCovered: replayCount > 1,
      concurrencyCovered: concurrency > 1,
      restartCovered: !env.restartPath || restarts > 0,
      conflictCovered: !env.conflictPath || statuses.includes(409),
      egressCaptureAvailable: CLONE_EGRESS_CHANNELS.every((channel) => Array.isArray(capture.channels[channel])),
      forbiddenEgressDenied: CLONE_EGRESS_CHANNELS.every((channel) => (capture.channels[channel] ?? []).some((event) => event.denied)),
      zeroForbiddenSideEffects: Object.values(sideEffects).every((value) => value === false),
    };

    const pass = Object.values(assertions).every(Boolean);
    const evidence: CloneHttpGateEvidence = {
      [HARNESS_STATUS_FIELD]: pass ? HARNESS_PASS : HARNESS_BLOCKED,
      candidateSha: env.candidateSha,
      sourceIdentity: env.sourceIdentity,
      cleanCheckoutCommand: redactString(env.cleanCheckoutCommand!),
      ingress: {
        method: "GET",
        path: env.ingressPath,
        replayCount,
        concurrency,
        httpStatuses: statuses,
      },
      egressCapture: capture,
      blockedReasons: pass ? undefined : failedAssertionReasons(assertions, statuses),
      sideEffects,
      assertions,
      candidateLaunch: {
        command: env.launchCommand ? redactString(env.launchCommand) : undefined,
        exactSha: assertions.exactCandidateSha,
        restarts,
      },
    };
    await fs.writeFile(env.egressCapturePath!, `${redactJson(evidence)}\n`);
    return evidence;
  } finally {
    await launched.stop?.();
  }
}

export async function writeDeniedCloneEgressCapture(
  env: CloneHttpGateEnv,
  now = new Date(),
  events: CloneEgressEvent[] = [],
): Promise<CloneEgressCapture> {
  const missing = validateCloneHttpGateEnv(env);
  if (missing.length > 0) {
    throw new Error(`BLOCKED: clone HTTP gate missing fail-closed config: ${missing.join(", ")}`);
  }
  const capture: CloneEgressCapture = {
    mode: "deny",
    enforcement: "external-ld-preload-syscall-boundary",
    candidateSha: env.candidateSha!,
    sourceIdentity: env.sourceIdentity!,
    capturedAt: now.toISOString(),
    channels: {
      dns: [],
      http: [],
      ws: [],
      vlm: [],
      device: [],
      phone_dispatch: [],
    },
  };
  for (const event of events) capture.channels[event.channel].push(event);
  await fs.writeFile(env.egressCapturePath!, `${redactJson(capture)}\n`);
  return capture;
}

export const writeEmptyCloneEgressCapture = writeDeniedCloneEgressCapture;

function blockedCloneEvidence(env: CloneHttpGateEnv, reasons: string[]): CloneHttpGateEvidence {
  return {
    [HARNESS_STATUS_FIELD]: HARNESS_BLOCKED,
    candidateSha: env.candidateSha,
    sourceIdentity: env.sourceIdentity,
    cleanCheckoutCommand: env.cleanCheckoutCommand ? redactString(env.cleanCheckoutCommand) : undefined,
    ingress: {
      method: "GET",
      path: env.ingressPath,
      replayCount: Number(env.replayCount ?? 0),
      concurrency: Number(env.concurrency ?? 0),
      httpStatuses: [],
    },
    blockedReasons: reasons.map((reason) => redactString(reason)),
    sideEffects: zeroSideEffects(),
  };
}

function isFixtureDsn(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return /^(127\.0\.0\.1|localhost)$/i.test(parsed.hostname)
      && /(fixture|clone|test|pg17|pnq)/i.test(`${parsed.pathname} ${parsed.search}`);
  } catch {
    return false;
  }
}

function zeroSideEffects(): CloneHttpGateEvidence["sideEffects"] {
  return {
    productionAccess: false,
    phoneDispatch: false,
    deviceDispatch: false,
    vlmCalls: false,
    websocket: false,
    dns: false,
  };
}

function isAllowedIngressPath(path: string): boolean {
  return path.startsWith("/")
    && !/[;|`$<>\\]/.test(path)
    && !/(phone|device|adb|release|publish|dispatch|ws|websocket|vlm)/i.test(path);
}

function positiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 20;
}

async function fetchJson(
  apiBaseUrl: string,
  path: string,
  env: CloneHttpGateEnv,
  replayIndex: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, apiBaseUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${env.apiKey}`,
      "x-source-identity": env.sourceIdentity!,
      "x-candidate-sha": env.candidateSha!,
      "x-replay-index": replayIndex,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { nonJson: redactString(text.slice(0, 500)) };
  }
  return { status: response.status, body };
}

async function launchCandidateIfRequested(env: CloneHttpGateEnv): Promise<{
  apiBaseUrl?: string;
  stop?: () => Promise<void>;
}> {
  if (!env.launchCommand) return { apiBaseUrl: env.apiBaseUrl };
  const port = await findFreePort();
  const child = spawn(env.launchCommand, {
    shell: true,
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PN_POST_312_CLONE_CANDIDATE_SHA: env.candidateSha!,
      PN_POST_312_CLONE_SOURCE_IDENTITY: env.sourceIdentity!,
      PN_POST_312_CLONE_DATABASE_URL: env.fixtureDatabaseUrl!,
      PN_POST_312_CLONE_EGRESS_DENY: env.egressDeny!,
      PN_POST_312_BOUNDARY_LOG: env.boundaryLogPath!,
      LD_PRELOAD: env.boundaryLibraryPath!,
    },
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(redactString(String(chunk))));
  await waitForReady(child, `http://127.0.0.1:${port}/__post312/identity`, env);
  return {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    stop: async () => stopChild(child),
  };
}

async function waitForReady(child: ChildProcessWithoutNullStreams, url: string, env: CloneHttpGateEnv): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`BLOCKED: candidate exited before readiness with code ${child.exitCode}`);
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${env.apiKey}`,
          "x-source-identity": env.sourceIdentity!,
          "x-candidate-sha": env.candidateSha!,
        },
      });
      const body = await response.json() as Record<string, unknown>;
      if (response.ok && body.candidateSha === env.candidateSha) return;
      lastError = `identity status ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`BLOCKED: candidate did not become ready: ${redactString(lastError)}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate local port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function normalizeCapture(value: unknown, env: CloneHttpGateEnv): CloneEgressCapture {
  const payload = value as { egressCapture?: CloneEgressCapture };
  if (!payload?.egressCapture) throw new Error("BLOCKED: candidate did not return egress capture");
  const capture = payload.egressCapture;
  if (capture.candidateSha !== env.candidateSha || capture.sourceIdentity !== env.sourceIdentity) {
    throw new Error("BLOCKED: candidate egress capture identity mismatch");
  }
  return capture;
}

async function readBoundaryCapture(env: CloneHttpGateEnv): Promise<CloneEgressCapture> {
  const text = await fs.readFile(env.boundaryLogPath!, "utf8").catch(() => "");
  const channels = Object.fromEntries(
    CLONE_EGRESS_CHANNELS.map((channel) => [channel, [] as CloneEgressEvent[]]),
  ) as unknown as CloneEgressCapture["channels"];
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const [channel, action, target, epoch] = line.split("\t");
    if (!CLONE_EGRESS_CHANNELS.includes(channel as CloneEgressChannel)) continue;
    channels[channel as CloneEgressChannel].push({
      channel: channel as CloneEgressChannel,
      action,
      target,
      denied: true,
      capturedAt: new Date(Number(epoch) * 1000).toISOString(),
    });
  }
  return {
    mode: "deny",
    enforcement: "external-ld-preload-syscall-boundary",
    candidateSha: env.candidateSha!,
    sourceIdentity: env.sourceIdentity!,
    capturedAt: new Date().toISOString(),
    channels,
  };
}

function summarizeSideEffects(capture: CloneEgressCapture): CloneHttpGateEvidence["sideEffects"] {
  return {
    productionAccess: Object.values(capture.channels).flat().some((event) => event.denied !== true),
    phoneDispatch: capture.channels.phone_dispatch.some((event) => event.denied !== true),
    deviceDispatch: capture.channels.device.some((event) => event.denied !== true),
    vlmCalls: capture.channels.vlm.some((event) => event.denied !== true),
    websocket: capture.channels.ws.some((event) => event.denied !== true),
    dns: capture.channels.dns.some((event) => event.denied !== true),
  };
}

function bodyHasCandidateSha(body: unknown, sha: string): boolean {
  return !!body && typeof body === "object" && JSON.stringify(body).includes(sha);
}

function failedAssertionReasons(assertions: Record<string, boolean>, statuses: number[]): string[] {
  const failed = Object.entries(assertions).filter(([, value]) => !value).map(([key]) => key);
  if (statuses.some((status) => status < 200 || (status >= 300 && status !== 409))) {
    failed.push(`HTTP ingress statuses: ${statuses.join(",")}`);
  }
  return failed;
}
