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

type ImportBinding = {
  importedName: string;
  moduleSpecifier: string;
};

type RawImportBoundary = {
  file: string;
  importedName: string;
  sourceKind: "transport" | "direct-ws";
};

type EgressFinding = {
  file: string;
  kind: string;
  callee: string;
  importedName?: string;
  sourceKind?: "transport" | "direct-ws";
};

const repoRoot = path.resolve(__dirname, "../..");

const directWsServerMethods = new Set([
  "sendJob",
  "sendJobWithPermit",
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

const reviewedRawImportBoundaries = new Set([
  "src/api/hydra-routes.ts\tdirectWsServer\tdirect-ws",
  "src/api/routes.ts\tdirectWsServer\tdirect-ws",
  "src/index.ts\tdirectWsServer\tdirect-ws",
  "src/modules/agents/orchestrator.ts\tsendJobToDevice\ttransport",
  "src/modules/skills/skill.cascade.ts\tsendJobToDevice\ttransport",
  "src/modules/workflow-compiler/recovery.service.ts\tsendJobToDevice\ttransport",
  "src/modules/workflow-compiler/runner.service.ts\tsendJobToDevice\ttransport",
  "src/modules/workflow-compiler/runner.service.ts\tdirectWsServer\tdirect-ws",
  "src/modules/workflows/generated-workflow-execution.service.ts\tdirectWsServer\tdirect-ws",
  "src/modules/workflows/workflow-dispatch.service.ts\tsendJobToDevice\ttransport",
  "src/modules/workflows/workflow.executor.ts\tsendJobToDevice\ttransport",
  "src/modules/workflows/workflow.executor.ts\tdirectWsServer\tdirect-ws",
  "src/transport/transport.ts\tdirectWsServer\tdirect-ws",
]);

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
  return scanSource(sourceText, fileName).findings.map((finding) => finding.kind);
}

function scanSource(sourceText: string, fileName: string): {
  findings: EgressFinding[];
  rawImports: RawImportBoundary[];
} {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importBindings = collectImportBindings(sourceFile);
  const findings: EgressFinding[] = [];
  const rawImports = collectRawImportBoundaries(fileName, importBindings);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      findings.push(...classifyCall(node, sourceFile, importBindings, fileName));
    } else if (ts.isFunctionDeclaration(node)) {
      findings.push(...classifyFunctionDeclaration(node, fileName));
    } else if (ts.isMethodDeclaration(node)) {
      findings.push(...classifyMethodDeclaration(node, fileName));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { findings, rawImports };
}

function collectImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const moduleSpecifier = statement.moduleSpecifier.text;
    if (statement.importClause?.name) {
      bindings.set(statement.importClause.name.text, {
        importedName: "default",
        moduleSpecifier,
      });
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings) continue;

    if (ts.isNamespaceImport(namedBindings)) {
      bindings.set(namedBindings.name.text, {
        importedName: "*",
        moduleSpecifier,
      });
      continue;
    }

    if (!ts.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      bindings.set(element.name.text, {
        importedName: element.propertyName?.text ?? element.name.text,
        moduleSpecifier,
      });
    }
  }

  return bindings;
}

function collectRawImportBoundaries(
  file: string,
  importBindings: Map<string, ImportBinding>,
): RawImportBoundary[] {
  const imports: RawImportBoundary[] = [];

  for (const binding of importBindings.values()) {
    const sourceKind = rawSourceKind(binding.moduleSpecifier);
    if (!sourceKind) continue;
    if (
      binding.importedName !== "sendJobToDevice" &&
      binding.importedName !== "directWsServer" &&
      binding.importedName !== "*" &&
      binding.importedName !== "default"
    ) continue;
    imports.push({ file, importedName: binding.importedName, sourceKind });
  }

  return imports;
}

function rawSourceKind(moduleSpecifier: string): RawImportBoundary["sourceKind"] | null {
  const normalized = moduleSpecifier.replaceAll("\\", "/");
  if (normalized.endsWith("/transport/transport") || normalized === "../transport/transport") return "transport";
  if (normalized.endsWith("/ws/direct-ws.server") || normalized === "../ws/direct-ws.server") return "direct-ws";
  return null;
}

function classifyCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  importBindings: Map<string, ImportBinding>,
  file: string,
): EgressFinding[] {
  const callee = node.expression;

  if (ts.isIdentifier(callee)) {
    const binding = importBindings.get(callee.text);
    if (binding?.importedName === "sendJobToDevice" && rawSourceKind(binding.moduleSpecifier) === "transport") {
      return [findingForIdentifier(file, "sendJobToDevice", callee.text, importBindings)];
    }
    if (callee.text === "sendJobToDevice") {
      return [findingForIdentifier(file, "sendJobToDevice", callee.text, importBindings)];
    }
    if (callee.text === "sendToDevice") return [{ file, kind: "sendToDevice", callee: callee.text }];
    return [];
  }

  if (!ts.isPropertyAccessExpression(callee)) return [];

  const receiver = callee.expression.getText(sourceFile);
  const method = callee.name.text;
  const findings: EgressFinding[] = [];
  const receiverBinding = importBindings.get(receiver);

  if (
    directWsServerMethods.has(method) &&
    (receiver === "directWsServer" || receiverBinding?.importedName === "directWsServer")
  ) {
    findings.push(findingForProperty(file, `directWsServer.${method}`, receiver, method, importBindings));
  }
  if (
    method === "sendJobToDevice" &&
    receiverBinding?.importedName === "*" &&
    rawSourceKind(receiverBinding.moduleSpecifier) === "transport"
  ) {
    findings.push({
      file,
      kind: "sendJobToDevice",
      callee: `${receiver}.${method}`,
      importedName: "sendJobToDevice",
      sourceKind: "transport",
    });
  }
  if (directWsServerMethods.has(method)) {
    const namespaced = namespacedDirectWsServerReceiver(callee.expression, importBindings);
    if (namespaced) {
      findings.push({
        file,
        kind: `directWsServer.${method}`,
        callee: `${receiver}.${method}`,
        importedName: "directWsServer",
        sourceKind: "direct-ws",
      });
    }
  }
  if (receiver === "transport" && method === "sendJob") {
    findings.push({ file, kind: "transport.sendJob", callee: `${receiver}.${method}` });
  }
  if (method === "sendJob" && /\b\w*Adapter$/.test(receiver)) {
    findings.push({ file, kind: "adapter.sendJob", callee: `${receiver}.${method}` });
  }
  if (method === "sendToDevice") {
    findings.push({ file, kind: "sendToDevice", callee: `${receiver}.${method}` });
  }
  if (receiver === "ws" && method === "send") {
    findings.push({ file, kind: "ws.send", callee: `${receiver}.${method}` });
  }

  return findings;
}

function namespacedDirectWsServerReceiver(
  node: ts.Expression,
  importBindings: Map<string, ImportBinding>,
): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "directWsServer") return false;
  if (!ts.isIdentifier(node.expression)) return false;
  const binding = importBindings.get(node.expression.text);
  return binding?.importedName === "*" && rawSourceKind(binding.moduleSpecifier) === "direct-ws";
}

function findingForIdentifier(
  file: string,
  kind: string,
  callee: string,
  importBindings: Map<string, ImportBinding>,
): EgressFinding {
  const binding = importBindings.get(callee);
  return {
    file,
    kind,
    callee,
    importedName: binding?.importedName,
    sourceKind: binding ? rawSourceKind(binding.moduleSpecifier) ?? undefined : undefined,
  };
}

function findingForProperty(
  file: string,
  kind: string,
  receiver: string,
  method: string,
  importBindings: Map<string, ImportBinding>,
): EgressFinding {
  const binding = importBindings.get(receiver);
  return {
    file,
    kind,
    callee: `${receiver}.${method}`,
    importedName: binding?.importedName,
    sourceKind: binding ? rawSourceKind(binding.moduleSpecifier) ?? undefined : undefined,
  };
}

function classifyFunctionDeclaration(node: ts.FunctionDeclaration, file: string): EgressFinding[] {
  return node.name?.text === "sendJobToDevice"
    ? [{ file, kind: "sendJobToDevice", callee: "function sendJobToDevice" }]
    : [];
}

function classifyMethodDeclaration(node: ts.MethodDeclaration, file: string): EgressFinding[] {
  return ts.isIdentifier(node.name) && node.name.text === "sendToDevice"
    ? [{ file, kind: "sendToDevice", callee: "method sendToDevice" }]
    : [];
}

