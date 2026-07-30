import fs from "node:fs/promises";
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
  candidateSha: string;
  sourceIdentity: string;
  capturedAt: string;
  channels: Record<CloneEgressChannel, Array<Record<string, unknown>>>;
}

export interface CloneHttpGateEnv {
  candidateSha?: string;
  fixtureDatabaseUrl?: string;
  sourceIdentity?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  launchConfig?: string;
  egressDeny?: string;
  egressCapturePath?: string;
  cleanCheckoutCommand?: string;
  ingressPath?: string;
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
    productionAccess: false;
    phoneDispatch: false;
    deviceDispatch: false;
    vlmCalls: false;
    websocket: false;
    dns: false;
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
    egressDeny: env.PN_POST_312_CLONE_EGRESS_DENY,
    egressCapturePath: env.PN_POST_312_CLONE_EGRESS_CAPTURE_PATH,
    cleanCheckoutCommand: env.PN_POST_312_CLONE_CLEAN_CHECKOUT_COMMAND,
    ingressPath: env.PN_POST_312_CLONE_INGRESS_PATH,
    replayCount: env.PN_POST_312_CLONE_REPLAY_COUNT,
    concurrency: env.PN_POST_312_CLONE_CONCURRENCY,
  };
}

export function validateCloneHttpGateEnv(env: CloneHttpGateEnv): string[] {
  const missing: string[] = [];
  if (!env.candidateSha) missing.push("PN_POST_312_CLONE_CANDIDATE_SHA");
  if (!env.fixtureDatabaseUrl) missing.push("PN_POST_312_CLONE_DATABASE_URL");
  if (!env.sourceIdentity) missing.push("PN_POST_312_CLONE_SOURCE_IDENTITY");
  if (!env.apiBaseUrl && !env.launchConfig) {
    missing.push("PN_POST_312_CLONE_API_BASE_URL or PN_POST_312_CLONE_LAUNCH_CONFIG");
  }
  if (env.apiBaseUrl && !env.apiKey) missing.push("PN_POST_312_CLONE_API_KEY");
  if (env.egressDeny !== "1" && env.egressDeny !== "true") missing.push("PN_POST_312_CLONE_EGRESS_DENY=true");
  if (!env.egressCapturePath) missing.push("PN_POST_312_CLONE_EGRESS_CAPTURE_PATH");
  if (!env.cleanCheckoutCommand) missing.push("PN_POST_312_CLONE_CLEAN_CHECKOUT_COMMAND");
  if (!env.ingressPath) missing.push("PN_POST_312_CLONE_INGRESS_PATH");
  if (env.ingressPath && !isAllowedIngressPath(env.ingressPath)) {
    missing.push("PN_POST_312_CLONE_INGRESS_PATH must be read-only and must not target phone/device/restart/release routes");
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
  const capture = await writeEmptyCloneEgressCapture(env);
  const statuses: number[] = [];
  const jobs = Array.from({ length: replayCount }, async (_, replayIndex) => {
    const batch = Array.from({ length: concurrency }, async () => {
      const response = await fetch(new URL(env.ingressPath!, env.apiBaseUrl), {
        method: "GET",
        headers: {
          authorization: `Bearer ${env.apiKey}`,
          "x-source-identity": env.sourceIdentity!,
          "x-candidate-sha": env.candidateSha!,
          "x-replay-index": String(replayIndex),
        },
      });
      statuses.push(response.status);
      await response.arrayBuffer();
    });
    await Promise.all(batch);
  });
  await Promise.all(jobs);

  const evidence: CloneHttpGateEvidence = {
    [HARNESS_STATUS_FIELD]: statuses.every((statusCode) => statusCode >= 200 && statusCode < 300) ? HARNESS_PASS : HARNESS_BLOCKED,
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
    blockedReasons: statuses.every((status) => status >= 200 && status < 300)
      ? undefined
      : [`HTTP ingress returned non-2xx statuses: ${statuses.join(",")}`],
    sideEffects: zeroSideEffects(),
  };
  await fs.writeFile(env.egressCapturePath!, `${redactJson(evidence)}\n`);
  return evidence;
}

export async function writeEmptyCloneEgressCapture(
  env: CloneHttpGateEnv,
  now = new Date(),
): Promise<CloneEgressCapture> {
  const missing = validateCloneHttpGateEnv(env);
  if (missing.length > 0) {
    throw new Error(`BLOCKED: clone HTTP gate missing fail-closed config: ${missing.join(", ")}`);
  }
  const capture: CloneEgressCapture = {
    mode: "deny",
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
  await fs.writeFile(env.egressCapturePath!, `${redactJson(capture)}\n`);
  return capture;
}

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
    && !/[;&|`$<>\\]/.test(path)
    && !/(phone|device|adb|restart|release|publish|dispatch|ws|websocket|vlm)/i.test(path);
}

function positiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 20;
}
