/**
 * prompt-builder.test.ts
 * Unit tests for LLM prompt generation from app maps.
 * Story: US-WORKFLOW-COMPILER, Task T8
 */

import { describe, it, expect } from "vitest";
import { buildCompilePrompt } from "../prompt-builder";
import type { AppMap, PageDef, ElementDef } from "../../app-mapping/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

function makeElement(overrides: Partial<ElementDef> = {}): ElementDef {
  return {
    type: "button",
    bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    resourceId: "com.test:id/btn",
    text: "Button",
    contentDescription: "",
    clickable: true,
    leadsTo: null,
    ...overrides,
  };
}

function makeAppMap(overrides: Partial<AppMap> = {}): AppMap {
  return {
    appId: "com.reddit.frontpage",
    appName: "Reddit",
    version: "2.1.0",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    pageCount: 2,
    transitionCount: 1,
    pages: {
      page_home: {
        name: "Home Feed",
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:com.reddit:id/home"],
          signatureHash: "hash_home_abc",
        },
        elements: {
          fab_post: makeElement({
            type: "fab",
            resourceId: "com.reddit:id/fab",
            text: "",
            leadsTo: "page_create_post",
          }),
          nav_search: makeElement({
            type: "tab",
            resourceId: "com.reddit:id/search_tab",
            text: "Search",
            leadsTo: "page_search",
          }),
        },
        discoveryOrder: 0,
      },
      page_create_post: {
        name: "Create Post",
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:com.reddit:id/create_post_root"],
          signatureHash: "hash_create_def",
        },
        elements: {
          title_input: makeElement({
            type: "input",
            resourceId: "com.reddit:id/title",
            text: "",
            leadsTo: "self",
          }),
          body_input: makeElement({
            type: "input",
            resourceId: "com.reddit:id/body",
            text: "",
            leadsTo: "self",
          }),
          submit_btn: makeElement({
            type: "button",
            resourceId: "com.reddit:id/submit",
            text: "Post",
            leadsTo: "page_home",
          }),
        },
        discoveryOrder: 1,
      },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildCompilePrompt", () => {
  // ── Prompt contains all pages ────────────────────────────────────────────

  describe("app map with pages and elements", () => {
    it("should include all page IDs in the prompt", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something on Reddit");

      expect(prompt).toContain("page_home");
      expect(prompt).toContain("page_create_post");
    });

    it("should include page names", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something");

      expect(prompt).toContain("Home Feed");
      expect(prompt).toContain("Create Post");
    });

    it("should include element IDs from each page", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something");

      expect(prompt).toContain("fab_post");
      expect(prompt).toContain("nav_search");
      expect(prompt).toContain("title_input");
      expect(prompt).toContain("body_input");
      expect(prompt).toContain("submit_btn");
    });

    it("should include element resource IDs", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something");

      expect(prompt).toContain("com.reddit:id/fab");
      expect(prompt).toContain("com.reddit:id/submit");
    });

    it("should include page signature hashes", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something");

      expect(prompt).toContain("hash_home_abc");
      expect(prompt).toContain("hash_create_def");
    });

    it("should include transitions between pages", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something");

      // The transitions section should show fab_post → page_create_post
      expect(prompt).toContain("fab_post");
      expect(prompt).toContain("page_create_post");
    });

    it("should include app metadata (appId, version)", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Post something");

      expect(prompt).toContain("com.reddit.frontpage");
      expect(prompt).toContain("2.1.0");
    });
  });

  // ── Empty app map ────────────────────────────────────────────────────────

  describe("empty app map", () => {
    it("should handle app map with no pages gracefully", () => {
      const appMap = makeAppMap({ pages: {}, pageCount: 0, transitionCount: 0 });
      const prompt = buildCompilePrompt(appMap, "Do something");

      expect(prompt).toContain("Do something");
      expect(prompt).toContain("com.reddit.frontpage");
      // Should not crash, prompt should still have the structure
      expect(prompt).toContain("APP MAP");
      expect(prompt).toContain("AVAILABLE ACTIONS");
      expect(prompt).toContain("OUTPUT FORMAT");
    });

    it("should handle app map with pages but no elements", () => {
      const appMap = makeAppMap({
        pages: {
          page_empty: {
            name: "Empty Page",
            detection: {
              method: "ui_tree_signature",
              anchors: [],
              signatureHash: "no_elements_hash",
            },
            elements: {},
            discoveryOrder: 0,
          },
        },
        pageCount: 1,
        transitionCount: 0,
      });
      const prompt = buildCompilePrompt(appMap, "Do something");

      expect(prompt).toContain("page_empty");
      expect(prompt).toContain("no elements");
    });
  });

  // ── Instruction included ─────────────────────────────────────────────────

  describe("instruction in prompt", () => {
    it("should include the NL instruction at the end of the prompt", () => {
      const appMap = makeAppMap();
      const instruction = "Post on Reddit in r/technology title 'AI breakthrough' text 'New model'";
      const prompt = buildCompilePrompt(appMap, instruction);

      expect(prompt).toContain(instruction);
    });

    it("should place instruction under the INSTRUCTION header", () => {
      const appMap = makeAppMap();
      const instruction = "Like the first post on home feed";
      const prompt = buildCompilePrompt(appMap, instruction);

      const instructionIdx = prompt.lastIndexOf(instruction);
      const headerIdx = prompt.lastIndexOf("## INSTRUCTION");
      expect(instructionIdx).toBeGreaterThan(headerIdx);
    });
  });

  // ── Prompt structure ─────────────────────────────────────────────────────

  describe("prompt structure", () => {
    it("should include all required sections", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Test");

      expect(prompt).toContain("You are a workflow compiler");
      expect(prompt).toContain("## APP MAP — PAGES & ELEMENTS");
      expect(prompt).toContain("## APP MAP — PAGE TRANSITIONS");
      expect(prompt).toContain("## AVAILABLE ACTIONS");
      expect(prompt).toContain("## OUTPUT FORMAT");
      expect(prompt).toContain("## RULES");
      expect(prompt).toContain("## INSTRUCTION");
    });

    it("should list all available actions", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Test");

      for (const action of ["tap", "type", "swipe", "press_key", "wait", "open_app", "screenshot"]) {
        expect(prompt).toContain(`- ${action}:`);
      }
    });

    it("should include JSON output format specification", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Test");

      expect(prompt).toContain('"steps"');
      expect(prompt).toContain('"expectedPage"');
      expect(prompt).toContain('"expectedPageHash"');
    });

    it("should respect maxPages option to limit pages", () => {
      // Create app map with many pages
      const pages: Record<string, PageDef> = {};
      for (let i = 0; i < 10; i++) {
        pages[`page_${i}`] = {
          name: `Page ${i}`,
          detection: {
            method: "ui_tree_signature",
            anchors: [],
            signatureHash: `hash_${i}`,
          },
          elements: {},
          discoveryOrder: i,
        };
      }
      const appMap = makeAppMap({ pages, pageCount: 10, transitionCount: 0 });
      const prompt = buildCompilePrompt(appMap, "Test", { maxPages: 3 });

      // First 3 pages should be present
      expect(prompt).toContain("page_0");
      expect(prompt).toContain("page_1");
      expect(prompt).toContain("page_2");
      // Remaining should be omitted
      expect(prompt).toContain("7 more pages omitted");
    });

    it("should include verbose element details when verbose option is true", () => {
      const appMap = makeAppMap();
      const prompt = buildCompilePrompt(appMap, "Test", { verbose: true });

      // Verbose mode includes bounds and clickable
      expect(prompt).toContain("clickable");
      expect(prompt).toContain("bounds=");
    });
  });
});
