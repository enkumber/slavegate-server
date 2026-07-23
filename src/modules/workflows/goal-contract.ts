import type {
  WorkflowGoalContract,
  WorkflowInteractionEffect,
  WorkflowStep,
  WorkflowTemplate,
} from "./types";

const EFFECTS = new Set<WorkflowInteractionEffect>([
  "none",
  "observation",
  "navigation",
  "ui_input",
  "business_mutation",
  "sensitive",
  "destructive",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function parseWorkflowGoalContract(value: unknown): WorkflowGoalContract | null {
  if (!isRecord(value) || value.version !== "1" || !Array.isArray(value.stages) || value.stages.length === 0) {
    return null;
  }
  const allowedEffects = stringArray(value.allowedEffects);
  if (allowedEffects.length === 0 || allowedEffects.some((effect) => !EFFECTS.has(effect as WorkflowInteractionEffect))) {
    return null;
  }
  const stages = value.stages.map((raw) => {
    if (!isRecord(raw)) return null;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const allowedActions = stringArray(raw.allowedActions);
    const stageEffects = stringArray(raw.allowedEffects);
    if (
      !id
      || allowedActions.length === 0
      || stageEffects.some((effect) => !EFFECTS.has(effect as WorkflowInteractionEffect))
      || (
        raw.minOccurrences !== undefined
        && (
          typeof raw.minOccurrences !== "number"
          || !Number.isInteger(raw.minOccurrences)
          || raw.minOccurrences < 1
        )
      )
    ) {
      return null;
    }
    return {
      id,
      required: raw.required !== false,
      allowedActions,
      ...(stageEffects.length > 0 ? { allowedEffects: stageEffects as WorkflowInteractionEffect[] } : {}),
      ...(stringArray(raw.after).length > 0 ? { after: stringArray(raw.after) } : {}),
      ...(typeof raw.minOccurrences === "number" ? { minOccurrences: raw.minOccurrences } : {}),
      ...(stringArray(raw.produces).length > 0 ? { produces: stringArray(raw.produces) } : {}),
      ...(stringArray(raw.consumes).length > 0 ? { consumes: stringArray(raw.consumes) } : {}),
    };
  });
  if (stages.some((stage) => stage === null)) return null;
  const validStages = stages as WorkflowGoalContract["stages"];
  const stageIds = new Set(validStages.map((stage) => stage.id));
  if (stageIds.size !== validStages.length) return null;
  if (
    validStages.some((stage) =>
      (stage.allowedEffects ?? []).some((effect) => !allowedEffects.includes(effect))
      || (stage.after ?? []).some((dependency) => dependency === stage.id || !stageIds.has(dependency))
    )
  ) {
    return null;
  }
  return {
    version: "1",
    stages: validStages,
    ...(stringArray(value.requiredOutputs).length > 0
      ? { requiredOutputs: stringArray(value.requiredOutputs) }
      : {}),
    allowedEffects: allowedEffects as WorkflowInteractionEffect[],
  };
}

type IndexedAction = {
  step: Extract<WorkflowStep, { type: "action" }>;
  index: number;
};

function collectActions(steps: WorkflowStep[]): IndexedAction[] {
  const actions: IndexedAction[] = [];
  const visit = (items: WorkflowStep[]): void => {
    for (const step of items) {
      if (step.type === "action") {
        actions.push({ step, index: actions.length });
        if (step.action === "run_state_machine" && isRecord(step.params?.transitions)) {
          visit(Object.values(step.params.transitions)
            .filter(isRecord)
            .map((transition) => ({ ...transition, type: "action" } as Extract<WorkflowStep, { type: "action" }>)));
        }
        if (Array.isArray(step.onFailureSteps)) visit(step.onFailureSteps);
      } else if (step.type === "condition") {
        visit(step.if_true);
        if (step.if_false) visit(step.if_false);
      } else if (step.type === "loop") {
        visit(step.steps);
      }
    }
  };
  visit(steps);
  return actions;
}

function producedVariables(action: IndexedAction["step"]): Set<string> {
  const produced = new Set<string>();
  if (action.saveOutputAs) produced.add(action.saveOutputAs);
  const outputVariable = action.params?.outputVariable;
  if (typeof outputVariable === "string" && outputVariable) produced.add(outputVariable);
  if (action.action === "classify_ui_tree" && isRecord(action.params?.outputs)) {
    Object.keys(action.params.outputs).forEach((key) => produced.add(key));
  }
  return produced;
}

function referencedVariables(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{([a-zA-Z0-9_.-]+)}}/g)) found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => referencedVariables(item, found));
    return found;
  }
  if (isRecord(value)) {
    if (typeof value.$bind === "string" && value.$bind.trim()) found.add(value.$bind.trim());
    Object.values(value).forEach((item) => referencedVariables(item, found));
  }
  return found;
}