function currentSemanticBoundary(): {
  findings: EgressFinding[];
  rawImports: RawImportBoundary[];
} {
  const findings: EgressFinding[] = [];
  const rawImports: RawImportBoundary[] = [];

  for (const file of walkProductionTs(path.join(repoRoot, "src"))) {
    const result = scanSource(fs.readFileSync(path.join(repoRoot, file), "utf8"), file);
    findings.push(...result.findings);
    rawImports.push(...result.rawImports);
  }

  return { findings, rawImports };
}

function routerHandlerSource(method: string, routePath: string): string | null {
  const file = "src/api/routes.ts";
  const sourceText = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let handler: ts.Expression | null = null;

  const visit = (node: ts.Node): void => {
    if (handler || !ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.getText(sourceFile) === "router" &&
      callee.name.text === method &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === routePath
    ) {
      const candidate = node.arguments[node.arguments.length - 1];
      if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
        handler = candidate;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return handler?.getText(sourceFile) ?? null;
}

function importBoundaryKey(boundary: RawImportBoundary): string {
  return `${boundary.file}\t${boundary.importedName}\t${boundary.sourceKind}`;
}

function isReviewedCallBoundary(finding: EgressFinding): boolean {
  if (finding.kind === "sendJobToDevice" && finding.callee === "function sendJobToDevice") {
    return finding.file === "src/transport/transport.ts";
  }
  if (finding.kind === "sendJobToDevice") {
    return finding.importedName === "sendJobToDevice" && finding.sourceKind === "transport";
  }
  if (finding.kind.startsWith("directWsServer.")) {
    return finding.importedName === "directWsServer" && finding.sourceKind === "direct-ws";
  }
  if (finding.kind === "transport.sendJob") return finding.file === "src/api/routes.ts";
  if (finding.kind === "adapter.sendJob") return finding.file === "src/modules/skills/skill.cascade.ts";
  if (finding.kind === "sendToDevice") {
    return finding.file === "src/ws/direct-ws.server.ts"
      || finding.file === "src/ws/ws.server.ts"
      || finding.file === "src/api/routes.ts";
  }
  if (finding.kind === "ws.send") {
    return finding.file === "src/ws/direct-ws.server.ts"
      || finding.file === "src/ws/ws.server.ts"
      || finding.file === "src/ws/gateway.ts"
      || finding.file === "src/modules/workflow-events/workflow-event.service.ts";
  }
  return false;
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

  it("keeps raw sender imports inside reviewed semantic boundaries", () => {
    const { rawImports } = currentSemanticBoundary();
    const actual = rawImports.map(importBoundaryKey).sort();
    const expected = [...reviewedRawImportBoundaries].sort();

    expect(actual).toEqual(expected);
  });

  it("keeps raw sender calls tied to reviewed import/call boundaries", () => {
    const { findings } = currentSemanticBoundary();
    const violations = findings.filter((finding) => !isReviewedCallBoundary(finding));

    expect(violations).toEqual([]);
  });

  it("detects aliased and namespace raw transport sender bypasses", () => {
    const source = `
      import { sendJobToDevice as rawSend } from "../transport/transport";
      import * as transport from "../transport/transport";
      import { directWsServer as rawWs } from "../ws/direct-ws.server";
      import * as direct from "../ws/direct-ws.server";

      rawSend(deviceId, payload);
      transport.sendJobToDevice(deviceId, payload);
      rawWs.sendJob(deviceId, payload);
      direct.directWsServer.sendBatch(deviceId, payload);
    `;

    const result = scanSource(source, "fixture.ts");

    expect(result.rawImports.map(importBoundaryKey).sort()).toEqual([
      "fixture.ts\t*\tdirect-ws",
      "fixture.ts\t*\ttransport",
      "fixture.ts\tdirectWsServer\tdirect-ws",
      "fixture.ts\tsendJobToDevice\ttransport",
    ]);
    expect(result.findings.map((finding) => `${finding.kind}:${finding.callee}`).sort()).toEqual([
      "directWsServer.sendBatch:direct.directWsServer.sendBatch",
      "directWsServer.sendJob:rawWs.sendJob",
      "sendJobToDevice:rawSend",
      "sendJobToDevice:transport.sendJobToDevice",
    ]);
  });

  it("keeps POST /api/jobs as a 202 queued admission response", () => {
    const handler = routerHandlerSource("post", "/jobs");

    expect(handler).not.toBeNull();
    expect(handler).toContain("res.status(202).json");
    expect(handler).toContain('status: "queued"');
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
