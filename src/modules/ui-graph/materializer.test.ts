import { describe, expect, it } from "vitest";
import type { AppMap } from "../app-mapping/schema";
import type { AppRuntimeProfile } from "../app-mapping/runtime-profile";
import { materializeAppMapForMappingResponse, materializeAppMapForRuntimeProfile } from "./materializer";

describe("runtime profile UI graph materialization", () => {
  it("merges required, optional, and forbidden anchors deterministically into every state variant", () => {
    const { projection } = materializeAppMapForRuntimeProfile(appMap(), profile({
      requiredAnchors: ["text:Inbox", "resourceId:toolbar"],
      optionalAnchors: ["contentDescription:Open search"],
      forbiddenAnchors: ["resourceId:results", "resourceId:search_bar"],
    }));

    const variant = projection.states.find((state) => state.key === "search_entry")?.variants[0];
    expect(variant).toMatchObject({
      requiredAnchors: ["resourceId:toolbar", "text:Inbox"],
      optionalAnchors: ["contentDescription:Open search", "contentDescription:Search"],
      forbiddenAnchors: ["resourceId:results", "resourceId:search_bar"],
    });
  });

  it("projects the same override envelope for mapping endpoint responses without mutating the raw app map", () => {
    const raw = appMap();
    const { map, provenance } = materializeAppMapForMappingResponse(raw, profile({
      forbiddenAnchors: ["resourceId:search_bar"],
    }));

    expect(raw.pages.search_entry.detection.forbiddenAnchors).toEqual([]);
    expect(map.pages.search_entry.detection.forbiddenAnchors).toEqual(["resourceId:search_bar"]);
    expect(provenance).toMatchObject({
      appMapVersion: "map-v1",
      runtimeProfile: { version: 2, source: "postgresql" },
    });
    expect(provenance.runtimeProfile?.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});

function appMap(): AppMap {
  return {
    appId: "com.example.app",
    appName: "Example",
    version: "map-v1",
    appVersion: "1.0",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    pageCount: 1,
    transitionCount: 0,
    pages: {
      search_entry: {
        name: "Search",
        discoveryOrder: 0,
        detection: {
          method: "ui_tree_signature",
          signatureHash: "hash-search",
          anchors: ["resourceId:toolbar"],
          optionalAnchors: ["contentDescription:Search"],
          forbiddenAnchors: [],
        },
        elements: {},
      },
    },
  };
}

function profile(overrides: Record<string, string[] | undefined>): AppRuntimeProfile {
  return {
    appId: "com.example.app",
    appName: "Example",
    packageName: "com.example.app",
    profileVersion: 2,
    resetRecipe: [],
    mappingRecipe: [],
    safetyPolicy: {
      mode: "read_only_navigation",
      allowedActions: [],
    },
    metadata: {
      stateDetectionOverrides: {
        search_entry: overrides,
      },
    },
  };
}
