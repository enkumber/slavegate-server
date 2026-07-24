import { describe, expect, it } from "vitest";
import type { GeneratedWorkflowPlanCacheRecord } from "../workflows/workflow.service";
import type { WorkflowTemplate } from "../workflows/types";
import { compileGeneratedWorkflowTemplate } from "../workflows/workflow-validator";
import {
  portableCapabilityMetadata,
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
  it("does not invent a capability identity when PostgreSQL did not provide one", () => {
    const record = artifact();
    expect(portableCapabilityMetadata(record.workflow, record.sourceMetadata)).toEqual({
      portable: false,
      portabilityScope: "contextual",
    });
  });

  it("preserves only an explicit valid PostgreSQL capability identity", () => {
    const record = artifact({
      sourceMetadata: {
        capabilityKey: "remote_support_enable_screen_share",
        safetyClass: "standard",
        portable: true,
        portabilityScope: "global",
      },
    });
    expect(portableCapabilityMetadata(record.workflow, record.sourceMetadata)).toEqual({
      capabilityKey: "remote_support_enable_screen_share",
      portable: true,
      portabilityScope: "global",
    });
  });

  it("rejects malformed explicit capability identities instead of normalizing them", () => {
    const record = artifact({
      sourceMetadata: {
        capabilityKey: "Remote Support / Screen Share",
        portable: true,
        portabilityScope: "global",
      },
    });
    expect(portableCapabilityMetadata(record.workflow, record.sourceMetadata)).toEqual({
      portable: true,
      portabilityScope: "global",
    });
  });

  it("rejects device/account-bound artifacts", () => {
    const bound = artifact({
      sourceMetadata: {
        capabilityKey: "remote_support_enable_screen_share",
        portabilityScope: "device",
      },
    });
    expect(portableCapabilityMetadata(bound.workflow, bound.sourceMetadata)).toEqual({
      capabilityKey: "remote_support_enable_screen_share",
      portable: false,
      portabilityScope: "contextual",
    });
  });
});
