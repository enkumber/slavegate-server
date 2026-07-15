import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type BaselineEntry = {
  file: string;
  kind: string;
  count: number;
  classification: string;
};

const repoRoot = path.resolve(__dirname, "../..");

const directWsServerMethods = new Set([
  "sendJob",
  "sendBatch",
  "sendWorkflowStart",
  "sendWorkflowCancel",
  "sendToDevice",
]);

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
    const findings = scanSourceText(fs.readFileSync(path.join(repoRoot, file), "utf8"), file);

    for (const kind of findings) {
      const key = `${file}\t${kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, kind] = key.split("\t");
      return { file, kind, count };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
}

function scanSourceText(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      findings.push(...classifyCall(node, sourceFile));
    } else if (ts.isFunctionDeclaration(node)) {
      findings.push(...classifyFunctionDeclaration(node));
    } else if (ts.isMethodDeclaration(node)) {
      findings.push(...classifyMethodDeclaration(node));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

function classifyCall(node: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  const callee = node.expression;

  if (ts.isIdentifier(callee)) {
    if (callee.text === "sendJobToDevice") return ["sendJobToDevice"];
    if (callee.text === "sendToDevice") return ["sendToDevice"];
    return [];
  }

  if (!ts.isPropertyAccessExpression(callee)) return [];

  const receiver = callee.expression.getText(sourceFile);
  const method = callee.name.text;
  const findings: string[] = [];

  if (receiver === "directWsServer" && directWsServerMethods.has(method)) {
    findings.push(`directWsServer.${method}`);
  }
  if (receiver === "transport" && method === "sendJob") {
    findings.push("transport.sendJob");
  }
  if (method === "sendJob" && /\b\w*Adapter$/.test(receiver)) {
    findings.push("adapter.sendJob");
  }
  if (method === "sendToDevice") {
    findings.push("sendToDevice");
  }
  if (receiver === "ws" && method === "send") {
    findings.push("ws.send");
  }

  return findings;
}

function classifyFunctionDeclaration(node: ts.FunctionDeclaration): string[] {
  return node.name?.text === "sendJobToDevice" ? ["sendJobToDevice"] : [];
}

function classifyMethodDeclaration(node: ts.MethodDeclaration): string[] {
  return ts.isIdentifier(node.name) && node.name.text === "sendToDevice" ? ["sendToDevice"] : [];
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

  it("ignores comments and string literals that merely mention sender names", () => {
    const source = `
      const text = "sendJobToDevice(deviceId, payload); directWsServer.sendBatch(deviceId, payload);";
      // ws.send(JSON.stringify(payload));
      export function harmless(): void {}
    `;

    expect(scanSourceText(source, "fixture.ts")).toEqual([]);
  });
});
