import { describe, expect, it } from "vitest";
import { humanWorkflowArtifactMatchesIntent } from "./human-workflow-compiler.service";

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
