import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directWsPath = path.resolve(__dirname, "../../src/ws/direct-ws.server.ts");

function handlerSource(): string {
  const source = fs.readFileSync(directWsPath, "utf8");
  const start = source.indexOf("private async _handleJobResult");
  const end = source.indexOf("\n  private ", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, end < 0 ? source.length : end);
}

describe("PNQ-001 JOB_RESULT terminal side-effect boundary", () => {
  it("gates Android results without pnqHandle through terminal CAS before side effects", () => {
    const handler = handlerSource();
    const terminalCas = handler.indexOf("await deviceExecutionArbiter.observeTerminal");
    const pendingResolve = handler.indexOf("pending.resolve(");
    const workflowResolve = handler.indexOf("resolveJobResult(jobId");
    const dispatcherUpdate = handler.indexOf("dispatcherService.handleJobResult(");

    expect(terminalCas).toBeGreaterThanOrEqual(0);
    expect(handler).not.toContain("if (pending?.permit || handle)");
    expect(handler).not.toContain("observeRootTerminal(");
    expect(terminalCas).toBeLessThan(pendingResolve);
    expect(terminalCas).toBeLessThan(workflowResolve);
    expect(terminalCas).toBeLessThan(dispatcherUpdate);
    expect(handler.slice(terminalCas, pendingResolve)).toContain('if (terminal.decision !== "terminal")');
    expect(handler.slice(terminalCas, pendingResolve)).toContain("return;");
  });
});
