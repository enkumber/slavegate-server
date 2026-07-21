#!/usr/bin/env node
/**
 * Refresh the Reddit app map through the remote Phone Network API.
 *
 * This intentionally does not connect to local PostgreSQL, local Docker, or a
 * localhost server. It reads the remote API endpoint/token from:
 *   /data/.openclaw/credentials/phone-network-api-token.json
 *
 * Safety: the server route uses read-only navigation only. It opens Reddit,
 * sends Reddit deep links, dumps UI trees, scrolls one feed page, and optionally
 * stores screenshots as files. It does not vote/comment/join/login/settings.
 *
 * This helper defaults to dry-run. Use --live to call the remote API.
 */

const fs = require("fs/promises");
const path = require("path");

const CREDENTIAL_PATH = "/data/.openclaw/credentials/phone-network-api-token.json";
const DEFAULT_DEVICE_ID = "d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd";
const DEFAULT_OUT_DIR = "/data/.openclaw/workspace/reports/phone-network/app-map-refresh";
const REFRESH_ROUTE = "/api/mapping/refresh/com.reddit.frontpage";

function parseArgs(argv) {
  const args = {
    live: false,
    deviceId: DEFAULT_DEVICE_ID,
    captureScreenshots: false,
    postUri: "",
    outDir: DEFAULT_OUT_DIR,
    selfTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") args.live = true;
    else if (arg === "--no-live" || arg === "--dry-run") args.live = false;
    else if (arg === "--device-id") args.deviceId = argv[++i];
    else if (arg === "--post-uri") args.postUri = argv[++i];
    else if (arg === "--screenshots") args.captureScreenshots = true;
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node server/scripts/refresh-reddit-app-map-remote.js [options]

Options:
  --live                 Execute the remote refresh. Default is dry-run/no-live.
  --no-live, --dry-run   Validate inputs/credentials and write no live evidence.
  --device-id <uuid>     Target device. Defaults to approved first-gate device.
  --post-uri <url>       Optional reddit.com /r/.../comments/... URL for read-only post detail capture.
  --screenshots          Also store screenshot artifacts on the remote server route.
  --out-dir <path>       Local output directory for response/summary JSON.
  --self-test            Run local response parsing checks without network.
`);
}

async function loadCredentials() {
  const raw = await fs.readFile(CREDENTIAL_PATH, "utf8");
  const credentials = JSON.parse(raw);
  const server = String(credentials.server || "").replace(/\/+$/, "");
  const token = String(credentials.api_key || credentials.token || "");
  if (!server || !token) {
    throw new Error(`Credential file must include server and api_key/token: ${CREDENTIAL_PATH}`);
  }
  return { server, token };
}

function compactErrorText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function compactPayload(payload, httpStatus) {
  const data = payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload;
  const summary = data?.summary || {};
  const quality = data?.quality || {};
  const stats = quality.stats || {};
  return {
    httpStatus,
    ok: Boolean((payload && payload.ok) ?? data?.ok),
    pagesCaptured: summary.pagesCaptured || [],
    signatureHashesPresent: Object.values(summary.signatureHashes || {}).filter(Boolean).length,
    elementCount: summary.elementCount || 0,
    boundsCoverage: summary.boundsCoverage ?? 0,
    selectorCoverage: summary.selectorCoverage ?? 0,
    failures: summary.failures || data?.failures || [],
    qualityErrors: quality.errors || [],
    qualityWarnings: quality.warnings || [],
    stats,
    safety: data?.safety
      ? {
          mode: data.safety.mode,
          blocked: data.safety.blocked,
        }
      : undefined,
  };
}

function parseRemoteBody(text, httpStatus) {
  try {
    return { payload: JSON.parse(text), parseError: null };
  } catch {
    return {
      payload: {
        ok: false,
        error: `Remote returned non-JSON HTTP ${httpStatus}`,
        responseSnippet: compactErrorText(text),
      },
      parseError: "non_json_response",
    };
  }
}

async function writeEvidence(args, started, evidence) {
  await fs.mkdir(args.outDir, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const evidencePath = path.join(args.outDir, `${stamp}-reddit-refresh-evidence.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}

async function runSelfTest() {
  const direct = compactPayload({ ok: true, summary: { pagesCaptured: ["home"], elementCount: 3 } }, 200);
  const wrapped = compactPayload({ ok: true, data: { summary: { pagesCaptured: ["search"], signatureHashes: { a: "h" } } } }, 200);
  const html = parseRemoteBody("<html>server error</html>", 502);
  const ok = direct.ok
    && direct.pagesCaptured[0] === "home"
    && wrapped.pagesCaptured[0] === "search"
    && wrapped.signatureHashesPresent === 1
    && html.parseError === "non_json_response"
    && !html.payload.responseSnippet.includes("\n");
  console.log(JSON.stringify({ ok, checks: ["direct_payload", "wrapped_ok_data", "non_json_compaction"] }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    await runSelfTest();
    return;
  }

  const { server, token } = await loadCredentials();
  const started = new Date();
  const targetUrl = `${server}${REFRESH_ROUTE}`;

  if (!args.live) {
    const evidence = {
      ok: true,
      mode: "dry_run",
      route: REFRESH_ROUTE,
      targetServer: server,
      targetDeviceId: args.deviceId,
      credentialPath: CREDENTIAL_PATH,
      credentialSource: "api_key_preferred",
      tokenLogged: false,
      liveCallMade: false,
      readOnlyIntent: true,
      blockedActions: ["vote", "comment", "join", "login", "settings", "profile_mutation"],
    };
    const evidencePath = await writeEvidence(args, started, evidence);
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
    return;
  }

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": token,
    },
    body: JSON.stringify({
      deviceId: args.deviceId,
      captureScreenshots: args.captureScreenshots,
      postUri: args.postUri || undefined,
    }),
  });

  const text = await response.text();
  const { payload, parseError } = parseRemoteBody(text, response.status);
  const compact = compactPayload(payload, response.status);
  const evidence = {
    ...compact,
    ok: response.ok && compact.ok && !parseError,
    mode: "live",
    route: REFRESH_ROUTE,
    targetServer: server,
    targetDeviceId: args.deviceId,
    parseError,
    tokenLogged: false,
  };
  const evidencePath = await writeEvidence(args, started, evidence);
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));

  if (!evidence.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`refresh-reddit-app-map failed: ${error.message}`);
  process.exit(1);
});
