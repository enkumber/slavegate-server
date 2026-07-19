import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../workflows/types";
import {
  composeWorkflowWithSegments,
  extractReusableWorkflowSegments,
  rankWorkflowSegments,
  type WorkflowSegment,
} from "./workflow-segment-library.service";

function workflow(steps: WorkflowTemplate["steps"]): WorkflowTemplate {
  return {
    id: "workflow-a",
    name: "Workflow A",
    platform: "reddit",
    description: "Navigate to AskReddit and inspect the feed",
    version: "1.0.0",
    safetyClass: "read_only",
    steps,
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
  };
}

function stored(overrides: Partial<WorkflowSegment>): WorkflowSegment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    fingerprint: "fingerprint",
    category: "system/android",
    packageName: null,
    placement: "prefix",
    semanticTokens: [],
    steps: [{ id: "wake", type: "action", action: "screen_wake", params: {} }],
    sourceCacheKey: "cache-a",
    sourceWorkflowId: "workflow-a",
    sourceWorkflowVersion: "1.0.0",
    sourceIntent: "wake device",
    successCount: 2,
    ...overrides,
  };
}

describe("workflow segment library", () => {
  it("extracts Android system navigation separately from package-scoped app navigation", () => {
    const segments = extractReusableWorkflowSegments({
      workflow: workflow([
        { id: "wake", type: "action", action: "screen_wake", params: {} },
        { id: "unlock", type: "action", action: "unlock", params: {} },
        {
          id: "open_askreddit",
          type: "action",
          action: "intent_send",
          params: { packageName: "com.reddit.frontpage", uri: "https://reddit.com/r/AskReddit" },
        },
        { id: "idle", type: "action", action: "wait_for_idle", params: {} },
        { id: "done", type: "checkpoint", reason: "AskReddit visible" },
      ]),
      packageName: "com.reddit.frontpage",
      intent: "Open AskReddit and inspect the feed",
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ category: "system/android", packageName: null, placement: "prefix" });
    expect(segments[0].steps.map((step) => step.id)).toEqual(["wake", "unlock"]);
    expect(segments[1]).toMatchObject({ category: "app/com.reddit.frontpage", packageName: "com.reddit.frontpage" });
    expect(segments[1].semanticTokens).toEqual(expect.arrayContaining(["reddit", "askreddit"]));
  });

  it("does not promote mutating app actions into an automatically reusable segment", () => {
    const segments = extractReusableWorkflowSegments({
      workflow: workflow([
        { id: "open", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
        { id: "comment", type: "action", action: "semantic_tap", params: { target: "reddit.post.submit_comment" } },
        { id: "type", type: "action", action: "type_text", params: { text: "hello" } },
      ]),
      packageName: "com.reddit.frontpage",
      intent: "Post a comment on Reddit",
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].steps.map((step) => step.id)).toEqual(["open"]);
  });

  it("categorizes Settings navigation as system/android without admitting raw coordinate taps", () => {
    const segments = extractReusableWorkflowSegments({
      workflow: workflow([
        { id: "settings", type: "action", action: "open_app", params: { packageName: "com.android.settings" } },
        { id: "network", type: "action", action: "semantic_tap", params: { packageName: "com.android.settings", target: "Network & internet" } },
        { id: "unsafe_raw_tap", type: "action", action: "tap", x: 400, y: 700 },
      ]),
      packageName: "com.android.settings",
      intent: "Open Android network settings",
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ category: "system/android", packageName: null, placement: "prefix" });
    expect(segments[0].steps.map((step) => step.id)).toEqual(["settings", "network"]);
  });

  it("does not create a reusable segment from a detached wait", () => {
    const segments = extractReusableWorkflowSegments({
      workflow: workflow([
        { id: "comment", type: "action", action: "type_text", params: { text: "hello" } },
        { id: "idle", type: "wait", duration: { min: 100, max: 200, distribution: "uniform" } },
      ]),
      packageName: "com.reddit.frontpage",
      intent: "Write a comment",
    });

    expect(segments).toEqual([]);
  });

  it("ranks a package segment by intent while always keeping the Android system segment eligible", () => {
    const ranked = rankWorkflowSegments([
      stored({ id: "system", category: "system/android", semanticTokens: ["wake"] }),
      stored({
        id: "reddit-ask",
        category: "app/com.reddit.frontpage",
        packageName: "com.reddit.frontpage",
        semanticTokens: ["reddit", "askreddit", "feed"],
      }),
      stored({
        id: "reddit-profile",
        category: "app/com.reddit.frontpage",
        packageName: "com.reddit.frontpage",
        semanticTokens: ["reddit", "profile"],
      }),
    ], "Open AskReddit feed then inspect a post");

    expect(ranked.map((segment) => segment.id)).toEqual(["system", "reddit-ask"]);
  });

  it("composes reusable A segments into B and removes steps the LLM repeated", () => {
    const system = stored({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      category: "system/android",
      steps: [
        { id: "wake-a", type: "action", action: "screen_wake", params: {} },
        { id: "unlock-a", type: "action", action: "unlock", params: {} },
      ],
    });
    const app = stored({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      category: "app/com.reddit.frontpage",
      packageName: "com.reddit.frontpage",
      placement: "body",
      steps: [{
        id: "askreddit-a",
        type: "action",
        action: "intent_send",
        params: { packageName: "com.reddit.frontpage", uri: "https://reddit.com/r/AskReddit" },
      }],
    });
    const composed = composeWorkflowWithSegments([
      { id: "wake-llm", type: "action", action: "screen_wake", params: {} },
      { id: "inspect-b", type: "action", action: "ui_tree_dump", params: { outputVariable: "_finalUiTree" } },
      { id: "done-b", type: "checkpoint", reason: "post inspected" },
    ], [system, app]);

    expect(composed.map((step) => step.type === "action" ? step.action : step.type)).toEqual([
      "screen_wake", "unlock", "intent_send", "ui_tree_dump", "checkpoint",
    ]);
    expect(composed[0].id).toContain("reuse_aaaaaaaa");
  });
});
