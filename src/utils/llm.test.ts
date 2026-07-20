import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  modelConfigFetch: vi.fn(),
}));

vi.mock("../modules/model-config/model-config.service", () => ({
  modelConfigService: { resolve: mocks.resolve },
  modelConfigFetch: mocks.modelConfigFetch,
  sanitizeProviderError: (value: string) => value,
}));

import { llmJson } from "./llm";

describe("llm raw response capture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("captures the exact response and actual resolved decision model before JSON parsing", async () => {
    mocks.resolve.mockResolvedValue({
      provider: "openai_compatible",
      model: "qwen3.6-35b-a3b",
      endpoint: "http://gx10.example/v1",
      apiKey: "test-key",
    });
    const rawResponse = "```json\n{\"steps\":[]}\n```";
    mocks.modelConfigFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawResponse } }] }),
    });
    const captured = vi.fn();

    const result = await llmJson<{ steps: unknown[] }>("compile", undefined, {
      max_tokens: 4096,
      onRawResponse: captured,
    });

    expect(result).toEqual({ steps: [] });
    expect(captured).toHaveBeenCalledWith(rawResponse, {
      role: "decision_llm",
      provider: "openai_compatible",
      model: "qwen3.6-35b-a3b",
      endpoint: "http://gx10.example/v1",
    });
  });
});
