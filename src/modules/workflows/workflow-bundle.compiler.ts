import type { ActionStep, WorkflowStep, WorkflowTemplate } from "./types";

export const DEVICE_BUNDLE_VERSION = "device-bundle-v1";
export const HBE_POLICY_VERSION = "compile-time-hbe-v1";

export interface DeviceBundleCompileOptions {
  workflowId: string;
  now?: Date;
  deadlineMs?: number;
  browserSocialHbeOptIn?: boolean;
}

export interface DeviceBundleTemplate extends WorkflowTemplate {
  workflowId: string;
  executionMode: "device_bundle";
  bundleVersion: string;
  hbePolicyVersion: string;
  hbeCompiled: true;
  deadlineAt: string;
  checkpointPolicy: { emitEveryStep: true; retainUntilAck: true };
  reportPolicy: { emitTerminalResult: true };
  errorPolicy: { unsupportedAction: "hard_fail"; packageMismatch: "skip_human_delay" };
  observability: { dispatchCountKey: string; hbePolicyVersion: string };
}

const TECHNICAL_ACTIONS = new Set([
  "screen_wake", "screen_off", "unlock", "intent_send", "open_app", "close_app",
  "press_back", "press_home", "press_recent", "press_key", "keyevent", "screenshot",
  "screenshot_for_vlm", "ui_tree_dump", "get_screen_state", "get_foreground_app",
  "wait_for_idle", "detect_current_screen",
]);
const VISIBLE_HUMAN_ACTIONS = new Set([
  "tap", "swipe", "scroll", "type", "type_text", "set_focused_text", "a11y_find_tap",
  "ocr_find_tap", "long_press", "double_tap",
]);
const NATIVE_SOCIAL_PACKAGES = new Set([
  "com.reddit.frontpage", "com.instagram.android", "com.zhiliaoapp.musically",
  "com.facebook.katana", "com.twitter.android",
]);
const BROWSER_PACKAGES = new Set([
  "com.android.chrome", "org.mozilla.firefox", "com.microsoft.emmx",
]);
const PLATFORM_PACKAGES: Record<string, string> = {
  reddit: "com.reddit.frontpage", instagram: "com.instagram.android",
  tiktok: "com.zhiliaoapp.musically", facebook: "com.facebook.katana",
  twitter: "com.twitter.android", x: "com.twitter.android",
  chrome: "com.android.chrome", browser: "com.android.chrome",
};
const DEVICE_LOCAL_ACTIONS = new Set([
  ...TECHNICAL_ACTIONS, ...VISIBLE_HUMAN_ACTIONS, "set_variable",
  "classify_reddit_health_scan", "increment", "decrement", "reset_counter",
  "append_to_list", "mark_processed", "random_delay", "forced_pause",
  "branch_on_decision", "conditional_pause",
]);
const SERVER_ONLY_ACTIONS = new Set([
  "semantic_tap", "cascade_tap", "ensure_on_screen", "vlm_analyze_post_for_outreach",
  "vlm_generate_comment", "detect_current_screen", "run_loop", "for_each",
]);

function packageFromStep(step: ActionStep, template: WorkflowTemplate): string {
  const direct = step.params?.packageName ?? step.params?.package;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return PLATFORM_PACKAGES[String(template.platform ?? "").toLowerCase()] ?? "";
}

function isDeviceLocalStep(step: WorkflowStep): boolean {
  if (step.type === "action") return DEVICE_LOCAL_ACTIONS.has(step.action) && !SERVER_ONLY_ACTIONS.has(step.action);
  if (step.type === "condition") return step.if_true.every(isDeviceLocalStep) && (step.if_false ?? []).every(isDeviceLocalStep);
  if (step.type === "loop") return step.steps.every(isDeviceLocalStep);
  return step.type === "wait" || step.type === "checkpoint";
}

export function canCompileDeviceBundle(template: WorkflowTemplate): boolean {
  return template.steps.every(isDeviceLocalStep);
}

export function humanDelayForStep(
  step: ActionStep,
  template: WorkflowTemplate,
  options: Pick<DeviceBundleCompileOptions, "browserSocialHbeOptIn"> = {},
): ActionStep | null {
  if (TECHNICAL_ACTIONS.has(step.action) || !VISIBLE_HUMAN_ACTIONS.has(step.action)) return null;
  const requiredPackage = packageFromStep(step, template);
  if (!requiredPackage) return null;
  const browser = BROWSER_PACKAGES.has(requiredPackage);
  if (browser && !options.browserSocialHbeOptIn) return null;
  if (!browser && !NATIVE_SOCIAL_PACKAGES.has(requiredPackage)) return null;
  return {
    type: "action", id: `${step.id ?? step.action}__human_delay`, action: "human_delay",
    timeoutMs: 4_000,
    params: { minMs: 750, maxMs: 2_400, distribution: "lognormal",
      reason: `social_visible_${step.action}`, requiredPackage },
  };
}

function compileSteps(steps: WorkflowStep[], template: WorkflowTemplate, options: DeviceBundleCompileOptions): WorkflowStep[] {
  const compiled: WorkflowStep[] = [];
  for (const step of steps) {
    if (step.type === "condition") {
      compiled.push({ ...step, if_true: compileSteps(step.if_true, template, options),
        if_false: compileSteps(step.if_false ?? [], template, options) });
      continue;
    }
    if (step.type === "loop") {
      compiled.push({ ...step, steps: compileSteps(step.steps, template, options) });
      continue;
    }
    compiled.push(step);
    if (step.type === "action") {
      const delay = humanDelayForStep(step, template, options);
      if (delay) compiled.push(delay);
    }
  }
  return compiled;
}

export function compileDeviceWorkflowBundle(template: WorkflowTemplate, options: DeviceBundleCompileOptions): DeviceBundleTemplate {
  if (!canCompileDeviceBundle(template)) throw new Error(`Workflow ${template.id} contains steps unsupported by device_bundle`);
  const now = options.now ?? new Date();
  return {
    ...template,
    workflowId: options.workflowId,
    executionMode: "device_bundle",
    bundleVersion: DEVICE_BUNDLE_VERSION,
    hbePolicyVersion: HBE_POLICY_VERSION,
    hbeCompiled: true,
    deadlineAt: new Date(now.getTime() + (options.deadlineMs ?? 10 * 60_000)).toISOString(),
    steps: compileSteps(template.steps, template, options),
    checkpointPolicy: { emitEveryStep: true, retainUntilAck: true },
    reportPolicy: { emitTerminalResult: true },
    errorPolicy: { unsupportedAction: "hard_fail", packageMismatch: "skip_human_delay" },
    observability: {
      dispatchCountKey: `${options.workflowId}:${DEVICE_BUNDLE_VERSION}`,
      hbePolicyVersion: HBE_POLICY_VERSION,
    },
  };
}
