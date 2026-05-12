import * as fs from "fs";
import * as path from "path";

export interface WorkflowStep {
  id: string;
  type: "screen_wake" | "unlock" | "open_app" | "cascade_tap" | "tap" | "wait" | "decide" | "check_screen";
  package?: string;
  target?: string;
  element?: string;
  check?: string;
  context?: Record<string, any>;
  requires?: string[];
  delay_after?: number;
  optional?: boolean;
}

export interface Workflow {
  name: string;
  description: string;
  version: string;
  steps: WorkflowStep[];
}

const workflowCache: Record<string, Workflow> = {};

export function loadWorkflow(name: string): Workflow | null {
  if (workflowCache[name]) {
    return workflowCache[name];
  }

  const workflowPath = path.join(__dirname, `${name}.json`);
  if (!fs.existsSync(workflowPath)) {
    console.warn(`[workflow] Not found: ${workflowPath}`);
    return null;
  }

  try {
    const content = fs.readFileSync(workflowPath, "utf8");
    const workflow = JSON.parse(content) as Workflow;
    workflowCache[name] = workflow;
    return workflow;
  } catch (err) {
    console.error(`[workflow] Failed to load ${name}:`, err);
    return null;
  }
}

export function getStepById(workflow: Workflow, stepId: string): WorkflowStep | null {
  return workflow.steps.find(s => s.id === stepId) || null;
}

export function getNextSteps(workflow: Workflow, completedSteps: Set<string>): WorkflowStep[] {
  return workflow.steps.filter(step => {
    if (completedSteps.has(step.id)) return false;
    if (!step.requires) return true;
    return step.requires.every(reqId => completedSteps.has(reqId));
  });
}
