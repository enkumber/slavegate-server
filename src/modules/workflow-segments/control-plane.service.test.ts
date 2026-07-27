import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowSegmentControlPlaneService } from "./control-plane.service";

describe("workflow segment control plane", () => {
  it("resolves version lifecycles exclusively through the configured resource binding", () => {
    const controlPlaneSource = readFileSync(
      join(__dirname, "control-plane.service.ts"),
      "utf8",
    );
    const segmentBuilderSource = readFileSync(
      join(__dirname, "../segment-builder/segment-build-job.service.ts"),
      "utf8",
    );

    expect(controlPlaneSource).not.toContain("resource.lifecycle_key");
    expect(segmentBuilderSource).not.toContain("resource.lifecycle_key");
    expect(controlPlaneSource).toContain("transition.lifecycle_key = binding.lifecycle_key");
    expect(controlPlaneSource).toContain("definition.lifecycle_key = binding.lifecycle_key");
    expect(segmentBuilderSource).toContain("definition.lifecycle_key = binding.lifecycle_key");
  });

  it("rejects canary evidence that does not prove the runtime postcondition", async () => {
    const service = new WorkflowSegmentControlPlaneService();
    await expect(service.recordCanary(
      "segment",
      "parameterized_navigation",
      "1.0.0",
      { passed: true, executionKey: "a".repeat(24) },
    )).rejects.toMatchObject({ code: "CONTROL_PLANE_CANARY_EVIDENCE_INVALID" });
  });

  it("rejects a composition resolver that cannot produce every required input before touching PostgreSQL", async () => {
    const service = new WorkflowSegmentControlPlaneService();
    await expect(service.createCompositionVersion({
      compositionName: "navigate_destination",
      version: "1.0.0",
      capabilityKey: "navigate_destination",
      platform: "android",
      inputSchema: {
        type: "object",
        required: ["destination"],
        properties: { destination: { type: "string", format: "uri" } },
        additionalProperties: false,
      },
      outputSchema: {
        required: ["observedDestination"],
        properties: { observedDestination: { type: "string" } },
      },
      inputResolver: { version: "1", fields: {} },
      postconditionContract: {
        version: "1",
        all: [{
          left: { path: "outputs.observedDestination" },
          operator: "uri_equivalent",
          right: { path: "inputs.destination" },
        }],
      },
      executionPolicy: {
        defaultVerificationStrategy: "local_only",
        dataRetentionDays: 1,
        runtimeContract: "edge-workflow/v2",
      },
      nodes: [{
        nodeKey: "navigate",
        ordinal: 0,
        segmentKey: "parameterized_navigation",
        segmentVersion: "1.0.0",
        inputBindings: { destination: "destination" },
        outputBindings: {},
        dependsOn: [],
      }],
    })).rejects.toMatchObject({ code: "COMPOSITION_INPUT_RESOLVER_INVALID" });
  });
});
