import { loadMap } from "../app-mapping/recorder.service";
import type { AppMap, ElementDef, PageDef } from "../app-mapping/schema";
import type { ActionStep, WaitStep, WorkflowStep, WorkflowTemplate } from "../workflows/types";
import type { CompiledStep, CompiledWorkflow } from "./types";

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_STATE_TIMEOUT_MS = 15_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function selectorParams(step: CompiledStep, appMap: AppMap): Record<string, unknown> | null {
  const target = step.target;
  if (!target) return null;

  let element: ElementDef | undefined;
  if (target.elementId) {
    for (const page of Object.values(appMap.pages)) {
      element = page.elements[target.elementId];
      if (element) break;
    }
  }

  const resourceId = target.resourceId || element?.resourceId;
  const contentDescription = target.contentDescription || element?.contentDescription;
  const text = target.text || element?.text;
  if (resourceId) return { resourceId };
  if (contentDescription) return { contentDescription };
  if (text) return { text };

  const coords = target.coords ?? (element?.bounds
    ? { x: element.bounds.x + element.bounds.w / 2, y: element.bounds.y + element.bounds.h / 2 }
    : undefined);
  if (coords && finite(coords.x) && finite(coords.y)) return { x: coords.x, y: coords.y };
  return null;
}

function actionStep(step: CompiledStep, appMap: AppMap): ActionStep {
  const common = {
    type: "action" as const,
    id: step.id,
    retries: Math.max(0, step.retries ?? 0),
    retryDelayMs: Math.max(0, step.retryDelay ?? 0),
    verification: "local_only" as const,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    failureMode: "abort" as const,
  };

  switch (step.action) {
    case "screen_wake":
    case "unlock":
    case "open_app":
    case "intent_send":
    case "press_key":
    case "swipe":
    case "screenshot":
      return { ...common, action: step.action, params: { ...(step.params ?? {}) } };
    case "type":
      return { ...common, action: "set_focused_text", params: { ...(step.params ?? {}) } };
    case "tap": {
      const target = selectorParams(step, appMap);
      if (!target) throw new Error(`Compiled step ${step.id} has no portable selector or normalized coordinates`);
      if (finite(target.x) && finite(target.y)) {
        return { ...common, action: "tap", params: { x: target.x, y: target.y } };
      }
      return { ...common, action: "a11y_find_tap", params: target };
    }
    case "wait":
      throw new Error("wait is converted as a workflow wait step");
    default:
      throw new Error(`Compiled action is not an edge-workflow/v2 primitive: ${String(step.action)}`);
  }
}

function anchorValue(anchor: string): string {
  const separator = anchor.indexOf(":");
  return (separator >= 0 ? anchor.slice(separator + 1) : anchor).trim();
}

function stateWaits(step: CompiledStep, page: PageDef | undefined): WaitStep[] {
  if (!page || step.action === "screen_wake" || step.action === "unlock" || step.action === "wait") return [];
  const waits: WaitStep[] = [];
  page.detection.anchors.filter(Boolean).forEach((anchor, index) => {
    waits.push({
      type: "wait",
      id: `${step.id}__state_required_${index}`,
      until: {
        action: "ui_tree_dump",
        params: {},
        outputPath: "uiTree",
        operator: "contains_ci",
        expected: anchorValue(anchor),
        pollIntervalMs: 250,
        timeoutMs: DEFAULT_STATE_TIMEOUT_MS,
      },
    });
  });
  (page.detection.forbiddenAnchors ?? []).filter(Boolean).forEach((anchor, index) => {
    waits.push({
      type: "wait",
      id: `${step.id}__state_forbidden_${index}`,
      until: {
        action: "ui_tree_dump",
        params: {},
        outputPath: "uiTree",
        operator: "not_contains_ci",
        expected: anchorValue(anchor),
        pollIntervalMs: 250,
        timeoutMs: DEFAULT_STATE_TIMEOUT_MS,
      },
    });
  });
  return waits;
}

function compiledStepToEdgeSteps(step: CompiledStep, appMap: AppMap): WorkflowStep[] {
  if (step.action === "wait") {
    const durationMs = typeof step.params?.durationMs === "number" ? step.params.durationMs : step.retryDelay;
    if (!finite(durationMs) || durationMs < 0) {
      throw new Error(`Compiled wait step ${step.id} requires params.durationMs`);
    }
    return [{
      type: "wait",
      id: step.id,
      duration: { min: durationMs, max: durationMs, distribution: "uniform" },
    }];
  }

  const action = actionStep(step, appMap);
  const expectedPage = step.expectedPage ? appMap.pages[step.expectedPage] : undefined;
  if (step.expectedPage && !expectedPage) {
    throw new Error(`Compiled step ${step.id} references unknown expected page ${step.expectedPage}`);
  }
  if (
    expectedPage &&
    expectedPage.detection.anchors.length === 0 &&
    (expectedPage.detection.forbiddenAnchors?.length ?? 0) === 0
  ) {
    throw new Error(`Expected page ${step.expectedPage} has no portable state anchors`);
  }
  return [action, ...stateWaits(step, expectedPage)];
}

export async function compiledWorkflowToEdgeTemplate(workflow: CompiledWorkflow): Promise<WorkflowTemplate> {
  const appMap = await loadMap(workflow.appId);
  if (!appMap) throw new Error(`App map not found for ${workflow.appId}`);

  const steps = workflow.steps.flatMap((step) => compiledStepToEdgeSteps(step, appMap));
  return {
    id: workflow.id,
    name: workflow.name,
    platform: workflow.appId,
    description: workflow.source,
    version: `compiled-${workflow.appMapVersion}`,
    runtimeContract: "edge-workflow/v2",
    steps,
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 0,
    compatibleAppVersions: appMap.appVersion ? [appMap.appVersion] : undefined,
  };
}
