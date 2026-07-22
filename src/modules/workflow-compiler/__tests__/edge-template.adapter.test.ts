import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMap } from "../../app-mapping/schema";
import type { CompiledWorkflow } from "../types";

const mocks = vi.hoisted(() => ({ loadMap: vi.fn() }));

vi.mock("../../app-mapping/recorder.service", () => ({ loadMap: mocks.loadMap }));

import { compiledWorkflowToEdgeTemplate } from "../edge-template.adapter";

function map(): AppMap {
  return {
    appId: "com.example.app",
    appName: "Example",
    version: "map-v3",
    appVersion: "12.4",
    pages: {
      home: {
        name: "Home",
        discoveryOrder: 0,
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:home_toolbar"],
          forbiddenAnchors: ["text:Sign in"],
          signatureHash: "home-hash",
        },
        elements: {
          search: {
            type: "button",
            bounds: { x: 0.8, y: 0.05, w: 0.1, h: 0.1 },
            resourceId: "search_button",
            text: "",
            contentDescription: "Search",
            clickable: true,
            leadsTo: "search",
          },
        },
      },
      search: {
        name: "Search",
        discoveryOrder: 1,
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:search_field"],
          signatureHash: "search-hash",
        },
        elements: {},
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pageCount: 2,
    transitionCount: 1,
  };
}

function workflow(): CompiledWorkflow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Portable navigation",
    source: "Open search",
    appId: "com.example.app",
    compiledAt: "2026-07-22T00:00:00.000Z",
    appMapVersion: "map-v3",
    startPage: "home",
    maxRecoveryAttempts: 1,
    maxTotalRecoveryAttempts: 3,
    steps: [
      {
        id: "wake",
        action: "screen_wake",
        expectedPage: "",
        expectedPageHash: "",
        retries: 0,
        retryDelay: 0,
        description: "Wake",
      },
      {
        id: "open_search",
        action: "tap",
        target: { elementId: "search" },
        expectedPage: "search",
        expectedPageHash: "search-hash",
        retries: 2,
        retryDelay: 400,
        description: "Open search",
      },
      {
        id: "settle",
        action: "wait",
        params: { durationMs: 600 },
        expectedPage: "search",
        expectedPageHash: "search-hash",
        retries: 0,
        retryDelay: 0,
        description: "Settle",
      },
    ],
  };
}

describe("compiledWorkflowToEdgeTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMap.mockResolvedValue(map());
  });

  it("ships navigation, retry, waits and state decisions in one edge payload", async () => {
    const template = await compiledWorkflowToEdgeTemplate(workflow());

    expect(template.runtimeContract).toBe("edge-workflow/v2");
    expect(template.platform).toBe("com.example.app");
    expect(template.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "action", action: "screen_wake" }),
      expect.objectContaining({
        type: "action",
        action: "a11y_find_tap",
        params: { resourceId: "search_button" },
        retries: 2,
        retryDelayMs: 400,
      }),
      expect.objectContaining({
        type: "wait",
        until: expect.objectContaining({
          action: "ui_tree_dump",
          outputPath: "uiTree",
          operator: "contains_ci",
          expected: "search_field",
        }),
      }),
      expect.objectContaining({
        type: "wait",
        duration: { min: 600, max: 600, distribution: "uniform" },
      }),
    ]));
  });

  it("fails closed when a tap has neither selector nor normalized coordinates", async () => {
    const candidate = workflow();
    candidate.steps[1].target = { elementId: "missing" };
    await expect(compiledWorkflowToEdgeTemplate(candidate)).rejects.toThrow("no portable selector");
  });

  it("changes navigation and state verification only from App Map data", async () => {
    const first = map();
    first.pages.home.elements.search.resourceId = "";
    first.pages.home.elements.search.contentDescription = "";
    first.pages.home.elements.search.bounds = { x: 0.1, y: 0.2, w: 0.2, h: 0.2 };
    first.pages.search.detection.anchors = ["text:first_state"];

    const second = map();
    second.pages.home.elements.search.resourceId = "";
    second.pages.home.elements.search.contentDescription = "";
    second.pages.home.elements.search.bounds = { x: 0.6, y: 0.7, w: 0.2, h: 0.2 };
    second.pages.search.detection.anchors = ["text:second_state"];

    mocks.loadMap.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const before = await compiledWorkflowToEdgeTemplate(workflow());
    const after = await compiledWorkflowToEdgeTemplate(workflow());

    expect(before.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "tap", params: { x: expect.closeTo(0.2), y: expect.closeTo(0.3) } }),
      expect.objectContaining({ type: "wait", until: expect.objectContaining({ expected: "first_state" }) }),
    ]));
    expect(after.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "tap", params: { x: expect.closeTo(0.7), y: expect.closeTo(0.8) } }),
      expect.objectContaining({ type: "wait", until: expect.objectContaining({ expected: "second_state" }) }),
    ]));
  });
});
