import type { GraphRoute, UiSafetyClass, UiTransitionDefinition } from "./types";

const SAFETY_RANK: Record<UiSafetyClass, number> = {
  read_only: 0,
  navigation: 1,
  mutating: 2,
  sensitive: 3,
};

export interface GraphPlanningPolicy {
  maxSafetyClass: UiSafetyClass;
  minimumConfidence?: number;
  maxTransitions?: number;
}

export function planGraphRoute(
  sourceStateId: string,
  targetStateId: string,
  transitions: UiTransitionDefinition[],
  policy: GraphPlanningPolicy,
): GraphRoute {
  if (sourceStateId === targetStateId) return { found: true, transitions: [], totalCost: 0 };
  const minimumConfidence = policy.minimumConfidence ?? 0.7;
  const maxTransitions = policy.maxTransitions ?? 20;
  const eligible = transitions.filter((transition) =>
    transition.status === "promoted"
    && transition.confidence >= minimumConfidence
    && SAFETY_RANK[transition.safetyClass] <= SAFETY_RANK[policy.maxSafetyClass]
  );

  const distances = new Map<string, number>([[sourceStateId, 0]]);
  const previous = new Map<string, UiTransitionDefinition>();
  const depth = new Map<string, number>([[sourceStateId, 0]]);
  const pending = new Set<string>([sourceStateId]);

  while (pending.size > 0) {
    const current = [...pending].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    pending.delete(current);
    if (current === targetStateId) break;
    const currentDepth = depth.get(current) ?? 0;
    if (currentDepth >= maxTransitions) continue;

    for (const transition of eligible.filter((item) => item.sourceStateId === current)) {
      const confidencePenalty = Math.max(0, 1 - transition.confidence);
      const nextDistance = (distances.get(current) ?? Infinity) + transition.cost + confidencePenalty;
      if (nextDistance >= (distances.get(transition.targetStateId) ?? Infinity)) continue;
      distances.set(transition.targetStateId, nextDistance);
      previous.set(transition.targetStateId, transition);
      depth.set(transition.targetStateId, currentDepth + 1);
      pending.add(transition.targetStateId);
    }
  }

  if (!previous.has(targetStateId)) {
    return { found: false, transitions: [], totalCost: Infinity, reason: "No promoted route satisfies confidence and safety policy" };
  }

  const route: UiTransitionDefinition[] = [];
  let cursor = targetStateId;
  while (cursor !== sourceStateId) {
    const transition = previous.get(cursor);
    if (!transition) return { found: false, transitions: [], totalCost: Infinity, reason: "Route reconstruction failed" };
    route.unshift(transition);
    cursor = transition.sourceStateId;
    if (route.length > maxTransitions) return { found: false, transitions: [], totalCost: Infinity, reason: "Route exceeds transition budget" };
  }

  return { found: true, transitions: route, totalCost: distances.get(targetStateId) ?? 0 };
}
