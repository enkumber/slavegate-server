import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

type BaselineEntry = {
  file: string;
  kind: string;
  count: number;
  classification: string;
};

const repoRoot = path.resolve(__dirname, "../..");

const scanPatterns: Array<[kind: string, pattern: RegExp]> = [
  ["sendJobToDevice", /\bsendJobToDevice\s*\(/],
  ["directWsServer.sendBatch", /\bdirectWsServer\.sendBatch\s*\(/],
  ["directWsServer.sendWorkflowStart", /\bdirectWsServer\.sendWorkflowStart\s*\(/],
  ["directWsServer.sendWorkflowCancel", /\bdirectWsServer\.sendWorkflowCancel\s*\(/],
  ["directWsServer.sendToDevice", /\bdirectWsServer\.sendToDevice\s*\(/],
  ["transport.sendJob", /\btransport\.sendJob\s*\(/],
  ["adapter.sendJob", /\b\w*Adapter\.sendJob\s*\(/],
  ["sendToDevice", /\bsendToDevice\s*\(/],
  ["ws.send", /\bws\.send\s*\(/],
];

const excludedFiles = [
  /\.test\.ts$/,
  /\.backup$/,
  /\.md$/,
  /\.map$/,
  /\/db\/migrations\//,
];

function walkProductionTs(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(repoRoot, fullPath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
      walkProductionTs(fullPath, files);
      continue;
    }

    if (
      entry.isFile() &&
      relPath.endsWith(".ts") &&
      !excludedFiles.some((pattern) => pattern.test(relPath))
    ) {
      files.push(relPath);
    }
  }

  return files;
}

function currentEgressBaseline(): Array<Omit<BaselineEntry, "classification">> {
  const counts = new Map<string, number>();

  for (const file of walkProductionTs(path.join(repoRoot, "src"))) {
    const lines = fs.readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/);

    for (const line of lines) {
      for (const [kind, pattern] of scanPatterns) {
        if (pattern.test(line)) {
          const key = `${file}\t${kind}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, kind] = key.split("\t");
      return { file, kind, count };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
}

describe("PNQ-001 production egress inventory guard", () => {
  it("matches the reviewed static sender baseline", () => {
    const baselinePath = path.join(repoRoot, "evidence/PNQ-001/static-egress-baseline.json");
    const expected = (JSON.parse(fs.readFileSync(baselinePath, "utf8")) as BaselineEntry[])
      .map(({ file, kind, count }) => ({ file, kind, count }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));

    expect(currentEgressBaseline()).toEqual(expected);
  });

  it("keeps every baseline entry classified for review", () => {
    const baselinePath = path.join(repoRoot, "evidence/PNQ-001/static-egress-baseline.json");
    const expected = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as BaselineEntry[];

    expect(expected).not.toHaveLength(0);
    for (const entry of expected) {
      expect(entry.classification.trim()).not.toEqual("");
    }
  });
});
