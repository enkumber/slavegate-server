import { describe, expect, it } from "vitest";
import {
  completedSegmentBuildCapabilityKey,
  humanWorkflowArtifactMatchesIntent,
  humanWorkflowExactCacheUsable,
} from "./human-workflow-compiler.service";

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
