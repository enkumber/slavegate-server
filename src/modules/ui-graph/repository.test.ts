import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../db/client", () => ({
  getDb: () => ({ query }),
}));

vi.mock("../app-mapping/recorder.service", () => ({
  loadMap: vi.fn(),
}));

import { UiGraphRepository } from "./repository";

describe("UiGraphRepository", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("loads lifecycle-filtered transitions without ambiguous selected columns", async () => {
    query.mockResolvedValue({
      rows: [{
        id: "b1e4b735-7741-4270-a5e5-585f10341f7d",
        transition_key: "open_search",
        app_id: "com.example.app",
        source_state_id: "7fde6cee-6c61-4aa0-a6ce-3eb80e84f643",
        target_state_id: "1335abe4-0d1a-435b-a4cc-d74bb90bfb3a",
        element_key: "search",
        action: { type: "tap" },
        preconditions: {},
        postconditions: { state: "search" },
        cost: 1,
        safety_class: "navigation",
        confidence: 0.98,
      }],
    });

    const repository = new UiGraphRepository();
    const transitions = await repository.loadTransitions("com.example.app");

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("SELECT transition.id");
    expect(sql).toContain("transition.confidence");
    expect(sql).not.toMatch(/,\s*status\s*(?:\n|FROM)/);
    expect(transitions).toEqual([
      expect.objectContaining({
        key: "open_search",
        appId: "com.example.app",
        safetyClass: "navigation",
        confidence: 0.98,
      }),
    ]);
  });
});
