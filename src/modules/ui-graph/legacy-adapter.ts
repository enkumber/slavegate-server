import type { AppMap } from "../app-mapping/schema";
import type { UiSelectorDefinition, UiStateDefinition, UiTransitionDefinition } from "./types";

export interface LegacyGraphProjection {
  states: UiStateDefinition[];
  selectors: UiSelectorDefinition[];
  transitions: UiTransitionDefinition[];
}

function stateId(appId: string, pageId: string): string {
  return `legacy:${appId}:${pageId}`;
}

export function projectLegacyAppMap(map: AppMap): LegacyGraphProjection {
  const states: UiStateDefinition[] = [];
  const selectors: UiSelectorDefinition[] = [];
  const transitions: UiTransitionDefinition[] = [];

  for (const [pageId, page] of Object.entries(map.pages)) {
    const projectedStateId = stateId(map.appId, pageId);
    states.push({
      id: projectedStateId,
      appId: map.appId,
      key: pageId,
      name: page.name,
      kind: "screen",
      safetyClass: "navigation",
      variants: [{
        id: `${projectedStateId}:default`,
        key: "default",
        signatureHash: page.detection.signatureHash,
        requiredAnchors: page.detection.anchors,
        optionalAnchors: page.detection.optionalAnchors ?? [],
        forbiddenAnchors: page.detection.forbiddenAnchors ?? [],
        appVersionPattern: map.appVersion ? `^${map.appVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : null,
        confidenceThreshold: 0.72,
      }],
    });

    for (const [elementId, element] of Object.entries(page.elements)) {
      const base = {
        stateId: projectedStateId,
        elementKey: elementId,
        priority: 100,
        dynamic: false,
        confidence: 0.9,
        status: "promoted" as const,
        variantId: `${projectedStateId}:default`,
      };
      if (element.resourceId) selectors.push({ ...base, id: `${projectedStateId}:${elementId}:rid`, strategy: "resource_id", value: element.resourceId, priority: 10 });
      if (element.contentDescription) selectors.push({ ...base, id: `${projectedStateId}:${elementId}:cd`, strategy: "content_description", value: element.contentDescription, priority: 20 });
      if (element.semanticId) selectors.push({ ...base, id: `${projectedStateId}:${elementId}:semantic`, strategy: "semantic_id", value: element.semanticId, priority: 30 });
      if (element.text) selectors.push({ ...base, id: `${projectedStateId}:${elementId}:text`, strategy: "text", value: element.text, priority: 40 });
      if (element.bounds && element.leadsTo !== null) {
        selectors.push({
          ...base,
          id: `${projectedStateId}:${elementId}:coords`,
          strategy: "normalized_coords",
          coords: { x: element.bounds.x + element.bounds.w / 2, y: element.bounds.y + element.bounds.h / 2 },
          priority: 1000,
          confidence: 0.75,
          appVersionPattern: map.appVersion ? `^${map.appVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : null,
        });
      }
      if (element.leadsTo && element.leadsTo !== "self" && map.pages[element.leadsTo]) {
        transitions.push({
          id: `${projectedStateId}:${elementId}:${element.leadsTo}`,
          key: `${pageId}.${elementId}->${element.leadsTo}`,
          appId: map.appId,
          sourceStateId: projectedStateId,
          targetStateId: stateId(map.appId, element.leadsTo),
          elementKey: elementId,
          action: { type: "tap", elementKey: elementId },
          cost: 1,
          safetyClass: "navigation",
          confidence: 0.85,
          status: "promoted",
        });
      }
    }
  }
  return { states, selectors, transitions };
}
