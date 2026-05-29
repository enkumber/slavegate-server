import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMap } from "../../app-mapping/schema";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
  llmJson: vi.fn(),
  loadMap: vi.fn(),
}));

vi.mock("../../../db/client", () => ({
  getDb: () => mocks.db,
}));

vi.mock("../../../utils/llm", () => ({
  llmJson: mocks.llmJson,
}));

vi.mock("../../app-mapping/recorder.service", () => ({
  loadMap: mocks.loadMap,
}));

import { compileInstruction } from "../planner.service";

function appMap(): AppMap {
  return {
    appId: "com.reddit.frontpage",
    appName: "Reddit",
    version: "map-v1",
    pages: {
      reddit_home: {
        name: "Home",
        discoveryOrder: 0,
        detection: {
          method: "ui_tree_signature",
          anchors: ["home"],
          signatureHash: "sig-home",
        },
        elements: {},
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pageCount: 1,
    transitionCount: 0,
  };
}

describe("compileInstruction model routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMap.mockResolvedValue(appMap());
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "compiled-workflow-id" }] });
    mocks.llmJson.mockResolvedValue({
      name: "AskReddit read 3",
      startPage: "reddit_home",
      steps: [
        {
          id: "read",
          action: "wait",
          expectedPage: "reddit_home",
          expectedPageHash: "sig-home",
          description: "Wait for feed",
        },
      ],
    });
  });

  it("does not pass the retired codex model override to llmJson", async () => {
    const result = await compileInstruction({
      appId: "com.reddit.frontpage",
      instruction: "Read the first 3 r/AskReddit posts",
      options: {
        model: "openai-codex/gpt-5.5",
        recoveryModel: "openai-codex/gpt-5.5",
      },
    });

    expect(result.ok).toBe(true);
    expect(mocks.llmJson).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ system: "You are a workflow compiler. Respond ONLY with valid JSON." }),
    );
    expect(result.compiledWorkflow?.recoveryModel).toBeUndefined();
  });
});
