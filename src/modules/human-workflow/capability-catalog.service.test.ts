import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db/client";
import {
  CapabilityCatalogService,
  formatCompilerRetrievalContext,
} from "./capability-catalog.service";
import type { WorkflowGoalContract } from "../workflows/types";

const retrievalPolicy = {
  maxContextArtifacts: 4,
  maxContextUiItems: 10,
  maxContextFailures: 4,
  maxRankedCapabilities: 5,
  maxArtifactRows: 20,
  maxFailedArtifactRows: 50,
  maxArtifactSteps: 16,
  artifactParamAllowlist: ["target"],
  uiGraphSafetyAllowlist: ["read_only", "navigation"] as const,
  artifactSafetyAllowlist: {
    read_only: ["read_only"],
    navigation: ["read_only", "navigation"],
    standard: ["read_only", "navigation", "standard"],
    mutating: ["read_only", "navigation", "standard", "mutating"],
    sensitive: ["read_only", "navigation", "standard", "mutating", "sensitive"],
    destructive: ["read_only", "navigation", "standard", "mutating", "sensitive", "destructive"],
  },
};

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
}));

describe("retrieval-before-LLM compiler context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a complete promoted hit plus safe partial knowledge and failure constraints", async () => {
    const goalContract: WorkflowGoalContract = {
      version: "1",
      allowedEffects: ["none", "observation", "navigation", "ui_input"],
      requiredOutputs: ["result"],
      stages: [{
        id: "observe",
        allowedActions: ["classify_ui_tree"],
        allowedEffects: ["observation"],
        produces: ["result"],
      }],
    };
    const workflow = {
      id: "remote_support_enable_screen_sharing_v1",
      name: "Enable remote support screen sharing",
      description: "Verified workflow",
      platform: "android",
      version: "1.0.0",
      safetyClass: "standard",
      steps: [
        { id: "open", type: "action", action: "a11y_find_tap", params: { target: "Share screen", secret: "never-copy" } },
        { id: "ready", type: "checkpoint", reason: "Ready" },
      ],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("resolve_workflow_capabilities")) {
        return {
          rows: [{
            capability_key: "remote_support_enable_screen_share",
            platform: "android",
            description: "Enable screen sharing for remote support",
            aliases: ["pornește screen share", "enable remote support"],
            required_terms: [],
            forbidden_terms: [],
            safety_class: "standard",
            portability_scope: "global",
            min_match_score: 0.62,
            ambiguity_margin: 0.12,
            metadata: { appId: "remote_support", goalContract },
            updated_at: new Date("2026-07-23T10:00:00.000Z"),
            score: 0.91,
            selected: true,
          }],
        };
      }
      if (sql.includes("FROM workflow_capability_artifacts")) {
        return {
          rows: [{
            capability_key: "remote_support_enable_screen_share",
            role: "complete",
            cache_key: "a".repeat(24),
            artifact_state: "promoted",
            workflow,
            compiled_plan: { metadata: { safetyClass: "standard" } },
            source_metadata: { safetyClass: "standard" },
          }],
        };
      }
      if (sql.includes("artifact_state = 'promoted'")) return { rows: [] };
      if (sql.includes("FROM ui_graph_selectors")) {
        return {
          rows: [{
            app_id: "remote_support",
            state_key: "home",
            element_key: "share_screen",
            strategy: "text",
            selector: { value: "Share screen" },
            confidence: 0.99,
          }],
        };
      }
      if (sql.includes("FROM ui_graph_transitions")) return { rows: [] };
      if (sql.includes("definition.retryable OR definition.administrative")) {
        return {
          rows: [{
            canonical_workflow_id: "bad_remote_support_v1",
            workflow: {
              id: "bad_remote_support_v1",
              name: "Enable remote support screen share",
              description: "Rejected plan",
              steps: [{ action: "open_app", params: { packageName: "invalid.package" } }],
            },
            source_metadata: {
              capabilityKey: "remote_support_enable_screen_share",
              quarantineReason: "package not installed",
            },
          }],
        };
      }
      return { rows: [] };
    });
    vi.mocked(getDb).mockReturnValue({ query } as any);

    const context = await new CapabilityCatalogService().retrieve(
      "pornește screen share pentru remote support",
      "android",
      retrievalPolicy as any,
    );

    expect(context).toMatchObject({
      fullArtifactCacheKey: "a".repeat(24),
      matchedCapabilityKey: "remote_support_enable_screen_share",
      recommendedSafetyClass: "standard",
      goalContract,
    });
    expect(context.knowledge.uiGraph.selectors[0]).toMatchObject({
      appId: "remote_support",
      element: "share_screen",
    });
    expect(context.knowledge.avoid[0]).toMatchObject({
      reason: "package not installed",
      packagesFromRejectedPlan: ["invalid.package"],
    });
    expect(formatCompilerRetrievalContext(context)).not.toContain("never-copy");

    const selectorQuery = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("FROM ui_graph_selectors"));
    const transitionQuery = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("FROM ui_graph_transitions"));
    const artifactQuery = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("FROM workflow_capability_artifacts"));
    const failureQuery = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("definition.retryable OR definition.administrative"));

    expect(selectorQuery).toContain("definition.lifecycle_key = binding.lifecycle_key");
    expect(selectorQuery).not.toContain("selector.lifecycle_key");
    expect(transitionQuery).toContain("definition.lifecycle_key = binding.lifecycle_key");
    expect(transitionQuery).not.toContain("ui_graph_transitions.lifecycle_key");
    expect(artifactQuery).toContain("cache_state.lifecycle_key = cache_lifecycle.lifecycle_key");
    expect(artifactQuery).not.toContain("cache.lifecycle_key");
    expect(failureQuery).toContain("definition.lifecycle_key = binding.lifecycle_key");
    expect(failureQuery).not.toContain("generated_workflow_plan_cache.lifecycle_key");
  });
});
