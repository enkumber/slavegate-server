import { describe, expect, it } from "vitest";
import {
  compositionCapabilityMetadata,
  completedSegmentBuildCapabilityKey,
  humanWorkflowCatalogHasCapability,
  humanWorkflowArtifactMatchesIntent,
  humanWorkflowExactCacheUsable,
} from "./human-workflow-compiler.service";

describe("composition capability persistence", () => {
  it("carries the PostgreSQL identity and goal contract into the capability catalog", () => {
    const goalContract = {
      version: "1" as const,
      stages: [{
        id: "cleanup",
        required: true,
        allowedActions: ["tap"],
      }],
      requiredOutputs: ["cleanupTree"],
      allowedEffects: ["local_restore"],
    };
    expect(compositionCapabilityMetadata({
      capabilityKey: "reddit_private_draft_reversible",
      template: { goalContract } as any,
    })).toEqual({
      capabilityKey: "reddit_private_draft_reversible",
      capabilityRole: "complete",
      goalContract,
    });
  });
});

describe("human workflow artifact identity", () => {
  it("does not reuse a contextual artifact for a different requested intent", () => {
    const artifact = {
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide browserul chrome si mergi pe google.com",
        portable: false,
        portabilityScope: "contextual",
      },
    } as any;

    expect(humanWorkflowArtifactMatchesIntent(
      artifact,
      "deschide browserul chrome si mergi pe ciprianneculai.com",
    )).toBe(false);
  });

  it("reuses an artifact for the exact same requested intent", () => {
    const artifact = {
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide browserul chrome si mergi pe ciprianneculai.com",
        portable: false,
        portabilityScope: "contextual",
      },
    } as any;

    expect(humanWorkflowArtifactMatchesIntent(
      artifact,
      "deschide browserul chrome si mergi pe ciprianneculai.com",
    )).toBe(true);
  });

  it("does not reuse even a portable complete artifact for a different intent", () => {
    const artifact = {
      sourceMetadata: {
        source: "dashboard_human",
        intent: "example intent",
        portable: true,
        portabilityScope: "global",
      },
    } as any;

    expect(humanWorkflowArtifactMatchesIntent(artifact, "different intent")).toBe(false);
  });
});

describe("completed segment-build reconciliation", () => {
  it("returns the promoted capability produced by a completed agent job", () => {
    expect(completedSegmentBuildCapabilityKey({
      result: { capabilityKey: "observe_current_page_title" },
    })).toBe("observe_current_page_title");
  });

  it("does not treat malformed job results as reusable results", () => {
    expect(completedSegmentBuildCapabilityKey({
      result: {},
    })).toBeNull();
  });
});

describe("PostgreSQL composition retrieval", () => {
  it("does not classify a matched capability as missing when its legacy metadata lacks goalContract", () => {
    expect(humanWorkflowCatalogHasCapability({
      matchedCapabilityKey: "reversible_private_draft_cleanup",
    })).toBe(true);
  });

  it("classifies only an absent capability match as missing", () => {
    expect(humanWorkflowCatalogHasCapability({ matchedCapabilityKey: null })).toBe(false);
  });
});

describe("exact canonical cache precedence", () => {
  it("reuses a currently compiled canonical artifact with verifiable outputs", () => {
    expect(humanWorkflowExactCacheUsable({
      workflow: {
        outputSchema: {
          required: ["rustdeskReady"],
          properties: {
            rustdeskReady: { type: "boolean" },
          },
        },
        postconditionContract: {
          version: "1",
          all: [{
            left: { path: "outputs.rustdeskReady" },
            operator: "truthy",
          }],
        },
      },
      sourceMetadata: {},
    } as any, "current-control-plane")).toBe(true);
  });

  it("does not bypass capability discovery for an unverifiable legacy artifact", () => {
    expect(humanWorkflowExactCacheUsable({
      workflow: {},
      sourceMetadata: {},
    } as any, "current-control-plane")).toBe(false);
  });
});
