/**
 * workflow-compiler/workflow-validator.ts
 * Validate compiled workflow JSON against the source AppMap.
 *
 * Checks:
 *   - All referenced pages exist in the app map
 *   - All referenced elements exist on their pages
 *   - No impossible transitions (element doesn't lead to expected page)
 *   - Action params are valid (required fields present, types correct)
 *   - Workflow structure is sound (at least one step, IDs unique)
 *
 * Story: US-WORKFLOW-COMPILER
 */

import type { AppMap, PageDef, ElementDef } from "../app-mapping/schema";
import type { CompiledWorkflow, CompiledStep, ValidationResult, CompiledAction } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// STEP SCHEMA VALIDATION (for recovery adapted steps)
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_STEP_ACTIONS: Set<string> = new Set([
  "tap", "type", "swipe", "press_key", "wait", "open_app", "screenshot",
]);

/** Validate a single step object (from LLM recovery) against the CompiledStep schema. */
export function validateStepSchema(
  step: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof step.action !== "string" || !VALID_STEP_ACTIONS.has(step.action)) {
    errors.push(`Invalid or missing action: ${step.action}`);
  }
  if (typeof step.id !== "string" || step.id.length === 0) {
    errors.push("Missing or invalid step id");
  }
  if (typeof step.expectedPage !== "string" || step.expectedPage.length === 0) {
    errors.push("Missing or invalid expectedPage");
  }
  if (typeof step.expectedPageHash !== "string" || step.expectedPageHash.length === 0) {
    errors.push("Missing or invalid expectedPageHash");
  }
  if (typeof step.description !== "string") {
    errors.push("Missing description");
  }
  if (step.target !== undefined && step.target !== null) {
    const t = step.target as Record<string, unknown>;
    if (t.coords) {
      const c = t.coords as { x?: number; y?: number };
      if (typeof c.x !== "number" || typeof c.y !== "number" || c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1) {
        errors.push("Invalid coords (must be numbers in [0,1])");
      }
    }
  }
  if (typeof step.retries !== "undefined" && (typeof step.retries !== "number" || step.retries < 0)) {
    errors.push("Invalid retries (must be number >= 0)");
  }
  if (typeof step.retryDelay !== "undefined" && (typeof step.retryDelay !== "number" || step.retryDelay < 0)) {
    errors.push("Invalid retryDelay (must be number >= 0)");
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a compiled workflow against the app map it was compiled from.
 *
 * @returns ValidationResult with `valid`, `errors` (blocking), and `warnings` (non-blocking).
 */
export function validateCompiledWorkflow(
  workflow: CompiledWorkflow,
  appMap: AppMap,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Structural checks ────────────────────────────────────────────────────

  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push("Workflow has no steps.");
    return { valid: false, errors, warnings };
  }

  const stepIds = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.id) {
      errors.push(`Step missing id: ${JSON.stringify(step)}`);
    } else if (stepIds.has(step.id)) {
      errors.push(`Duplicate step id: "${step.id}"`);
    } else {
      stepIds.add(step.id);
    }
  }

  // ── App ID match ─────────────────────────────────────────────────────────

  if (workflow.appId && workflow.appId !== appMap.appId) {
    errors.push(
      `Workflow appId "${workflow.appId}" does not match app map "${appMap.appId}".`,
    );
  }

  // ── Start page ───────────────────────────────────────────────────────────

  if (workflow.startPage && !(workflow.startPage in appMap.pages)) {
    errors.push(
      `Start page "${workflow.startPage}" does not exist in app map. Available: ${Object.keys(appMap.pages).join(", ")}`,
    );
  }

  // ── Per-step validation ──────────────────────────────────────────────────

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const prefix = `Step ${i} (${step.id || "no-id"})`;

    validateStepAction(step, prefix, errors, warnings);
    validateStepTarget(step, appMap, prefix, errors, warnings);
    validateExpectedPage(step, appMap, prefix, errors, warnings);
    validateStepParams(step, prefix, errors, warnings);
    validateTransition(step, appMap, prefix, warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_ACTIONS: CompiledAction[] = [
  "tap", "type", "swipe", "press_key", "wait", "open_app", "intent_send", "screenshot",
];

function validateStepAction(
  step: CompiledStep,
  prefix: string,
  errors: string[],
  _warnings: string[],
): void {
  if (!step.action) {
    errors.push(`${prefix}: Missing action.`);
    return;
  }

  if (!VALID_ACTIONS.includes(step.action)) {
    errors.push(`${prefix}: Invalid action "${step.action}". Must be one of: ${VALID_ACTIONS.join(", ")}`);
  }

  // Actions that require a target
  const needsTarget: CompiledAction[] = ["tap"];
  if (needsTarget.includes(step.action) && !step.target) {
    errors.push(`${prefix}: Action "${step.action}" requires a target.`);
  }
}

function validateStepTarget(
  step: CompiledStep,
  appMap: AppMap,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  if (!step.target) return;

  // If elementId is specified, verify it exists in the app map
  if (step.target.elementId) {
    let found = false;
    for (const page of Object.values(appMap.pages)) {
      if (step.target.elementId! in page.elements) {
        found = true;
        break;
      }
    }
    if (!found) {
      errors.push(
        `${prefix}: target.elementId "${step.target.elementId}" does not exist in any page of the app map.`,
      );
    }
  }

  // Validate coords if present
  if (step.target.coords) {
    const { x, y } = step.target.coords;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      errors.push(
        `${prefix}: target.coords (${x}, ${y}) out of normalized range [0, 1].`,
      );
    }
  }

  // Warn if no targeting method at all
  if (
    !step.target.elementId &&
    !step.target.resourceId &&
    !step.target.text &&
    !step.target.coords
  ) {
    warnings.push(`${prefix}: target specified but has no elementId, resourceId, text, or coords.`);
  }
}

