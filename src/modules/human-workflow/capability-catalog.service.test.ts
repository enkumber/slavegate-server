import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db/client";
import {
  CapabilityCatalogService,
  formatCompilerRetrievalContext,
  rankWorkflowCapabilities,
  selectUnambiguousCapability,
  type WorkflowCapabilityRecord,
} from "./capability-catalog.service";
import type { WorkflowGoalContract } from "../workflows/types";

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
}));

function capability(overrides: Partial<WorkflowCapabilityRecord> = {}): WorkflowCapabilityRecord {
  return {
    capabilityKey: "remote_support_enable_screen_share",
    platform: "android",
    description: "Enable screen sharing for remote support",
    aliases: ["pornește screen share", "enable remote support"],
    requiredTerms: [],
    forbiddenTerms: [],
    safetyClass: "standard",
    portabilityScope: "global",
    minMatchScore: 0.62,
    ambiguityMargin: 0.12,
    metadata: { appId: "remote_support" },
    updatedAt: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("workflow capability catalog ranking", () => {
  it("maps alternate natural-language requests through database aliases", () => {
    const ranked = rankWorkflowCapabilities(
      "te rog pornește screen sharing pe telefon",
      "android",
      [capability()],
    );
    expect(ranked[0]?.capability.capabilityKey).toBe("remote_support_enable_screen_share");
    expect(selectUnambiguousCapability(ranked)?.score).toBeGreaterThanOrEqual(0.62);
  });

  it("fails closed when the database catalog returns ambiguous capabilities", () => {
    const ranked = rankWorkflowCapabilities(
      "enable remote support screen share",
      "android",
      [
        capability(),
        capability({
          capabilityKey: "remote_support_start_screen_share",
          aliases: ["enable remote support screen share"],
          updatedAt: "2026-07-23T10:01:00.000Z",
        }),
      ],
    );
    expect(selectUnambiguousCapability(ranked)).toBeNull();
  });
});

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
      if (sql.includes("FROM workflow_capabilities")) {
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
      if (sql.includes("artifact_state IN ('failed', 'quarantined')")) {
        return {
          rows: [{
            canonical_workflow_id: "bad_remote_support_v1",
            workflow: {
              id: "bad_remote_support_v1",
              name: "Enable remote support screen share",
              description: "Rejected plan",
              steps: [{ action: "open_app", params: { packageName: "invalid.package" } }],
            },
            source_metadata: { quarantineReason: "package not installed" },
          }],
        };
      }
      return { rows: [] };
    });
    vi.mocked(getDb).mockReturnValue({ query } as any);

    const context = await new CapabilityCatalogService().retrieve(
      "pornește screen share pentru remote support",
      "android",
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
  });
});
