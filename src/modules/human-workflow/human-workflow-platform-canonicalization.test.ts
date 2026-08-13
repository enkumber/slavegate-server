import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../db/client", () => ({
  getDb: () => ({ query }),
}));

import {
  HumanWorkflowCompilerService,
} from "./human-workflow-compiler.service";

const deviceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";

function mockTargetQueries(options: {
  accountPlatform?: string;
  bindingCanonical?: string | null;
  accountDeviceId?: string;
}): void {
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes("resolve_human_workflow_platform_binding")) {
      expect(params).toEqual(["open example", options.accountPlatform ?? "example"]);
      return options.bindingCanonical === null
        ? { rows: [] }
        : { rows: [{ canonical_platform: options.bindingCanonical ?? "com.example.surface" }] };
    }
    if (text.includes("FROM devices d")) {
      return {
        rows: [{
          device_id: deviceId,
          device_model: "Pixel",
          device_name: "Fixture",
          account_id: accountId,
          account_username: "fixture",
          account_platform: options.accountPlatform ?? "example",
          account_device_id: options.accountDeviceId ?? deviceId,
          client_id: "client-1",
        }],
      };
    }
    return { rows: [] };
  });
}

describe("human workflow platform canonicalization", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("resolves platform aliases through PostgreSQL before account comparison", async () => {
    mockTargetQueries({
      accountPlatform: "example",
      bindingCanonical: "com.example.surface",
    });

    const target = await new HumanWorkflowCompilerService().resolveTarget(deviceId, accountId, "open example");

    expect(target).toMatchObject({
      account_id: accountId,
      account_platform: "com.example.surface",
      client_id: "client-1",
    });
    const sqlText = query.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(sqlText).toContain("resolve_human_workflow_platform_binding");
    expect(sqlText).not.toContain("resolve_canonical_platform_identifier");
  });

  it("fails closed when PostgreSQL does not admit a platform binding", async () => {
    mockTargetQueries({
      accountPlatform: "example",
      bindingCanonical: null,
    });

    await expect(new HumanWorkflowCompilerService().resolveTarget(deviceId, accountId, "open example"))
      .rejects.toMatchObject({ code: "ACCOUNT_PLATFORM_MISMATCH" });
  });

  it("keeps canonicalization out of account/device binding", async () => {
    mockTargetQueries({
      accountPlatform: "example",
      bindingCanonical: "com.example.surface",
      accountDeviceId: "33333333-3333-4333-8333-333333333333",
    });

    await expect(new HumanWorkflowCompilerService().resolveTarget(deviceId, accountId, "open example"))
      .rejects.toMatchObject({ code: "ACCOUNT_DEVICE_MISMATCH" });
  });
});
