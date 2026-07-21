/**
 * workflow-validator.test.ts
 * Unit tests for workflow validation against app maps.
 * Story: US-WORKFLOW-COMPILER, Task T8
 */

import { describe, it, expect } from "vitest";
import { validateCompiledWorkflow } from "../workflow-validator";
import type { CompiledWorkflow, CompiledStep } from "../types";
import type { AppMap, PageDef, ElementDef } from "../../app-mapping/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

function makeElement(overrides: Partial<ElementDef> = {}): ElementDef {
  return {
    type: "button",
    bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    resourceId: "",
    text: "",
    contentDescription: "",
    clickable: true,
    leadsTo: null,
    ...overrides,
  };
}

function makePage(overrides: Partial<PageDef> = {}): PageDef {
  return {
    name: "Test Page",
    detection: {
      method: "ui_tree_signature",
      anchors: ["resourceId:com.app:id/root"],
      signatureHash: "abc123hash",
    },
    elements: {},
    discoveryOrder: 0,
    ...overrides,
  };
}

function makeAppMap(overrides: Partial<AppMap> = {}): AppMap {
  return {
    appId: "com.test.app",
    appName: "TestApp",
    version: "1.0.0",
    pages: {
      page_home: makePage({ name: "Home" }),
      page_detail: makePage({ name: "Detail" }),
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    pageCount: 2,
    transitionCount: 1,
    ...overrides,
  };
}

function makeStep(overrides: Partial<CompiledStep> = {}): CompiledStep {
  return {
    id: "s1",
    action: "tap",
    target: {
      elementId: "btn_submit",
      coords: { x: 0.5, y: 0.5 },
    },
    expectedPage: "page_home",
    expectedPageHash: "abc123hash",
    retries: 1,
    retryDelay: 500,
    description: "Tap submit button",
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<CompiledWorkflow> = {}): CompiledWorkflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    source: "Do something",
    appId: "com.test.app",
    compiledAt: "2026-01-01T00:00:00Z",
    steps: [makeStep()],
    appMapVersion: "1.0.0",
    startPage: "page_home",
    maxRecoveryAttempts: 1,
    maxTotalRecoveryAttempts: 10,
    recoveryModel: "openai-codex/gpt-5.5",
    ...overrides,
  };
}

