import { describe, expect, it } from "vitest";
import type { AppMap } from "../app-mapping/schema";
import { projectLegacyAppMap } from "./legacy-adapter";

describe("projectLegacyAppMap state detection", () => {
  it("preserves DB-profile optional and forbidden anchors", () => {
    const map: AppMap = {
      appId: "com.example.app",
      appName: "Example",
      version: "runtime-profile-2",
      appVersion: "1.0",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      pageCount: 1,
      transitionCount: 0,
      pages: {
        search_entry: {
          name: "Search entry",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            signatureHash: "abc",
            anchors: ["resourceId:toolbar"],
            optionalAnchors: ["contentDescription:Search"],
            forbiddenAnchors: ["resourceId:search_results"],
          },
          elements: {},
        },
      },
    };
    const variant = projectLegacyAppMap(map).states[0].variants[0];
    expect(variant.requiredAnchors).toEqual(["resourceId:toolbar"]);
    expect(variant.optionalAnchors).toEqual(["contentDescription:Search"]);
    expect(variant.forbiddenAnchors).toEqual(["resourceId:search_results"]);
  });
});
