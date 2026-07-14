export type ToolCatalogRisk = "low" | "medium" | "high";
export type ToolCatalogSource = "device_job" | "workflow_runtime" | "server_skill";

export interface ToolCatalogEntry {
  id: string;
  name: string;
  source: ToolCatalogSource;
  category: "device_control" | "observation" | "navigation" | "input" | "workflow" | "content" | "safety";
  description: string;
  risk: ToolCatalogRisk;
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
function policy(input: {
  readOnly: boolean;
  mutating?: boolean;
  destructive?: boolean;
  externalAction?: boolean;
}): ToolCatalogEntry["policy"] {
  return {
    readOnly: input.readOnly,
    mutating: input.mutating ?? !input.readOnly,
    destructive: input.destructive ?? false,
    externalAction: input.externalAction ?? false,
    compilerVisible: false,
    autoUseEnabled: false,
  };
}

const device = (entry: Omit<ToolCatalogEntry, "source" | "requiresDevice" | "availability">): ToolCatalogEntry => ({
  ...entry,
  source: "device_job",
  requiresDevice: true,
  availability: { directWs: true, edgeWorkflow: true, serverRuntime: false },
});

const serverSkill = (entry: Omit<ToolCatalogEntry, "source" | "requiresDevice" | "availability">): ToolCatalogEntry => ({
  ...entry,
  source: "server_skill",
  requiresDevice: true,
  availability: { directWs: true, edgeWorkflow: false, serverRuntime: true },
});

const workflowRuntime = (entry: Omit<ToolCatalogEntry, "source" | "requiresDevice" | "availability">): ToolCatalogEntry => ({
  ...entry,
  source: "workflow_runtime",
  requiresDevice: false,
  availability: { directWs: false, edgeWorkflow: true, serverRuntime: true },
});

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  device({
    id: "screen_wake",
    name: "Wake screen",
    category: "device_control",
    description: "Wake the device screen before a workflow starts.",
    risk: "low",
    sideEffects: ["screen_state"],
    inputSchema: { required: [], optional: [] },
    outputSchema: { produces: ["wake_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Often used as a workflow precondition step."],
  }),
  device({
    id: "unlock",
    name: "Unlock device",
    category: "device_control",
    description: "Unlock the device using the configured agent unlock path.",
    risk: "medium",
    sideEffects: ["device_unlocked"],
    inputSchema: { required: [], optional: [] },
    outputSchema: { produces: ["unlock_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Requires trusted device setup; validated Step Library entries do not enable compiler auto-use."],
  }),
  device({
    id: "open_app",
    name: "Open app",
    category: "navigation",
    description: "Open an installed Android package, optionally with a URI.",
    risk: "medium",
    sideEffects: ["foreground_app_change"],
    inputSchema: { required: ["packageName"], optional: ["uri"] },
    outputSchema: { produces: ["launch_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Package allow/block policy stays in workflow validation and execution layers."],
  }),
  device({
    id: "intent_send",
    name: "Send Android intent",
    category: "navigation",
    description: "Open a URI or app surface through an explicit Android intent.",
    risk: "medium",
    sideEffects: ["foreground_app_change", "deep_link_navigation"],
    inputSchema: { required: ["uri"], optional: ["packageName"] },
    outputSchema: { produces: ["intent_status"] },
    policy: policy({ readOnly: false, mutating: true, externalAction: true }),
    notes: ["Can leave the current app context; must stay scope-gated."],
  }),
  device({
    id: "tap",
    name: "Tap",
    category: "input",
    description: "Tap a coordinate or resolved selector on the device screen.",
    risk: "high",
    sideEffects: ["ui_interaction"],
    inputSchema: { required: [], optional: ["x", "y", "selectorName", "selectorId"] },
    outputSchema: { produces: ["tap_status"] },
    policy: policy({ readOnly: false, mutating: true, externalAction: true }),
    notes: ["Potentially performs real external actions depending on current screen."],
  }),
  device({
    id: "semantic_tap",
    name: "Semantic tap",
    category: "input",
    description: "Resolve a semantic app-map/UI target and tap it.",
    risk: "high",
    sideEffects: ["ui_interaction"],
    inputSchema: { required: ["target"], optional: ["waitMs"] },
    outputSchema: { produces: ["tap_status", "resolution_trace"] },
    policy: policy({ readOnly: false, mutating: true, externalAction: true }),
    notes: ["Requires app-map or UI-tree evidence; not compiler auto-eligible in this phase."],
  }),
  device({
    id: "a11y_find_tap",
    name: "A11y find tap",
    category: "input",
    description: "Find an accessibility node by text/description and tap it.",
    risk: "high",
    sideEffects: ["ui_interaction"],
    inputSchema: { required: [], optional: ["text", "textContains", "contentDescription"] },
    outputSchema: { produces: ["tap_status", "matched_node"] },
    policy: policy({ readOnly: false, mutating: true, externalAction: true }),
    notes: ["Useful for repair paths; must be guarded by screen-state checks."],
  }),
  device({
    id: "type_text",
    name: "Type text",
    category: "input",
    description: "Type literal or variable-sourced text into the current focused field.",
    risk: "high",
    sideEffects: ["text_input"],
    inputSchema: { required: [], optional: ["text", "textFromVariable"] },
    outputSchema: { produces: ["type_status"] },
    policy: policy({ readOnly: false, mutating: true, externalAction: true }),
    notes: ["Timeout scales with text length in dispatcher."],
  }),
  device({
    id: "press_key",
    name: "Press key",
    category: "input",
    description: "Press a navigation or keyboard key such as BACK, HOME, or ENTER.",
    risk: "medium",
    sideEffects: ["ui_navigation"],
    inputSchema: { required: ["key"], optional: [] },
    outputSchema: { produces: ["key_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["ENTER can submit forms depending on focused field."],
  }),
  device({
    id: "swipe",
    name: "Swipe",
    category: "input",
    description: "Swipe in a direction or across coordinates.",
    risk: "medium",
    sideEffects: ["ui_navigation"],
    inputSchema: { required: [], optional: ["direction", "distancePx", "from", "to"] },
    outputSchema: { produces: ["swipe_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Can trigger infinite-scroll or navigation changes."],
  }),
  device({
    id: "scroll",
    name: "Scroll",
    category: "input",
    description: "Scroll the active surface.",
    risk: "medium",
    sideEffects: ["ui_navigation"],
    inputSchema: { required: [], optional: ["direction", "amount"] },
    outputSchema: { produces: ["scroll_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Treated separately from swipe for compiler metadata."],
  }),
  device({
    id: "wait_for_idle",
    name: "Wait for idle",
    category: "workflow",
    description: "Wait for UI/network settling between steps.",
    risk: "low",
    sideEffects: [],
    inputSchema: { required: [], optional: ["timeoutMs"] },
    outputSchema: { produces: ["wait_status"] },
    policy: policy({ readOnly: true, mutating: false }),
    notes: ["Deterministic pacing primitive."],
  }),
  device({
    id: "screenshot",
    name: "Screenshot",
    category: "observation",
    description: "Capture the current screen for evidence or visual analysis.",
    risk: "low",
    sideEffects: ["sensitive_screen_capture"],
    inputSchema: { required: [], optional: ["quality"] },
    outputSchema: { produces: ["image_artifact"] },
    policy: policy({ readOnly: true, mutating: false }),
    notes: ["Use only when visual evidence is needed."],
  }),
  device({
    id: "ui_tree_dump",
    name: "UI tree dump",
    category: "observation",
    description: "Read the accessibility tree from the current screen.",
    risk: "low",
    sideEffects: ["sensitive_ui_snapshot"],
    inputSchema: { required: [], optional: ["scope", "outputVariable"] },
    outputSchema: { produces: ["ui_tree", "output_variable"] },
    policy: policy({ readOnly: true, mutating: false }),
    notes: ["Preferred deterministic observation source for classifiers and repair."],
  }),
  device({
    id: "get_screen_state",
    name: "Get screen state",
    category: "observation",
    description: "Classify or summarize the current screen state.",
    risk: "low",
    sideEffects: ["sensitive_ui_snapshot"],
    inputSchema: { required: [], optional: ["scope"] },
    outputSchema: { produces: ["screen_state"] },
    policy: policy({ readOnly: true, mutating: false }),
    notes: ["Used by read-only health scans and verification gates."],
  }),
  device({
    id: "close_app",
    name: "Close app",
    category: "device_control",
    description: "Close or background the target app.",
    risk: "medium",
    sideEffects: ["foreground_app_change"],
    inputSchema: { required: [], optional: ["packageName"] },
    outputSchema: { produces: ["close_status"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Can interrupt active sessions."],
  }),
  workflowRuntime({
    id: "set_variable",
    name: "Set workflow variable",
    category: "workflow",
    description: "Set an internal workflow variable.",
    risk: "low",
    sideEffects: ["workflow_checkpoint_mutation"],
    inputSchema: { required: ["name", "value"], optional: [] },
    outputSchema: { produces: ["checkpoint_update"] },
    policy: policy({ readOnly: false, mutating: true }),
    notes: ["Server/runtime state only; no direct device action."],
  }),
  serverSkill({
    id: "detect_current_screen",
    name: "Detect current screen",
    category: "observation",
    description: "Run server-side screen detection using UI tree/OCR/VLM cascade as configured.",
    risk: "low",
    sideEffects: ["sensitive_ui_snapshot"],
    inputSchema: { required: [], optional: ["expectedScreen", "scope"] },
    outputSchema: { produces: ["screen_id", "confidence", "evidence"] },
    policy: policy({ readOnly: true, mutating: false }),
    notes: ["May dispatch observation jobs to the device."],
  }),
  serverSkill({
    id: "classify_reddit_health_scan",
    name: "Classify Reddit health scan",
    category: "observation",
    description: "Classify Reddit account health from observed UI state.",
    risk: "low",
    sideEffects: ["sensitive_ui_snapshot"],
    inputSchema: { required: [], optional: ["uiTreeVariable", "screenStateVariable"] },
    outputSchema: { produces: ["loggedIn", "homeFeedVisible", "screenState", "challengeDetected"] },
    policy: policy({ readOnly: true, mutating: false }),
    notes: ["Read-only business classifier used by Reddit health scan workflows."],
  }),
  serverSkill({
    id: "vlm_generate_comment",
    name: "Generate comment",
    category: "content",
    description: "Generate comment text from captured context.",
    risk: "high",
    sideEffects: ["generated_content"],
    inputSchema: { required: ["post_description_var", "target_variable"], optional: [] },
    outputSchema: { produces: ["generated_text", "checkpoint_variable"] },
    policy: policy({ readOnly: false, mutating: true, externalAction: false }),
    notes: ["Generates content only; posting remains a separate high-risk UI action."],
  }),
];

export interface ToolCatalogQuery {
  category?: string;
  risk?: string;
  source?: string;
}

export function listToolCatalog(query: ToolCatalogQuery = {}): ToolCatalogEntry[] {
  return TOOL_CATALOG.filter((entry) => {
    if (query.category && entry.category !== query.category) return false;
    if (query.risk && entry.risk !== query.risk) return false;
    if (query.source && entry.source !== query.source) return false;
    return true;
  });
}
