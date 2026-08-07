import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/client", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import { WorkflowSegmentRepository } from "./repository";

describe("workflow composition identity lookup", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("fails closed when one identity matches a composition name and another composition key", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        { composition_name: "0123456789abcdef01234567", composition_key: "a".repeat(24) },
        { composition_name: "different_composition", composition_key: "0123456789abcdef01234567" },
      ],
    });

    await expect(new WorkflowSegmentRepository().compositionVersion(
      "0123456789abcdef01234567",
      "2026.08.07.1",
      { dispatchable: true },
    )).rejects.toMatchObject({
      status: 409,
      code: "WORKFLOW_COMPOSITION_IDENTITY_AMBIGUOUS",
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
