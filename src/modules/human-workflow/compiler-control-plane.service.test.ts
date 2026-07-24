import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db/client";
import {
  loadHumanWorkflowCompilerControlPlane,
  renderCompilerTemplate,
} from "./compiler-control-plane.service";

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
}));

const payload = {
  version: "postgres-authoritative-test",
  missingCapabilityPolicy: "fail_closed",
  normalizationPolicy: "strict_reject",
  promptKeys: {
    compile: "compile",
    repair: "repair",
    compileSystem: "compile_system",
    repairSystem: "repair_system",
    policy: "policy",
  },
  llm: {
    initialMaxTokens: 4096,
    repairMaxTokens: 6144,
    temperature: 0,
    disableThinking: true,
  },
  retrievalPolicy: {
    maxContextArtifacts: 4,
    maxContextUiItems: 10,
    maxContextFailures: 4,
    maxRankedCapabilities: 5,
    maxArtifactRows: 20,
    maxFailedArtifactRows: 50,
    maxArtifactSteps: 16,
    artifactParamAllowlist: ["packageName"],
    uiGraphSafetyAllowlist: ["read_only", "navigation"],
    artifactSafetyAllowlist: {
      read_only: ["read_only"],
      navigation: ["read_only", "navigation"],
      standard: ["read_only", "navigation", "standard"],
      mutating: ["read_only", "navigation", "standard", "mutating"],
      sensitive: ["read_only", "navigation", "standard", "mutating", "sensitive"],
      destructive: ["read_only", "navigation", "standard", "mutating", "sensitive", "destructive"],
    },
  },
  safetyClassMap: {
    read_only: "read_only",
    navigation: "read_only",
    standard: "standard",
    mutating: "standard",
    sensitive: "standard",
    destructive: "destructive",
  },
};

describe("PostgreSQL compiler control plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads every compiler decision input from PostgreSQL", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ payload }] })
      .mockResolvedValueOnce({
        rows: Object.values(payload.promptKeys).map((key) => ({ key, content: `db:${key}` })),
      })
      .mockResolvedValueOnce({ rows: [{ payload: { id: "open_app" } }] });
    vi.mocked(getDb).mockReturnValue({ query } as any);

    const control = await loadHumanWorkflowCompilerControlPlane();
    expect(control.version).toBe(payload.version);
    expect(control.retrievalPolicy).toEqual(payload.retrievalPolicy);
    expect(control.prompts.compile).toBe("db:compile");
    expect(control.toolCatalog).toEqual([{ id: "open_app" }]);
  });

  it("fails closed when retrieval policy is missing", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ payload: { ...payload, retrievalPolicy: undefined } }],
    });
    vi.mocked(getDb).mockReturnValue({ query } as any);
    await expect(loadHumanWorkflowCompilerControlPlane()).rejects.toMatchObject({
      code: "HUMAN_WORKFLOW_COMPILER_CONTROL_PLANE_UNAVAILABLE",
    });
  });

  it("rejects unbound database prompt placeholders", () => {
    expect(() => renderCompilerTemplate("{{goal}} {{missing}}", { goal: "ok" }))
      .toThrow("unbound prompt placeholders: missing");
  });
});
