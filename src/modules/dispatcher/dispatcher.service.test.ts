import { describe, expect, it } from "vitest";
import { workflowChildTimeoutDisposition } from "./dispatcher.service";

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
});
