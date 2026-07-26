import { describe, expect, it } from "vitest";
import {
  buildWorkflowDefinitionResolution,
  type WorkflowDefinition,
} from "./workflow-definition-registry";
import type { CompilerPolicyGate } from "../compiler-policy-gates/compiler-policy-gates";

function definition(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    key: "device_unlock",
    version: 1,
    status: "active",
    statusCapabilities: {
      initial: false,
      terminal: false,
      retryable: false,
      administrative: false,
      dispatchable: true,
      manual: false,
    },
    statusTransitions: [],
    title: "Unlock device",
    description: "Bring an approved Android device to an unlocked ready state.",
    platform: "android",
    intent: "device_unlock",
    goal: "Wake and unlock a device when policy and device state allow it.",
    source: "test",
    parentDefinitionId: null,
    versionNote: null,
    definition: {},
    successCriteria: [],
    allowedTools: ["screen_wake", "unlock", "get_screen_state"],
    requiredCapabilities: ["device.online_or_approved", "unlock.capability_available"],
    constraints: [],
    fallbackRules: [],
    rollback: {},
    policy: {
      reusable: true,
      compilerVisible: true,
      autoUseEnabled: true,
      requireScopeMatch: true,
      requiredGateIds: [
        "compiler_knowledge_application",
        "limited_reuse_scope_match",
        "compiler_auto_use",
        "execution_path_change",
      ],
      allowedStatuses: ["active"],
      allowedPromotionStates: ["limited_reuse"],
      minimumPromotionConfidence: 0.6,
      resolutionScoring: {
        exactKey: 100,
        exactIntent: 50,
        platform: 10,
        termMatch: 12,
        statusScores: { active: 10, draft: 2 },
      },
    },
    promotion: {
      state: "limited_reuse",
      stateCapabilities: {
        initial: false,
        terminal: false,
        retryable: false,
        administrative: false,
        dispatchable: true,
        manual: false,
      },
      scope: "auto_use:test:android:device_unlock:v1",
      note: null,
      promotedBy: "test",
      promotedAt: "2026-07-15T00:00:00.000Z",
      revokedBy: null,
      revokedAt: null,
      confidence: 0.85,
      readiness: { state: "auto_use_bootstrap_ready", safeToAutoApply: true },
      scopeDetails: {},
      rollbackDefinitionId: null,
      rollbackPreview: {},
      reusable: true,
      compilerEligible: true,
      wouldUseDefinition: true,
      autoUseEnabled: true,
      transitions: [],
    },
    telemetrySummary: {},
    confidenceDecay: {},
    promotionHardening: {},
    summary: {
      successCriteria: 0,
      allowedTools: 3,
      requiredCapabilities: 2,
      constraints: 0,
      fallbackRules: 0,
    },
    createdBy: "test",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function enabledGate(id: string): CompilerPolicyGate {
  return {
    id,
    title: id,
    category: "auto_use",
    state: "enabled",
    stateCapabilities: {
      initial: false,
      terminal: false,
      retryable: false,
      administrative: false,
      dispatchable: true,
      manual: false,
    },
    risk: "high",
    owner: "product",
    blocks: [],
    requiredEvidence: [],
    requiredPolicyChanges: [],
    config: {},
    remediation: { state: "manual_review_required", nextActions: [], safeToAutoApply: true },
    guardrails: [],
    notes: [],
    version: 1,
    updatedBy: "test",
    updatedAt: null,
  };
}

const gates = [
  enabledGate("compiler_knowledge_application"),
  enabledGate("limited_reuse_scope_match"),
  enabledGate("compiler_auto_use"),
  enabledGate("execution_path_change"),
];

describe("buildWorkflowDefinitionResolution", () => {
  it("does not select device unlock for a Gmail goal just because unlock is active", () => {
    const result = buildWorkflowDefinitionResolution({
      goal: "gmail_open_inbox",
      definitions: [
        definition({}),
        definition({
          id: "22222222-2222-4222-8222-222222222222",
          key: "gmail_open_inbox",
          status: "draft",
          title: "Open Gmail inbox",
          platform: "gmail",
          intent: "gmail_open_inbox",
          goal: "Open Gmail and verify the inbox.",
          promotion: {
            ...definition({}).promotion,
            state: "review_only",
            scope: null,
            confidence: 0,
            readiness: {},
            reusable: false,
            compilerEligible: false,
            wouldUseDefinition: false,
            autoUseEnabled: false,
          },
        }),
      ],
      policyGates: gates,
    }) as Record<string, any>;

    expect(result.candidateDefinition.key).toBe("gmail_open_inbox");
    expect(result.outcome).toBe("blocked_by_policy");
    expect(result.wouldExecuteWorkflow).toBe(false);
    expect(result.blockers).toContain("workflow_definition_status_not_allowed");
  });

  it("keeps the scoped device unlock definition executable for unlock goals", () => {
    const result = buildWorkflowDefinitionResolution({
      goal: "unlock device",
      requestedScope: "auto_use:test:android:device_unlock:v1",
      definitions: [definition({})],
      policyGates: gates,
    }) as Record<string, any>;

    expect(result.candidateDefinition.key).toBe("device_unlock");
    expect(result.outcome).toBe("auto_use_execution_allowed");
    expect(result.wouldUseDefinition).toBe(true);
    expect(result.wouldExecuteWorkflow).toBe(true);
  });
});