export function workflowGoalContractReason(
  workflow: WorkflowTemplate,
  expectedContract?: WorkflowGoalContract | null,
): string | null {
  const contract = expectedContract ?? workflow.goalContract;
  if (!contract) return null;
  if (expectedContract && JSON.stringify(workflow.goalContract) !== JSON.stringify(expectedContract)) {
    return "workflow.goalContract does not match the capability contract selected from the catalog";
  }
  if (
    workflow.safetyClass === "read_only"
    && contract.allowedEffects.some((effect) =>
      effect === "business_mutation" || effect === "sensitive" || effect === "destructive"
    )
  ) {
    return "read_only workflow goal contract permits a mutating or sensitive effect";
  }

  const actions = collectActions(workflow.steps);
  const byStage = new Map<string, IndexedAction[]>();
  for (const action of actions) {
    if (!action.step.goalStage) continue;
    const entries = byStage.get(action.step.goalStage) ?? [];
    entries.push(action);
    byStage.set(action.step.goalStage, entries);
  }

  for (const action of actions) {
    const effect = action.step.effect;
    if (!effect) return `action "${action.step.id ?? action.step.action}" is missing effect`;
    if (!contract.allowedEffects.includes(effect)) {
      return `action "${action.step.id ?? action.step.action}" uses disallowed effect "${effect}"`;
    }
    if (action.step.goalStage && !contract.stages.some((stage) => stage.id === action.step.goalStage)) {
      return `action "${action.step.id ?? action.step.action}" references undeclared goal stage "${action.step.goalStage}"`;
    }
    if (effect !== "none" && !action.step.goalStage) {
      return `action "${action.step.id ?? action.step.action}" with effect "${effect}" is not assigned to a goal stage`;
    }
  }

  for (const stage of contract.stages) {
    const matches = byStage.get(stage.id) ?? [];
    const minimum = stage.required === false ? 0 : Math.max(1, stage.minOccurrences ?? 1);
    if (matches.length < minimum) return `required goal stage "${stage.id}" is not covered`;
    for (const match of matches) {
      if (!stage.allowedActions.includes(match.step.action)) {
        return `goal stage "${stage.id}" uses action "${match.step.action}" outside its catalog contract`;
      }
      if (stage.allowedEffects && (!match.step.effect || !stage.allowedEffects.includes(match.step.effect))) {
        return `goal stage "${stage.id}" uses an effect outside its catalog contract`;
      }
      for (const dependency of stage.after ?? []) {
        const dependencyMatches = byStage.get(dependency) ?? [];
        if (dependencyMatches.length === 0 || dependencyMatches.every((candidate) => candidate.index >= match.index)) {
          return `goal stage "${stage.id}" must occur after "${dependency}"`;
        }
      }
    }

    const produced = new Set(matches.flatMap((match) => [...producedVariables(match.step)]));
    for (const variable of stage.produces ?? []) {
      if (!produced.has(variable)) return `goal stage "${stage.id}" does not produce "${variable}"`;
    }
    const referenced = new Set(matches.flatMap((match) => [...referencedVariables(match.step.params)]));
    for (const variable of stage.consumes ?? []) {
      if (!referenced.has(variable)) return `goal stage "${stage.id}" does not consume binding "${variable}"`;
    }
  }

  const schemaRequired = new Set(workflow.outputSchema?.required ?? []);
  const allProduced = new Set(actions.flatMap((action) => [...producedVariables(action.step)]));
  for (const output of contract.requiredOutputs ?? []) {
    if (!schemaRequired.has(output)) return `required output "${output}" is absent from outputSchema.required`;
    if (!allProduced.has(output)) return `required output "${output}" is not produced by the workflow`;
  }
  return null;
}
