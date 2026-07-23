import { describe, expect, it } from "vitest";
import { classifySnapshot, replayStateMachine } from "./snapshot-replay.service";

const rules = [
  { state: "ready", all: ["Ready", "Stop service"] },
  { state: "warning", any: ["I Agree", "OK"], none: ["Ready"] },
  { state: "unknown" },
];

describe("UI graph snapshot replay", () => {
  it("classifies deterministic state rules", () => {
    expect(classifySnapshot("RustDesk Ready Stop service", rules)).toBe("ready");
    expect(classifySnapshot("Warning I Agree", rules)).toBe("warning");
  });

  it("fails closed for unknown states", () => {
    const result = replayStateMachine("unexpected screen", rules, {
      goalStates: ["ready"],
      unknownStates: ["unknown"],
      transitions: [{ from: "warning", to: ["ready"] }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_state_is_fail_closed");
  });

  it("requires an available transition for non-goal states", () => {
    const result = replayStateMachine("Warning OK", rules, {
      goalStates: ["ready"],
      unknownStates: ["unknown"],
      transitions: [{ from: "warning", to: ["ready"] }],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("transition_available");
  });
});