/** Build a valid app map with two pages and a transition */
function validAppMap(): AppMap {
  return makeAppMap({
    pages: {
      page_home: makePage({
        name: "Home",
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:com.test:id/home_root"],
          signatureHash: "abc123hash",
        },
        discoveryOrder: 0,
        elements: {
          btn_submit: makeElement({
            type: "button",
            resourceId: "com.test:id/submit",
            text: "Submit",
            clickable: true,
            leadsTo: "page_details",
          }),
        },
      }),
      page_details: makePage({
        name: "Details",
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:com.test:id/details_root"],
          signatureHash: "def456hash",
        },
        discoveryOrder: 1,
        elements: {
          input_field: makeElement({
            type: "input",
            resourceId: "com.test:id/input",
            text: "",
            clickable: true,
            leadsTo: "self",
          }),
        },
      }),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateCompiledWorkflow", () => {
  // ── Valid workflow passes ────────────────────────────────────────────────

  describe("valid workflow", () => {
    it("should pass for a well-formed workflow matching the app map", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            id: "s1",
            action: "tap",
            target: { elementId: "btn_submit" },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass for workflow with multiple valid steps", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            id: "s1",
            action: "tap",
            target: { elementId: "btn_submit" },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
            description: "Tap submit",
          }),
          makeStep({
            id: "s2",
            action: "type",
            params: { text: "hello" },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
            description: "Type text",
          }),
          makeStep({
            id: "s3",
            action: "open_app",
            params: { packageName: "com.test.app" },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
            description: "Open app",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── Missing pages → errors ──────────────────────────────────────────────

  describe("missing pages", () => {
    it("should error when expectedPage does not exist in app map", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            expectedPage: "page_nonexistent",
            expectedPageHash: "xyz",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`expectedPage "page_nonexistent" does not exist`),
        ]),
      );
    });

    it("should error when startPage does not exist in app map", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({ startPage: "page_ghost" });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`Start page "page_ghost" does not exist`)]),
      );
    });

    it("should error when workflow has no steps", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({ steps: [] });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("no steps")]),
      );
    });
  });

  // ── Invalid actions → errors ────────────────────────────────────────────

  describe("invalid actions", () => {
    it("accepts readiness actions without targets or params", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({ action: "screen_wake", target: undefined, params: {}, expectedPage: "", expectedPageHash: "" }),
          makeStep({ action: "unlock", target: undefined, params: {}, expectedPage: "", expectedPageHash: "" }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.errors.filter((error) => error.includes("Invalid action"))).toEqual([]);
    });

    it("should error for unrecognized action type", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "teleport" as any,
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`Invalid action "teleport"`)]),
      );
    });

    it("should error when tap action has no target", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "tap",
            target: undefined,
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`requires a target`)]),
      );
    });

    it("should error for missing step action", () => {
      const appMap = validAppMap();
      const step = makeStep();
      delete (step as any).action;
      const workflow = makeWorkflow({ steps: [step] });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Missing action")]),
      );
    });
  });

  // ── Hash mismatch → warning ─────────────────────────────────────────────

  describe("hash mismatch", () => {
    it("should warn when expectedPageHash does not match page signatureHash", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            expectedPage: "page_home",
            expectedPageHash: "wrong_hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      // Should still be valid (warnings don't block)
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("expectedPageHash"),
        ]),
      );
    });

    it("should not warn when hash matches exactly", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      const hashWarnings = result.warnings.filter((w) => w.includes("expectedPageHash"));
      expect(hashWarnings).toHaveLength(0);
    });
  });

  // ── Additional validation ───────────────────────────────────────────────

  describe("additional validations", () => {
    it("should error for duplicate step IDs", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({ id: "s1", expectedPage: "page_home", expectedPageHash: "abc123hash" }),
          makeStep({ id: "s1", expectedPage: "page_home", expectedPageHash: "abc123hash" }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`Duplicate step id: "s1"`)]),
      );
    });

    it("should error when type action lacks params.text", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "type",
            params: {},
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`"type" action requires params.text`)]),
      );
    });

    it("should error when open_app action lacks params.packageName", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "open_app",
            params: {},
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`"open_app" action requires params.packageName`)]),
      );
    });

    it("should accept constrained intent_send parameters from an app runtime profile", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "intent_send",
            params: {
              uri: "https://www.reddit.com/search/?q=AskReddit",
              packageName: "com.reddit.frontpage",
              action: "android.intent.action.VIEW",
            },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(true);
    });

    it("should reject intent_send without a URI or with malformed optional constraints", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "intent_send",
            params: { uri: "", packageName: 42, action: false },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining(`"intent_send" action requires params.uri`),
        expect.stringContaining("intent_send params.packageName must be a string"),
        expect.stringContaining("intent_send params.action must be a string"),
      ]));
    });

    it("should error when target elementId does not exist in any page", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            target: { elementId: "ghost_element" },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`does not exist in any page`)]),
      );
    });

    it("should error when appId does not match", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({ appId: "com.other.app" });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("does not match app map")]),
      );
    });

    it("should warn when target has no targeting method", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            action: "tap",
            target: {},
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("no elementId, resourceId, text, or coords"),
        ]),
      );
    });

    it("should error for coords out of normalized range", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            target: { coords: { x: 1.5, y: 0.5 } },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("out of normalized range")]),
      );
    });

    it("should warn on transition mismatch (element leadsTo differs from expectedPage)", () => {
      const appMap = validAppMap();
      const workflow = makeWorkflow({
        steps: [
          makeStep({
            target: { elementId: "btn_submit" },
            expectedPage: "page_home",
            expectedPageHash: "abc123hash",
          }),
        ],
      });
      // btn_submit leadsTo "page_details", but step expects "page_home" → warning

      const result = validateCompiledWorkflow(workflow, appMap);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("leads to"),
        ]),
      );
    });
  });
});
