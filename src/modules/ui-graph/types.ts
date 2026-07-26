import type { UiTreeNode } from "../app-mapping/schema";

export type UiSafetyClass = string;
export type UiStateKind = "screen" | "overlay" | "system" | "unknown";
export type ResolutionMethod = "exact_hash" | "anchors" | "fuzzy" | "unknown";
export type TargetResolutionMethod = "direct" | "resource_id" | "content_description" | "semantic_id" | "text" | "structural" | "coord_cache" | "ocr" | "vlm" | "unknown";

export interface UiGraphContext {
  appId: string;
  appVersion?: string | null;
  appBuild?: string | null;
  androidVersion?: string | null;
  locale?: string | null;
  deviceClass?: string | null;
  deviceId?: string | null;
  workflowId?: string | null;
  stepId?: string | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  currentStateId?: string | null;
  currentVariantId?: string | null;
  branchKey?: string | null;
  initialStateKey?: string | null;
  finalStateKey?: string | null;
  recoveryCount?: number | null;
}

export interface UiStateVariantDefinition {
  id: string;
  key: string;
  signatureHash?: string | null;
  requiredAnchors: string[];
  optionalAnchors: string[];
  forbiddenAnchors: string[];
  appVersionPattern?: string | null;
  localePattern?: string | null;
  deviceClass?: string | null;
  confidenceThreshold?: number;
}

export interface UiStateDefinition {
  id: string;
  appId: string;
  key: string;
  name: string;
  kind: UiStateKind;
  safetyClass: UiSafetyClass;
  variants: UiStateVariantDefinition[];
}

export interface StateResolution {
  stateId: string | null;
  stateKey: string | null;
  variantId: string | null;
  variantKey: string | null;
  method: ResolutionMethod;
  confidence: number;
  fingerprint: string;
  matchedAnchors: string[];
  missingAnchors: string[];
  unexpectedAnchors: string[];
  ambiguousWith: Array<{ stateId: string; variantId: string; confidence: number }>;
}

export type SelectorStrategy = "resource_id" | "content_description" | "semantic_id" | "text" | "text_contains" | "structural" | "normalized_coords";

export interface UiSelectorDefinition {
  id: string;
  stateId: string;
  elementKey: string;
  strategy: SelectorStrategy;
  value?: string;
  path?: string[];
  coords?: { x: number; y: number };
  priority: number;
  dynamic: boolean;
  confidence: number;
  appVersionPattern?: string | null;
  deviceClass?: string | null;
  variantId?: string | null;
}

export interface TargetResolution {
  found: boolean;
  method: TargetResolutionMethod;
  selectorId?: string;
  coords?: { x: number; y: number };
  node?: UiTreeNode;
  confidence: number;
  reason?: string;
  attempted: TargetResolutionMethod[];
}

export interface UiTransitionDefinition {
  id: string;
  key: string;
  appId: string;
  sourceStateId: string;
  targetStateId: string;
  elementKey?: string | null;
  action: Record<string, unknown>;
  cost: number;
  safetyClass: UiSafetyClass;
  confidence: number;
  preconditions?: Record<string, unknown>;
  postconditions?: Record<string, unknown>;
}

export interface GraphRoute {
  found: boolean;
  transitions: UiTransitionDefinition[];
  totalCost: number;
  reason?: string;
}

export interface RecoveryProposal {
  type: "retry" | "adapt" | "dismiss_overlay" | "navigate" | "abort";
  sourceStateId?: string | null;
  expectedTargetStateId?: string | null;
  actions: Array<Record<string, unknown>>;
  selector?: Partial<UiSelectorDefinition>;
  confidence: number;
  reason: string;
  learningEligible: boolean;
  usedVision?: boolean;
}

export interface RuntimeFlags {
  enabled: boolean;
  selectorFirst: boolean;
  graphRuntime: boolean;
  aiRecovery: boolean;
  candidateLearning: boolean;
  autoPromotion: boolean;
}
