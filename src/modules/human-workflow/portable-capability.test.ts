import { describe, expect, it } from "vitest";
import type { GeneratedWorkflowPlanCacheRecord } from "../workflows/workflow.service";
import type { WorkflowTemplate } from "../workflows/types";
import { compileGeneratedWorkflowTemplate } from "../workflows/workflow-validator";
import {
  derivePortableCapabilityKey,
  portableCapabilityMetadata,
  resolvePortableCapabilityArtifact,
} from "./portable-capability";

function artifact(overrides: Partial<GeneratedWorkflowPlanCacheRecord> = {}): GeneratedWorkflowPlanCacheRecord {
  const workflow: WorkflowTemplate = {
    id: "remote_support_enable_screen_sharing_trace_v1",
    name: "Enable remote support screen sharing from verified UI trace",
    description: "Use accessibility navigation and verify the final ready state.",
    version: "1.0.0",
    platform: "android",
    safetyClass: "standard",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
    steps: [
      { id: "open_drawer", type: "action", action: "press_key", params: { key: "APP_DRAWER" } },
      { id: "verify_ready", type: "checkpoint", reason: "Ready state verified" },
    ],
  };
  return {
    cacheKey: "a".repeat(24),
    requestKey: "b".repeat(24),
    canonicalWorkflowId: workflow.id,
    canonicalWorkflowVersion: workflow.version,
    compiledPlanHash: "c".repeat(64),
    artifactState: "promoted",
    sourceMetadata: { safetyClass: "standard" },
    templateId: workflow.id,
    platform: workflow.platform,
    templateVersion: workflow.version,
    workflow,
    compiledPlan: compileGeneratedWorkflowTemplate(workflow),
    hitCount: 1,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

describe("portable workflow capability identity", () => {
  it("keeps workflow-derived keys lexical and does not encode domain aliases", () => {
    expect(derivePortableCapabilityKey({
      id: "remote_support_enable_screen_sharing_trace_v1",
      name: "ignored",
    })).toBe("remote_support_enable_screen_sharing_trace");
  });

  it("does not invent a capability identity when PostgreSQL did not provide one", () => {
    const record = artifact();
    expect(portableCapabilityMetadata(record.workflow, record.sourceMetadata)).toEqual({
      portable: true,
      portabilityScope: "global",
    });
  });

  it("resolves a promoted workflow across device/formulation boundaries before LLM", () => {
    const record = artifact({
      sourceMetadata: {
        capabilityKey: "remote_support_enable_screen_share",
        safetyClass: "standard",
        portable: true,
        portabilityScope: "global",
      },
    });
    const match = resolvePortableCapabilityArtifact(
      "pornește remote support screen share",
      "android",
      [record],
    );
    expect(match?.record.cacheKey).toBe(record.cacheKey);
    expect(match?.capabilityKey).toBe("remote_support_enable_screen_share");
    expect(match?.score).toBeGreaterThanOrEqual(0.62);
  });

  it("refuses legacy semantic fallback when the catalog identity is absent", () => {
    const recorded = artifact({
      workflow: {
        ...artifact().workflow,
        id: "rustdesk_enable_screen_sharing_trace_v1",
        name: "Enable RustDesk screen sharing from verified UI trace",
        description: "Verified launcher and accessibility trace with Ready final state.",
      },
      sourceMetadata: {
        intent: null,
        safetyClass: "standard",
      },
    });
    const match = resolvePortableCapabilityArtifact(
      "pornește screen share RustDesk pe telefon",
      "android",
      [recorded],
    );
    expect(match).toBeNull();
  });

  it("fails closed when two capabilities are semantically ambiguous", () => {
    const first = artifact({
      cacheKey: "d".repeat(24),
      sourceMetadata: { capabilityKey: "remote_support_enable_screen_share", portable: true },
    });
    const second = artifact({
      cacheKey: "e".repeat(24),
      sourceMetadata: { capabilityKey: "remote_support_start_screen_share", portable: true },
      workflow: { ...artifact().workflow, id: "remote_support_start_screen_share_v1" },
    });
    expect(resolvePortableCapabilityArtifact(
      "remote support screen share",
      "android",
      [first, second],
    )).toBeNull();
  });

  it("rejects device/account-bound artifacts", () => {
    const bound = artifact({
      sourceMetadata: {
        capabilityKey: "remote_support_enable_screen_share",
        portabilityScope: "device",
      },
    });
    expect(resolvePortableCapabilityArtifact(
      "enable remote support screen share",
      "android",
      [bound],
    )).toBeNull();
  });
});