function validateExpectedPage(
  step: CompiledStep,
  appMap: AppMap,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  if (!step.expectedPage) {
    errors.push(`${prefix}: Missing expectedPage.`);
    return;
  }

  if (!(step.expectedPage in appMap.pages)) {
    errors.push(
      `${prefix}: expectedPage "${step.expectedPage}" does not exist in app map. Available: ${Object.keys(appMap.pages).join(", ")}`,
    );
    return;
  }

  // Verify hash matches the page
  const page = appMap.pages[step.expectedPage];
  if (step.expectedPageHash && step.expectedPageHash !== page.detection.signatureHash) {
    warnings.push(
      `${prefix}: expectedPageHash "${step.expectedPageHash}" does not match page "${step.expectedPage}" signature "${page.detection.signatureHash}". The app map may have changed since compilation.`,
    );
  }
}

function validateStepParams(
  step: CompiledStep,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  if (!step.params) return;

  switch (step.action) {
    case "type":
      if (typeof step.params.text !== "string") {
        errors.push(`${prefix}: "type" action requires params.text (string).`);
      }
      break;

    case "open_app":
      if (typeof step.params.packageName !== "string") {
        errors.push(`${prefix}: "open_app" action requires params.packageName (string).`);
      }
      break;

    case "intent_send":
      if (typeof step.params.uri !== "string" || !step.params.uri.trim()) {
        errors.push(`${prefix}: "intent_send" action requires params.uri (non-empty string).`);
      }
      if (step.params.packageName !== undefined && typeof step.params.packageName !== "string") {
        errors.push(`${prefix}: intent_send params.packageName must be a string when provided.`);
      }
      if (step.params.action !== undefined && typeof step.params.action !== "string") {
        errors.push(`${prefix}: intent_send params.action must be a string when provided.`);
      }
      break;

    case "swipe":
      if (!["up", "down", "left", "right"].includes(step.params.direction as string)) {
        errors.push(`${prefix}: "swipe" action requires params.direction (up/down/left/right).`);
      }
      if (step.params.distance !== undefined) {
        const d = step.params.distance as number;
        if (typeof d !== "number" || d < 0 || d > 1) {
          errors.push(`${prefix}: swipe params.distance must be a number in [0, 1].`);
        }
      }
      break;

    case "press_key":
      if (typeof step.params.key !== "string") {
        errors.push(`${prefix}: "press_key" action requires params.key (string).`);
      }
      break;

    case "wait":
      if (typeof step.params.durationMs !== "number" || (step.params.durationMs as number) <= 0) {
        errors.push(`${prefix}: "wait" action requires params.durationMs (positive number, ms).`);
      } else if ((step.params.durationMs as number) > 30000) {
        warnings.push(`${prefix}: wait duration > 30s — consider splitting into shorter waits.`);
      }
      break;

    case "screenshot":
      // No params needed
      if (Object.keys(step.params).length > 0) {
        warnings.push(`${prefix}: "screenshot" action doesn't use params — they will be ignored.`);
      }
      break;
  }

  // Validate retries/retryDelay
  if (step.retries < 0) {
    errors.push(`${prefix}: retries must be >= 0.`);
  }
  if (step.retryDelay < 0) {
    errors.push(`${prefix}: retryDelay must be >= 0.`);
  }
}

/**
 * Check if a transition implied by the step is possible according to the app map.
 * This is a soft check — we look at the page before this step and verify the
 * targeted element's `leadsTo` is consistent with the expectedPage.
 */
function validateTransition(
  step: CompiledStep,
  appMap: AppMap,
  prefix: string,
  warnings: string[],
): void {
  if (!step.target?.elementId || !step.expectedPage) return;

  // Find which page contains this element
  for (const [pageId, page] of Object.entries(appMap.pages)) {
    const elem = page.elements[step.target.elementId!];
    if (!elem) continue;

    // Element found on this page
    if (elem.leadsTo && elem.leadsTo !== "self" && elem.leadsTo !== step.expectedPage) {
      warnings.push(
        `${prefix}: element "${step.target.elementId}" on page "${pageId}" leads to "${elem.leadsTo}", but step expects page "${step.expectedPage}". Transition may be incorrect.`,
      );
    }
    break;
  }
}
