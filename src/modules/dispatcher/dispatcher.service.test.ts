import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { shouldBlockRootForTimedOutJob, workflowChildTimeoutDisposition } from "./dispatcher.service";

describe("server-workflow child timeout clock", () => {
  it("does not consume execution timeout while PNQ still owns the child as queued", () => {
    expect(workflowChildTimeoutDisposition({
      root_state: "queued",
      operation_state: "registered",
    }, false)).toBe("wait_queued");
  });

  it("arms a fresh execution timeout once PNQ advances the child to the wire", () => {
    expect(workflowChildTimeoutDisposition({
      root_state: "dispatching",
      operation_state: "dispatched",
    }, false)).toBe("arm_execution");
    expect(workflowChildTimeoutDisposition({
      root_state: "dispatched",
      operation_state: "dispatched",
    }, true)).toBe("timeout");
  });

  it("fails closed when ownership is absent or no longer queue-waiting", () => {
    expect(workflowChildTimeoutDisposition(undefined, false)).toBe("timeout");
    expect(workflowChildTimeoutDisposition({
      root_state: "blocked",
      operation_state: "blocked",
    }, false)).toBe("timeout");
  });

  it("leaves a timed-out child under workflow ownership instead of blocking the canonical root", () => {
    expect(shouldBlockRootForTimedOutJob("workflow-1")).toBe(false);
    expect(shouldBlockRootForTimedOutJob()).toBe(true);
  });
});

describe("PNQ v2 shadow dispatch side effect", () => {
  it("does not await shadow enqueue before returning the legacy dispatch response", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/modules/dispatcher/dispatcher.service.ts"), "utf8");
    expect(source).toContain('runPnqV2ShadowSideEffect("enqueue"');
    expect(source).toContain("pnqV2RuntimeService.enqueueShadowJob");
    expect(source).not.toContain("await pnqV2RuntimeService.enqueueShadowJob");
  });
});
