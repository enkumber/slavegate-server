/**
 * api/agency.ts
 * API client for Marketing Agency endpoints.
 */

import { api } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  active: boolean;
  strategy: Record<string, unknown>;
  type: 'client' | 'farming';
  created_at: string;
  updated_at: string;
}

export interface Material {
  id: string;
  client_id: string | null;
  account_id: string | null;
  type: "image" | "video" | "text";
  url: string;
  description: string | null;
  uploaded_at: string;
  used: boolean;
  client_name?: string;
}

export interface Post {
  id: string;
  account_id: string;
  platform: string;
  status: "pending_approval" | "approved" | "rejected" | "published";
  content: {
    media_url?: string;
    caption?: string;
    hashtags?: string[];
    thumbnail_url?: string;
  };
  created_by: string;
  brief_id: string | null;
  created_at: string;
  approved_at: string | null;
  published_at: string | null;
  account_username?: string;
  account_platform?: string;
}

export interface Task {
  id: string;
  batch_id: string | null;
  account_id: string;
  device_id: string;
  scheduled_time: string;
  status: "queued" | "running" | "completed" | "failed" | "paused";
  routine: string;
  params: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  account_username?: string;
  account_platform?: string;
  device_name?: string;
}

export interface Report {
  id: string;
  type: "daily_analytics" | "weekly" | "anomaly";
  period: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AgencyStats {
  clients: { total: number; active: number };
  posts: { total: number; pending: number; approved: number; published: number; rejected: number };
  tasks: { total: number; queued: number; running: number; completed: number; failed: number };
  materials: { total: number; used: number; unused: number };
}

export interface HumanWorkflowCompileRequest {
  device_id: string;
  account_id?: string | null;
  intent: string;
}

export interface HumanWorkflowRunRequest extends HumanWorkflowCompileRequest {
  requestKey?: string;
  cacheKey?: string;
  compileJobId?: string;
}

export interface HumanWorkflowTarget {
  device_id: string;
  device_model: string | null;
  device_name: string | null;
  account_id: string | null;
  account_username: string | null;
  account_platform: string;
  client_id: string | null;
}

export interface HumanWorkflowCompileReadyResult {
  ready: true;
  requestKey: string;
  cacheHit: boolean;
  cacheKey?: string;
  source?: "cache" | "shortcut" | "llm" | "composition";
  plan: {
    templateId?: string;
    version?: string;
    steps?: unknown[];
    actions?: unknown[];
    compiledPlan?: {
      steps?: unknown[];
      llmBudget?: Record<string, unknown>;
    };
  };
  safetyClass: "read_only" | "standard" | "destructive";
  platform: string;
  target: HumanWorkflowTarget;
  llmBudget?: Record<string, unknown>;
  architecture?: "segments-v1";
  compositionName?: string;
  compositionVersion?: string;
  compositionKey?: string;
  executionKey?: string;
  segmentKeys?: string[];
  segmentRefs?: Array<{ segmentKey: string; segmentVersion: string }>;
  publicRuntimeInputs?: Record<string, unknown>;
}

export interface HumanWorkflowCompileCompilingResult {
  ready: false;
  requestKey: string;
  compileJobId: string;
  retryAfterMs?: number;
  source: "llm";
}

export interface HumanWorkflowCompileBuildingSegmentResult {
  ready: false;
  requestKey: string;
  segmentBuildJobId: string;
  retryAfterMs?: number;
  source: "agent";
  reason?: string;
}

export type HumanWorkflowCompileResult =
  | HumanWorkflowCompileReadyResult
  | HumanWorkflowCompileCompilingResult
  | HumanWorkflowCompileBuildingSegmentResult;

export interface HumanWorkflowCompileJobPendingResult {
  ready: false;
  terminal: false;
  status: string;
  requestKey: string;
  compileJobId: string;
  retryAfterMs?: number;
}

export interface HumanWorkflowCompileJobFailedResult {
  ready: false;
  terminal: true;
  status: string;
  requestKey: string;
  compileJobId: string;
  error: string;
  retryable: boolean;
}

export type HumanWorkflowCompileJobResult =
  | (HumanWorkflowCompileReadyResult & { status: string; compileJobId?: string; retryAfterMs?: number })
  | HumanWorkflowCompileJobPendingResult
  | HumanWorkflowCompileJobFailedResult;

export interface HumanWorkflowRunResult {
  id: string;
  status: "queued" | "compiling" | "running" | "completed" | "failed" | "paused";
  taskId?: string;
  requestKey?: string;
  cacheKey?: string;
}

export interface AgencyWorkflowRun {
  id: string;
  client_id: string;
  account_id: string | null;
  device_id: string | null;
  platform: string;
  intent: string;
  safety_class: string;
  request_key: string;
  cache_key: string | null;
  status: "queued" | "compiling" | "running" | "completed" | "failed" | "cancelled";
  task_id: string | null;
  error: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkflowRunTimelineStep {
  index: number;
  id: string;
  label: string;
  action: string | null;
  type: string | null;
  status: "succeeded" | "running" | "failed" | "pending" | string;
  durationMs: number | null;
  error: string | null;
  state: string | null;
}

export type WorkflowRunFeedbackRating = "ok" | "not_ok" | "partial";

export interface WorkflowRunFeedback {
  rating: WorkflowRunFeedbackRating;
  lastGoodStepIndex: number | null;
  note: string | null;
  source: string | null;
  at: string | null;
}

export interface WorkflowRunStepCandidate {
  id: string;
  runId: string;
  stepIndex: number;
  stepId: string | null;
  label: string;
  action: string | null;
  type: string | null;
  stepStatus: string | null;
  candidateState: "step_candidate" | "validated_step" | "rejected" | string;
  requestKey: string | null;
  cacheKey: string | null;
  canonicalWorkflowId: string | null;
  canonicalWorkflowVersion: string | null;
  lastGoodStepIndex: number;
  stepSnapshot: Record<string, unknown>;
  evidence: Record<string, unknown>;
  note: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  validationContract: Record<string, unknown>;
  validationEvidence: Record<string, unknown>;
  validatedBy: string | null;
  validatedAt: string | null;
  runStatus?: string | null;
  runIntent?: string | null;
  deviceName?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StepLibraryEntry {
  id: string;
  stepCandidateId: string;
  name: string;
  action: string | null;
  type: string | null;
  status: "validated_step" | string;
  libraryState: "review_only" | string;
  reuseScope: string;
  promotionScope: string | null;
  reusable: boolean;
  compilerEligible: boolean;
  confidence: number | null;
  readiness: {
    state: "review_ready" | "needs_review" | string;
    score: number;
    threshold: number;
    gates: Record<string, boolean>;
    blockers: string[];
    notes: string[];
  };
  contract: Record<string, unknown>;
  evidence: Record<string, unknown>;
  preconditions: string[];
  postconditions: string[];
  compatibility: Record<string, unknown>;
  sourceCandidate: WorkflowRunStepCandidate;
  runId: string;
  runIntent: string | null;
  runStatus: string | null;
  deviceName: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  promotionNote: string | null;
  promotedBy: string | null;
  promotedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StepLibraryPromotionEvent {
  id: string;
  stepCandidateId: string;
  action: "promote_limited" | "revoke" | string;
  libraryState: "limited_reuse" | "revoked" | string;
  promotionScope: string | null;
  note: string | null;
  actor: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  stepName: string | null;
  stepAction: string | null;
  runIntent: string | null;
  deviceName: string | null;
}

export interface ToolCatalogEntry {
  id: string;
  name: string;
  source: "device_job" | "workflow_runtime" | "server_skill" | string;
  category: string;
  description: string;
  risk: "low" | "medium" | "high" | string;
  requiresDevice: boolean;
  sideEffects: string[];
  inputSchema: {
    required: string[];
    optional: string[];
  };
  outputSchema: {
    produces: string[];
  };
  policy: {
    readOnly: boolean;
    mutating: boolean;
    destructive: boolean;
    externalAction: boolean;
    compilerVisible: false;
    autoUseEnabled: false;
  };
  availability: {
    directWs: boolean;
    edgeWorkflow: boolean;
    serverRuntime: boolean;
  };
  notes: string[];
}

export interface ToolCatalogResponse {
  items: ToolCatalogEntry[];
  total: number;
  policy: {
    compilerVisible: false;
    autoUseEnabled: false;
    mode: string;
  };
}

export interface CompilerKnowledgeEntry {
  id: string;
  title: string;
  type: string;
  domain: string;
  appliesTo: string[];
  summary: string;
  guidance: string[];
  risk: "low" | "medium" | "high" | string;
  source: string;
  status: string;
  policy: {
    readOnly: true;
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
  };
  evidence: {
    required: string[];
    examples: string[];
  };
  notes: string[];
}

export interface CompilerKnowledgeResponse {
  items: CompilerKnowledgeEntry[];
  total: number;
  policy: {
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
    mode: string;
  };
}

export interface CompilerPolicyGate {
  id: string;
  title: string;
  category: string;
  state: string;
  risk: "low" | "medium" | "high" | string;
  owner: string;
  configState?: string;
  version?: number;
  config?: Record<string, unknown>;
  updatedBy?: string | null;
  updatedAt?: string | null;
  blocks: string[];
  requiredEvidence: string[];
  requiredPolicyChanges: string[];
  remediation: {
    state: string;
    nextActions: string[];
    safeToAutoApply: false;
  };
  guardrails: string[];
  notes: string[];
}

export interface CompilerPolicyGatesResponse {
  items: CompilerPolicyGate[];
  total: number;
  policy: {
    readOnly: true;
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
    mode: string;
  };
}

export interface CompilerAwarenessCandidate {
  id: string;
  name?: string;
  title?: string;
  action?: string | null;
  type?: string | null;
  category?: string;
  domain?: string;
  source?: string;
  risk?: string;
  libraryState?: string;
  promotionScope?: string | null;
  matchedTerms: string[];
  compilerEligible?: false;
  wouldUse?: false;
  wouldApply?: false;
  reason: string;
  eligibility?: {
    state?: string;
    gates?: Record<string, boolean>;
    blockers?: string[];
    policyGates?: Array<{
      id?: string;
      category?: string;
      state?: string;
      risk?: string;
      owner?: string;
      safeToAutoApply?: boolean;
      [key: string]: unknown;
    }>;
    remediation?: {
      state?: string;
      nextActions?: string[];
      requiredPolicyChanges?: string[];
      safeToAutoApply?: boolean;
      [key: string]: unknown;
    };
    notes?: string[];
    [key: string]: unknown;
  };
}

export interface CompilerAwarenessResponse {
  intent: string | null;
  terms: string[];
  policy: {
    readOnly: true;
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
    mode: string;
  };
  summary: {
    toolCandidates: number;
    stepCandidates: number;
    knowledgeCandidates: number;
  };
  candidates: {
    tools: CompilerAwarenessCandidate[];
    steps: CompilerAwarenessCandidate[];
    knowledge: CompilerAwarenessCandidate[];
  };
  decision: {
    outcome?: string;
    wouldChangePlan?: boolean;
    wouldExecuteStepLibrary?: boolean;
    selectedStepIds?: string[];
    selectedToolIds?: string[];
    blockers?: string[];
    policyGateSummary?: Array<{
      id?: string;
      category?: string;
      state?: string;
      risk?: string;
      owner?: string;
      safeToAutoApply?: boolean;
      [key: string]: unknown;
    }>;
    remediation?: {
      state?: string;
      nextActions?: string[];
      requiredPolicyChanges?: string[];
      safeToAutoApply?: boolean;
      [key: string]: unknown;
    };
    notes?: string[];
    [key: string]: unknown;
  };
  policyGateSummary?: {
    gates?: Array<{
      id?: string;
      category?: string | null;
      state?: string | null;
      risk?: string | null;
      owner?: string | null;
      safeToAutoApply?: boolean;
      [key: string]: unknown;
    }>;
    total?: number;
    blocked?: number;
    highRisk?: number;
    safeToAutoApply?: number;
    [key: string]: unknown;
  };
  guardrails: string[];
}

export interface CompilerAwarenessEvent {
  id: string;
  intent: string | null;
  action: string | null;
  terms: string[];
  summary: {
    toolCandidates?: number;
    stepCandidates?: number;
    knowledgeCandidates?: number;
    [key: string]: unknown;
  };
  policy: {
    readOnly?: boolean;
    compilerVisible?: boolean;
    autoUseEnabled?: boolean;
    executionChanging?: boolean;
    mode?: string;
    [key: string]: unknown;
  };
  candidates: Record<string, unknown>;
  decision: {
    outcome?: string;
    wouldChangePlan?: boolean;
    wouldExecuteStepLibrary?: boolean;
    blockers?: string[];
    [key: string]: unknown;
  };
  policyGateSummary?: {
    gates?: Array<{
      id?: string;
      category?: string | null;
      state?: string | null;
      risk?: string | null;
      owner?: string | null;
      safeToAutoApply?: boolean;
      [key: string]: unknown;
    }>;
    total?: number;
    blocked?: number;
    highRisk?: number;
    safeToAutoApply?: number;
    [key: string]: unknown;
  };
  actor: string | null;
  source: string | null;
  createdAt: string | null;
}

export interface CompilerControlPlaneResponse {
  intent: string | null;
  action: string | null;
  requestedScope: string | null;
  policy: {
    readOnly: true;
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
    workflowCacheChanging: false;
    mode: string;
  };
  policyGates: {
    items: CompilerPolicyGate[];
    summary: {
      total?: number;
      blocked?: number;
      reviewReady?: number;
      enabled?: number;
      highRisk?: number;
      safeToAutoApply?: number;
      gates?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
  };
  awareness: CompilerAwarenessResponse;
  dryRun: {
    mode: string;
    wouldUseStepLibrary: false;
    wouldChangePlan: false;
    wouldExecuteStepLibrary: false;
    selectedStepIds: string[];
    selectedToolIds: string[];
    safeToAutoApply: false;
    outcome: string;
    blockers: string[];
    candidateCounts: Record<string, unknown>;
    policyGateSummary: Record<string, unknown>;
    [key: string]: unknown;
  };
  capabilityManifest: {
    source: string;
    publishedByDevice: boolean;
    deviceSelected: boolean;
    deviceId: string | null;
    deviceName: string | null;
    model: string | null;
    androidVersion: string | null;
    agentVersion: string | null;
    status: string | null;
    compatibility: {
      state?: string;
      availableTools?: number;
      totalTools?: number;
      [key: string]: unknown;
    };
    tools: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  limitedReusePlan: {
    mode: string;
    requestedScope: string | null;
    items: Array<{
      stepId?: string | null;
      action?: string | null;
      name?: string | null;
      libraryState?: string | null;
      promotionScope?: string | null;
      requestedScope?: string | null;
      scopeMatch?: boolean;
      capabilityMatch?: boolean;
      wouldUse?: false;
      safeToAutoApply?: false;
      blockers?: string[];
      notes?: string[];
      [key: string]: unknown;
    }>;
    summary: Record<string, unknown>;
  };
  guardrails: string[];
}

export interface CompilerControlPlaneEvent {
  id: string;
  intent: string | null;
  action: string | null;
  deviceId: string | null;
  requestedScope: string | null;
  summary: Record<string, unknown>;
  policy: Record<string, unknown>;
  dryRun: Record<string, unknown>;
  capabilityManifest: Record<string, unknown>;
  limitedReusePlan: Record<string, unknown>;
  actor: string | null;
  source: string | null;
  createdAt: string | null;
}

export interface WorkflowDefinition {
  id: string;
  key: string;
  version: number;
  status: "draft" | "active" | "deprecated" | "archived" | string;
  title: string;
  description: string | null;
  platform: string;
  intent: string;
  goal: string;
  source: string;
  parentDefinitionId: string | null;
  versionNote: string | null;
  definition: Record<string, unknown>;
  successCriteria: unknown[];
  allowedTools: string[];
  requiredCapabilities: string[];
  constraints: string[];
  fallbackRules: string[];
  rollback: Record<string, unknown>;
  policy: Record<string, unknown>;
  telemetrySummary: Record<string, unknown>;
  confidenceDecay: Record<string, unknown>;
  promotionHardening: Record<string, unknown>;
  promotion: {
    state: string;
    scope: string | null;
    note: string | null;
    promotedBy: string | null;
    promotedAt: string | null;
    revokedBy: string | null;
    revokedAt: string | null;
    confidence: number;
    readiness: Record<string, unknown>;
    scopeDetails: Record<string, unknown>;
    rollbackDefinitionId: string | null;
    rollbackPreview: Record<string, unknown>;
    reusable: boolean;
    compilerEligible: false;
    wouldUseDefinition: false;
    autoUseEnabled: false;
  };
  summary: {
    successCriteria: number;
    allowedTools: number;
    requiredCapabilities: number;
    constraints: number;
    fallbackRules: number;
  };
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinitionRegistryResponse {
  items: WorkflowDefinition[];
  total: number;
  policy: {
    readOnly: true;
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
    workflowCacheChanging: false;
    mode: string;
    [key: string]: unknown;
  };
  summary: {
    active: number;
    draft: number;
    deprecated: number;
    archived: number;
  };
}

export interface WorkflowDefinitionPromotionEvent {
  id: string;
  definitionId: string | null;
  definitionKey: string | null;
  definitionVersion: number | null;
  action: "promote_limited" | "revoke" | "rollback" | string;
  previousState: string | null;
  nextState: string | null;
  promotionScope: string | null;
  note: string | null;
  actor: string | null;
  policy: Record<string, unknown>;
  validationSnapshot: Record<string, unknown>;
  promotionConfidence: number;
  promotionReadiness: Record<string, unknown>;
  promotionScopeDetails: Record<string, unknown>;
  rollbackPreview: Record<string, unknown>;
  createdAt: string | null;
}

export interface WorkflowDefinitionPromotionResponse {
  definition: WorkflowDefinition;
  action: "promote_limited" | "revoke" | string;
  previousState: string | null;
  nextState: string;
  validationSnapshot: Record<string, unknown>;
  promotionConfidence: number;
  promotionReadiness: Record<string, unknown>;
  promotionScopeDetails: Record<string, unknown>;
  rollbackPreview: Record<string, unknown>;
  policy: Record<string, unknown>;
}

export interface WorkflowDefinitionRollbackResponse {
  action: "rollback";
  previousState: string | null;
  nextState: string;
  sourceDefinition: WorkflowDefinition;
  targetDefinition: WorkflowDefinition;
  rollbackTarget: {
    id: string;
    key: string;
    version: number;
  };
  validationSnapshot: Record<string, unknown>;
  promotionConfidence: number;
  promotionReadiness: Record<string, unknown>;
  promotionScopeDetails: Record<string, unknown>;
  rollbackPreview: Record<string, unknown>;
  policy: Record<string, unknown>;
}

export interface WorkflowDefinitionRollbackPreviewResponse {
  mode: string;
  available: boolean;
  currentDefinition: Record<string, unknown>;
  candidateTargets: Array<Record<string, unknown>>;
  selectedTarget: Record<string, unknown> | null;
  wouldRollbackNow: false;
  wouldChangePlan: false;
  wouldChangeWorkflowCache: false;
  wouldExecuteWorkflow: false;
  requiresManualRollback: true;
  notes: string[];
  policy: Record<string, unknown>;
}

export interface WorkflowDefinitionResolutionResponse {
  intent: string | null;
  platform: string | null;
  key: string | null;
  policy: Record<string, unknown>;
  outcome: string;
  candidateDefinition: WorkflowDefinition | null;
  candidateDefinitions: Array<{
    definition: WorkflowDefinition;
    score: number;
  }>;
  requestedScope?: string | null;
  wouldUseDefinition: boolean;
  wouldChangePlan: boolean;
  wouldChangeWorkflowCache: false;
  wouldExecuteWorkflow: false;
  selectedDefinitionId: string | null;
  blockers: string[];
  policyGateSummary: Record<string, unknown>;
  rollbackPreview: Record<string, unknown>;
  controlledDecision?: Record<string, unknown>;
  notes: string[];
}

export interface WorkflowDefinitionVersionEvent {
  id: string;
  definitionId: string | null;
  definitionKey: string | null;
  definitionVersion: number | null;
  action: "create_version" | "archive" | "deprecate" | "activate" | "draft" | "hardening_preview" | string;
  previousStatus: string | null;
  nextStatus: string | null;
  targetDefinitionId: string | null;
  note: string | null;
  actor: string | null;
  diff: Record<string, unknown>;
  impactPreview: Record<string, unknown>;
  policy: Record<string, unknown>;
  createdAt: string | null;
}

export interface WorkflowDefinitionVersionResponse {
  definition: WorkflowDefinition;
  diff: Record<string, unknown>;
  impactPreview: Record<string, unknown>;
  policy: Record<string, unknown>;
}

export interface CompilerPolicyGateEvent {
  id: string;
  gateId: string;
  previousState: string | null;
  nextState: string;
  version: number;
  note: string | null;
  actor: string | null;
  config: Record<string, unknown>;
  policy: Record<string, unknown>;
  createdAt: string | null;
}

export interface WorkflowValidationPipelineItem {
  definition: WorkflowDefinition;
  staticValidation: {
    mode?: string;
    state?: string;
    checks?: Array<Record<string, unknown>>;
    passed?: number;
    failed?: number;
    blockers?: string[];
    notes?: string[];
    [key: string]: unknown;
  };
  dryRun: {
    mode?: string;
    wouldUseDefinition?: false;
    wouldChangePlan?: false;
    wouldChangeWorkflowCache?: false;
    wouldExecuteWorkflow?: false;
    selectedDefinitionId?: null;
    outcome?: string;
    blockers?: string[];
    policyGateSummary?: Record<string, unknown>;
    notes?: string[];
    [key: string]: unknown;
  };
  smokeReadiness: Record<string, unknown>;
  canaryReadiness: Record<string, unknown>;
  regressionReadiness: Record<string, unknown>;
  decision: {
    outcome?: string;
    wouldPromoteDefinition?: false;
    wouldUseDefinition?: false;
    wouldExecuteWorkflow?: false;
    wouldChangePlan?: false;
    wouldChangeWorkflowCache?: false;
    safeToAutoApply?: false;
    selectedDefinitionId?: null;
    blockers?: string[];
    policyGateSummary?: Record<string, unknown>;
    notes?: string[];
    [key: string]: unknown;
  };
}

export interface WorkflowValidationPipelineResponse {
  intent: string | null;
  platform: string | null;
  key: string | null;
  policy: Record<string, unknown>;
  policyGateSummary: Record<string, unknown>;
  items: WorkflowValidationPipelineItem[];
  summary: {
    definitions?: number;
    staticPassed?: number;
    staticBlocked?: number;
    dryRunBlocked?: number;
    smokeReady?: number;
    canaryReady?: number;
    regressionReady?: number;
    wouldPromoteDefinition?: number;
    wouldUseDefinition?: number;
    wouldExecuteWorkflow?: number;
    safeToAutoApply?: number;
    [key: string]: unknown;
  };
  guardrails: string[];
}

export interface WorkflowValidationEvent {
  id: string;
  definitionId: string | null;
  definitionKey: string | null;
  definitionVersion: number | null;
  intent: string | null;
  platform: string | null;
  summary: Record<string, unknown>;
  policy: Record<string, unknown>;
  staticValidation: Record<string, unknown>;
  dryRun: Record<string, unknown>;
  smokeReadiness: Record<string, unknown>;
  canaryReadiness: Record<string, unknown>;
  regressionReadiness: Record<string, unknown>;
  decision: Record<string, unknown>;
  actor: string | null;
  source: string | null;
  createdAt: string | null;
}

export interface WorkflowRun {
  id: string;
  clientId: string | null;
  accountId: string | null;
  deviceId: string | null;
  shortDeviceId: string | null;
  taskId: string | null;
  workflowId: string | null;
  platform: string;
  intent: string;
  safetyClass: string;
  requestKey: string | null;
  cacheKey: string | null;
  canonicalWorkflowId: string;
  canonicalWorkflowVersion: string;
  compiledPlanHash: string;
  status: string;
  artifactState?: string | null;
  workflowStatus?: string | null;
  output: Record<string, unknown>;
  tokenUsage: Record<string, unknown>;
  recoveryRequests: number;
  error: string | null;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  accountUsername: string | null;
  accountPlatform: string | null;
  clientName: string | null;
  deviceName: string | null;
  feedback: WorkflowRunFeedback | null;
  timeline?: WorkflowRunTimelineStep[];
  stepCandidates?: WorkflowRunStepCandidate[];
  rootError?: { code: string | null; message: string | null; details: Record<string, unknown> };
  statePath?: Array<Record<string, unknown>>;
  transitionTelemetry?: Array<Record<string, unknown>>;
  lastObservedState?: unknown;
  learningDelta?: Record<string, unknown>;
  lastEvidence?: Record<string, unknown>;
}

// ─── API ──────────────────────────────────────────────────────────────────────

export const agencyApi = {
  humanWorkflow: {
    compile: (data: HumanWorkflowCompileRequest) =>
      api.post<HumanWorkflowCompileResult>("/workflows/human/compile", data),
    getCompileJob: (id: string) =>
      api.get<HumanWorkflowCompileJobResult>(`/workflows/human/compile-jobs/${id}`),
    retryCompileJob: (id: string) =>
      api.post<HumanWorkflowCompileJobPendingResult>(`/workflows/human/compile-jobs/${id}/retry`, {}),
    run: (data: HumanWorkflowRunRequest) => {
      const { device_id, account_id, intent, requestKey, cacheKey, compileJobId } = data;
      return api.post<HumanWorkflowRunResult>("/workflows/human/run", {
        device_id,
        account_id,
        intent,
        requestKey,
        cacheKey,
        compileJobId,
      });
    },
    getRun: (id: string) => api.get<AgencyWorkflowRun>(`/agency/workflow-runs/${id}`),
  },

  workflowRuns: {
    list: (params?: { page?: number; pageSize?: number; status?: string; requestKey?: string; cacheKey?: string; deviceId?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.status) query.set("status", params.status);
      if (params?.requestKey) query.set("requestKey", params.requestKey);
      if (params?.cacheKey) query.set("cacheKey", params.cacheKey);
      if (params?.deviceId) query.set("deviceId", params.deviceId);
      return api.get<PaginatedResponse<WorkflowRun>>(`/agency/workflow-runs?${query}`);
    },
    get: (id: string) => api.get<WorkflowRun>(`/agency/workflow-runs/${id}`),
    submitFeedback: (
      id: string,
      data: { rating: WorkflowRunFeedbackRating; lastGoodStepIndex?: number | null; note?: string | null }
    ) => api.post<WorkflowRun>(`/agency/workflow-runs/${id}/feedback`, data),
    listStepCandidates: (params?: { page?: number; pageSize?: number; state?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.state) query.set("state", params.state);
      return api.get<PaginatedResponse<WorkflowRunStepCandidate>>(`/agency/workflow-step-candidates?${query}`);
    },
    reviewStepCandidate: (
      id: string,
      data: { action: "keep_review" | "reject"; note?: string | null }
    ) => api.patch<WorkflowRunStepCandidate>(`/agency/workflow-step-candidates/${id}/review`, data),
    validateStepCandidate: (
      id: string,
      data: {
        contract: {
          preconditions: string[];
          postconditions: string[];
          inputs?: string[];
          outputs?: string[];
          sideEffects?: string[];
          compatibility?: Record<string, unknown>;
        };
        evidence: Record<string, unknown>;
        note?: string | null;
      }
    ) => api.patch<WorkflowRunStepCandidate>(`/agency/workflow-step-candidates/${id}/validate`, data),
  },

  stepLibrary: {
    list: (params?: { page?: number; pageSize?: number; action?: string; intent?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.action) query.set("action", params.action);
      if (params?.intent) query.set("intent", params.intent);
      return api.get<PaginatedResponse<StepLibraryEntry>>(`/agency/step-library?${query}`);
    },
    updatePromotion: (
      id: string,
      data: { action: "promote_limited" | "revoke"; scope?: string | null; note?: string | null }
    ) => api.patch<StepLibraryEntry>(`/agency/step-library/${id}/promotion`, data),
    listPromotionEvents: (params?: { page?: number; pageSize?: number; entryId?: string; action?: string; actor?: string; scope?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.entryId) query.set("entryId", params.entryId);
      if (params?.action) query.set("action", params.action);
      if (params?.actor) query.set("actor", params.actor);
      if (params?.scope) query.set("scope", params.scope);
      return api.get<PaginatedResponse<StepLibraryPromotionEvent>>(`/agency/step-library/promotion-events?${query}`);
    },
  },

  toolCatalog: {
    list: (params?: { category?: string; risk?: string; source?: string }) => {
      const query = new URLSearchParams();
      if (params?.category) query.set("category", params.category);
      if (params?.risk) query.set("risk", params.risk);
      if (params?.source) query.set("source", params.source);
      return api.get<ToolCatalogResponse>(`/agency/tool-catalog?${query}`);
    },
  },

  compilerKnowledge: {
    list: (params?: { type?: string; domain?: string; risk?: string; source?: string }) => {
      const query = new URLSearchParams();
      if (params?.type) query.set("type", params.type);
      if (params?.domain) query.set("domain", params.domain);
      if (params?.risk) query.set("risk", params.risk);
      if (params?.source) query.set("source", params.source);
      return api.get<CompilerKnowledgeResponse>(`/agency/compiler-knowledge?${query}`);
    },
  },

  compilerPolicyGates: {
    list: (params?: { category?: string; state?: string; risk?: string; owner?: string }) => {
      const query = new URLSearchParams();
      if (params?.category) query.set("category", params.category);
      if (params?.state) query.set("state", params.state);
      if (params?.risk) query.set("risk", params.risk);
      if (params?.owner) query.set("owner", params.owner);
      return api.get<CompilerPolicyGatesResponse>(`/agency/compiler-policy-gates?${query}`);
    },
    update: (gateId: string, data: { state: "blocked" | "review_ready" | "enabled"; note?: string | null; config?: Record<string, unknown> }) =>
      api.patch<{ gate: CompilerPolicyGate; previousState: string; nextState: string; policy: Record<string, unknown> }>(`/agency/compiler-policy-gates/${gateId}`, data),
    listEvents: (params?: { page?: number; pageSize?: number; gateId?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.gateId) query.set("gateId", params.gateId);
      return api.get<PaginatedResponse<CompilerPolicyGateEvent>>(`/agency/compiler-policy-gates/events?${query}`);
    },
  },

  compilerAwareness: {
    get: (params?: { intent?: string; action?: string }) => {
      const query = new URLSearchParams();
      if (params?.intent) query.set("intent", params.intent);
      if (params?.action) query.set("action", params.action);
      return api.get<CompilerAwarenessResponse>(`/agency/compiler-awareness?${query}`);
    },
    listEvents: (params?: { page?: number; pageSize?: number; intent?: string; action?: string; source?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.intent) query.set("intent", params.intent);
      if (params?.action) query.set("action", params.action);
      if (params?.source) query.set("source", params.source);
      return api.get<PaginatedResponse<CompilerAwarenessEvent> & { policy: Record<string, unknown> }>(`/agency/compiler-awareness/events?${query}`);
    },
  },

  compilerControlPlane: {
    get: (params?: { intent?: string; action?: string; deviceId?: string; scope?: string }) => {
      const query = new URLSearchParams();
      if (params?.intent) query.set("intent", params.intent);
      if (params?.action) query.set("action", params.action);
      if (params?.deviceId) query.set("deviceId", params.deviceId);
      if (params?.scope) query.set("scope", params.scope);
      return api.get<CompilerControlPlaneResponse>(`/agency/compiler-control-plane?${query}`);
    },
    listEvents: (params?: { page?: number; pageSize?: number; intent?: string; action?: string; deviceId?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.intent) query.set("intent", params.intent);
      if (params?.action) query.set("action", params.action);
      if (params?.deviceId) query.set("deviceId", params.deviceId);
      return api.get<PaginatedResponse<CompilerControlPlaneEvent> & { policy: Record<string, unknown> }>(`/agency/compiler-control-plane/events?${query}`);
    },
  },

  workflowDefinitions: {
    list: (params?: { status?: string; platform?: string; intent?: string; key?: string }) => {
      const query = new URLSearchParams();
      if (params?.status) query.set("status", params.status);
      if (params?.platform) query.set("platform", params.platform);
      if (params?.intent) query.set("intent", params.intent);
      if (params?.key) query.set("key", params.key);
      return api.get<WorkflowDefinitionRegistryResponse>(`/agency/workflow-definitions?${query}`);
    },
    resolve: (params?: { intent?: string; platform?: string; key?: string; scope?: string }) => {
      const query = new URLSearchParams();
      if (params?.intent) query.set("intent", params.intent);
      if (params?.platform) query.set("platform", params.platform);
      if (params?.key) query.set("key", params.key);
      if (params?.scope) query.set("scope", params.scope);
      return api.get<WorkflowDefinitionResolutionResponse>(`/agency/workflow-definitions/resolve?${query}`);
    },
    versions: (id: string) =>
      api.get<{ items: WorkflowDefinition[]; total: number; policy: Record<string, unknown> }>(`/agency/workflow-definitions/${id}/versions`),
    createVersion: (id: string, data: {
      status?: "draft" | "active";
      title?: string;
      description?: string | null;
      goal?: string;
      note?: string | null;
      definition?: Record<string, unknown>;
      successCriteria?: unknown[];
      allowedTools?: string[];
      requiredCapabilities?: string[];
      constraints?: string[];
      fallbackRules?: string[];
      rollback?: Record<string, unknown>;
    }) => api.post<WorkflowDefinitionVersionResponse>(`/agency/workflow-definitions/${id}/versions`, data),
    diff: (id: string, targetId?: string) => {
      const query = new URLSearchParams();
      if (targetId) query.set("targetId", targetId);
      return api.get<Record<string, unknown>>(`/agency/workflow-definitions/${id}/diff?${query}`);
    },
    impactPreview: (id: string) =>
      api.get<Record<string, unknown>>(`/agency/workflow-definitions/${id}/impact-preview`),
    hardening: (id: string, scope?: string) => {
      const query = new URLSearchParams();
      if (scope) query.set("scope", scope);
      return api.get<Record<string, unknown>>(`/agency/workflow-definitions/${id}/promotion-hardening?${query}`);
    },
    lifecycle: (id: string, data: { action: "archive" | "deprecate" | "activate" | "draft"; note?: string | null }) =>
      api.patch<{ definition: WorkflowDefinition; action: string; previousStatus: string; nextStatus: string; impactPreview: Record<string, unknown>; policy: Record<string, unknown> }>(`/agency/workflow-definitions/${id}/lifecycle`, data),
    promote: (id: string, data: { action: "promote_limited" | "revoke"; scope?: string | null; note?: string | null }) =>
      api.patch<WorkflowDefinitionPromotionResponse>(`/agency/workflow-definitions/${id}/promotion`, data),
    rollback: (id: string, data: { targetDefinitionId?: string | null; note?: string | null }) =>
      api.post<WorkflowDefinitionRollbackResponse>(`/agency/workflow-definitions/${id}/rollback`, data),
    rollbackPreview: (id: string) =>
      api.get<WorkflowDefinitionRollbackPreviewResponse>(`/agency/workflow-definitions/${id}/rollback-preview`),
    listPromotionEvents: (params?: { page?: number; pageSize?: number; definitionId?: string; key?: string; action?: string; actor?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.definitionId) query.set("definitionId", params.definitionId);
      if (params?.key) query.set("key", params.key);
      if (params?.action) query.set("action", params.action);
      if (params?.actor) query.set("actor", params.actor);
      return api.get<PaginatedResponse<WorkflowDefinitionPromotionEvent> & { policy: Record<string, unknown> }>(`/agency/workflow-definitions/promotion-events?${query}`);
    },
    listVersionEvents: (params?: { page?: number; pageSize?: number; definitionId?: string; key?: string; action?: string; actor?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.definitionId) query.set("definitionId", params.definitionId);
      if (params?.key) query.set("key", params.key);
      if (params?.action) query.set("action", params.action);
      if (params?.actor) query.set("actor", params.actor);
      return api.get<PaginatedResponse<WorkflowDefinitionVersionEvent> & { policy: Record<string, unknown> }>(`/agency/workflow-definitions/version-events?${query}`);
    },
  },

  workflowValidationPipeline: {
    get: (params?: { intent?: string; platform?: string; key?: string }) => {
      const query = new URLSearchParams();
      if (params?.intent) query.set("intent", params.intent);
      if (params?.platform) query.set("platform", params.platform);
      if (params?.key) query.set("key", params.key);
      return api.get<WorkflowValidationPipelineResponse>(`/agency/workflow-validation-pipeline?${query}`);
    },
    listEvents: (params?: { page?: number; pageSize?: number; intent?: string; platform?: string; key?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.intent) query.set("intent", params.intent);
      if (params?.platform) query.set("platform", params.platform);
      if (params?.key) query.set("key", params.key);
      return api.get<PaginatedResponse<WorkflowValidationEvent> & { policy: Record<string, unknown> }>(`/agency/workflow-validation-pipeline/events?${query}`);
    },
  },

  // Clients
  clients: {
    list: (params?: { page?: number; pageSize?: number; active?: boolean; type?: 'client' | 'farming' }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.active !== undefined) query.set("active", String(params.active));
      if (params?.type) query.set("type", params.type);
      return api.get<PaginatedResponse<Client>>(`/agency/clients?${query}`);
    },
    get: (id: string) => api.get<Client>(`/agency/clients/${id}`),
    create: (data: { name: string; strategy?: Record<string, unknown>; type?: 'client' | 'farming' }) =>
      api.post<Client>("/agency/clients", data),
    update: (id: string, data: { name?: string; active?: boolean; strategy?: Record<string, unknown> }) =>
      api.patch<Client>(`/agency/clients/${id}`, data),
  },

  // Materials
  materials: {
    list: (params?: { page?: number; pageSize?: number; clientId?: string; used?: boolean }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.clientId) query.set("clientId", params.clientId);
      if (params?.used !== undefined) query.set("used", String(params.used));
      return api.get<PaginatedResponse<Material>>(`/agency/materials?${query}`);
    },
    upload: async (file: File, data?: { clientId?: string; accountId?: string; description?: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (data?.clientId) formData.append("clientId", data.clientId);
      if (data?.accountId) formData.append("accountId", data.accountId);
      if (data?.description) formData.append("description", data.description);

      const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";
      const token = localStorage.getItem("access_token");
      const res = await fetch(`${BASE_URL}/agency/materials`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Upload failed");
      return json.data as Material;
    },
    update: (id: string, data: { used?: boolean; description?: string }) =>
      api.patch<Material>(`/agency/materials/${id}`, data),
    delete: (id: string) => api.delete<{ deleted: boolean }>(`/agency/materials/${id}`),
  },

  // Posts
  posts: {
    list: (params?: { page?: number; pageSize?: number; status?: string; accountId?: string; from?: string; to?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.status) query.set("status", params.status);
      if (params?.accountId) query.set("accountId", params.accountId);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      return api.get<PaginatedResponse<Post>>(`/agency/posts?${query}`);
    },
    get: (id: string) => api.get<Post>(`/agency/posts/${id}`),
    approve: (id: string) => api.patch<Post>(`/agency/posts/${id}`, { status: "approved" }),
    reject: (id: string) => api.patch<Post>(`/agency/posts/${id}`, { status: "rejected" }),
    update: (id: string, data: { status?: Post["status"]; content?: Post["content"] }) =>
      api.patch<Post>(`/agency/posts/${id}`, data),
  },

  // Tasks
  tasks: {
    list: (params?: { page?: number; pageSize?: number; status?: string; deviceId?: string; accountId?: string; from?: string; to?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.status) query.set("status", params.status);
      if (params?.deviceId) query.set("deviceId", params.deviceId);
      if (params?.accountId) query.set("accountId", params.accountId);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      return api.get<PaginatedResponse<Task>>(`/agency/tasks?${query}`);
    },
    pause: (id: string) => api.patch<Task>(`/agency/tasks/${id}`, { status: "paused" }),
    resume: (id: string) => api.patch<Task>(`/agency/tasks/${id}`, { status: "queued" }),
  },

  // Reports
  reports: {
    list: (params?: { page?: number; pageSize?: number; type?: string; from?: string; to?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.type) query.set("type", params.type);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      return api.get<PaginatedResponse<Report>>(`/agency/reports?${query}`);
    },
    stats: () => api.get<AgencyStats>("/agency/reports/stats"),
  },
};
