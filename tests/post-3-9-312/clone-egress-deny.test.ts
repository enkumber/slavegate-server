import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLONE_EGRESS_CHANNELS,
  validateCloneHttpGateEnv,
  writeEmptyCloneEgressCapture,
} from "../../src/harness/post-3-9-312/clone-egress-deny";

describe("post-3.9.312 live-derived clone HTTP gate egress seam", () => {
  it("fails closed without candidate, fixture DSN, source identity, API config, and deny capture", () => {
    expect(validateCloneHttpGateEnv({})).toEqual(expect.arrayContaining([
      "PN_POST_312_CLONE_CANDIDATE_SHA",
      "PN_POST_312_CLONE_DATABASE_URL",
      "PN_POST_312_CLONE_SOURCE_IDENTITY",
      "PN_POST_312_CLONE_API_BASE_URL or PN_POST_312_CLONE_LAUNCH_CONFIG",
      "PN_POST_312_CLONE_EGRESS_DENY=true",
      "PN_POST_312_CLONE_EGRESS_CAPTURE_PATH",
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
});
