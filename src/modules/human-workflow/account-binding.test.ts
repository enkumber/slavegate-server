import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query: mocks.query })),
}));

import { humanWorkflowCompilerService } from "./human-workflow-compiler.service";

describe("human workflow account binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed instead of degrading a supplied account to an accountless target", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          device_id: "11111111-1111-4111-8111-111111111111",
          device_model: "Pixel",
          device_name: "Test device",
          account_id: "22222222-2222-4222-8222-222222222222",
          account_username: "acct",
          account_platform: "reddit",
          account_device_id: "11111111-1111-4111-8111-111111111111",
          client_id: "33333333-3333-4333-8333-333333333333",
        }],
      })
      .mockResolvedValueOnce({ rows: [{ app_id: "gmail" }] });

    await expect(humanWorkflowCompilerService.resolveTarget(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "open gmail",
    )).rejects.toMatchObject({ code: "ACCOUNT_BINDING_PLATFORM_MISMATCH" });
  });
});
