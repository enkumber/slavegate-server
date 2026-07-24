import type {
  WorkflowOutputSchema,
  WorkflowPostconditionContract,
  WorkflowTemplate,
} from "../workflows/types";

export type SegmentLifecycle =
  | "draft"
  | "candidate"
  | "promoted"
  | "degraded"
  | "quarantined"
  | "retired";

export interface SegmentInputSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  format?: "uri" | "uuid";
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  secret?: boolean;
}

export interface SegmentInputSchema {
  type: "object";
  required: string[];
  properties: Record<string, SegmentInputSchemaProperty>;
  additionalProperties?: boolean;
}

export type SegmentInputTransform =
  | { kind: "trim" }
  | { kind: "lowercase" }
  | { kind: "uppercase" }
  | { kind: "prefix_unless"; pattern: string; prefix: string }
  | { kind: "replace"; pattern: string; replacement: string; flags?: string };

export interface SegmentInputResolverField {
  sources: Array<
    | { kind: "regex"; pattern: string; group?: number; flags?: string }
    | { kind: "literal"; value: unknown }
  >;
  transforms?: SegmentInputTransform[];
}

export interface SegmentInputResolver {
  version: "1";
  fields: Record<string, SegmentInputResolverField>;
}

export interface WorkflowCompositionExecutionPolicy {
  defaultVerificationStrategy: WorkflowTemplate["defaultVerificationStrategy"];
  dataRetentionDays: number;
  runtimeContract: "edge-workflow/v2";
}

export interface WorkflowSegmentVersionRecord {
  segmentKey: string;
  version: string;
  platform: string;
  status: SegmentLifecycle;
  template: WorkflowTemplate;
  inputSchema: SegmentInputSchema;
  outputSchema: WorkflowOutputSchema | null;
  postconditionContract: WorkflowPostconditionContract | null;
  compatibility: Record<string, unknown>;
  fingerprint: string;
}

export interface WorkflowCompositionNodeRecord {
  nodeKey: string;
  ordinal: number;
  segmentKey: string;
  segmentVersion: string;
  inputBindings: Record<string, string>;
  outputBindings: Record<string, string>;
  dependsOn: string[];
}

export interface WorkflowCompositionRecord {
  compositionName: string;
  version: string;
  compositionKey: string;
  capabilityKey: string;
  platform: string;
  status: SegmentLifecycle;
  inputSchema: SegmentInputSchema;
  outputSchema: WorkflowOutputSchema;
  inputResolver: SegmentInputResolver;
  postconditionContract: WorkflowPostconditionContract;
  executionPolicy: WorkflowCompositionExecutionPolicy;
  compatibility: Record<string, unknown>;
  nodes: WorkflowCompositionNodeRecord[];
}

export interface ComposedWorkflow {
  architecture: "segments-v1";
  template: WorkflowTemplate;
  compositionName: string;
  compositionVersion: string;
  compositionKey: string;
  executionKey: string;
  requestKey: string;
  segmentKeys: string[];
  segmentRefs: Array<{ segmentKey: string; segmentVersion: string }>;
  runtimeInputs: Record<string, unknown>;
  publicRuntimeInputs: Record<string, unknown>;
}
