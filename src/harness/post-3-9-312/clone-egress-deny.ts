import fs from "node:fs/promises";
import { redactJson } from "./redaction";

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
  if (env.fixtureDatabaseUrl && !isFixtureDsn(env.fixtureDatabaseUrl)) {
    missing.push("PN_POST_312_CLONE_DATABASE_URL must target a disposable fixture/clone/test database");
  }
  return missing;
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

function isFixtureDsn(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return /^(127\.0\.0\.1|localhost)$/i.test(parsed.hostname)
      && /(fixture|clone|test|pg17|pnq)/i.test(`${parsed.pathname} ${parsed.search}`);
  } catch {
    return false;
  }
}
