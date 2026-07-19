import type { ActionStep, DeviceStepVerificationContract, WorkflowStep, WorkflowTemplate } from "../workflows/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function humanAskRedditHotIntent(intent: string): boolean {
  const normalized = intent.toLowerCase();
  return (
    (normalized.includes("askreddit") || normalized.includes("/r/askreddit")) &&
    /\bhot\b|\bhottest\b|\bfierbinte\b|\bpopular\b/.test(normalized)
  );
}

function normalizeAskRedditHotUri(uri: string): string {
  if (!/reddit\.com\/r\/askreddit/i.test(uri)) return uri;
  return "https://www.reddit.com/r/AskReddit/hot/";
}

function isExplicitBrowserWorkflowIntent(intent: string): boolean {
  const normalized = intent.toLowerCase();
  return /\b(browser|chrome|gmail\.com|web)\b/.test(normalized) || /https?:\/\//.test(normalized);
}

function isGmailAppWorkflowIntent(intent: string): boolean {
  const normalized = intent.toLowerCase();
  return (/\bgmail\b/.test(normalized) || normalized.includes("com.google.android.gm"))
    && !isExplicitBrowserWorkflowIntent(intent);
}

function isBrowserWorkflowIntent(intent: string): boolean {
  return isExplicitBrowserWorkflowIntent(intent);
}

function isBrowserPackageName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "android" || normalized === "browser" || normalized === "chrome" || normalized === "com.android.chrome";
}

function normalizeBrowserWorkflow<T>(workflow: T, intent: string): T {
  if (!isBrowserWorkflowIntent(intent) || !isRecord(workflow) || !Array.isArray(workflow.steps)) return workflow;
  const hasWebIntent = workflow.steps.some((step) => {
    if (!isRecord(step) || step.type !== "action" || step.action !== "intent_send") return false;
    const params = isRecord(step.params) ? step.params : {};
    return typeof params.uri === "string" && /^https?:\/\//i.test(params.uri.trim());
  });
  const steps = workflow.steps
    .filter((step) => {
      if (!hasWebIntent || !isRecord(step) || step.type !== "action" || step.action !== "open_app") return true;
      const params = isRecord(step.params) ? step.params : {};
      return !isBrowserPackageName(params.packageName);
    })
    .map((step) => {
      if (!isRecord(step) || step.type !== "action" || step.action !== "intent_send") return step;
      const params = isRecord(step.params) ? { ...step.params } : {};
      if (typeof params.uri === "string" && /^https?:\/\//i.test(params.uri.trim())) {
        delete params.packageName;
      }
      return { ...step, params };
    });
  return { ...workflow, steps } as T;
}

function isGmailWebUri(value: unknown): boolean {
  return typeof value === "string" && /https?:\/\/([^/]+\.)?(mail|accounts|workspace)\.google\.com\b/i.test(value.trim());
}

function normalizeGmailAppWorkflow<T>(workflow: T, intent: string): T {
  if (!isGmailAppWorkflowIntent(intent) || !isRecord(workflow) || !Array.isArray(workflow.steps)) return workflow;
  const steps = workflow.steps.map((step) => {
    if (!isRecord(step) || step.type !== "action") return step;
    const normalized = { ...step };
    const params = isRecord(normalized.params) ? { ...normalized.params } : {};
    if (normalized.action === "open_app" && isBrowserPackageName(params.packageName)) {
      normalized.params = { ...params, packageName: "com.google.android.gm" };
      return normalized;
    }
    if (normalized.action === "intent_send" && isGmailWebUri(params.uri)) {
      normalized.action = "open_app";
      normalized.params = { packageName: "com.google.android.gm" };
      return normalized;
    }
    return normalized;
  });
  return { ...workflow, steps } as T;
}

export function normalizeHumanWorkflowForKnownRedditTargets<T>(
  workflow: T,
  input: { intent: string; packageName: string },
): T {
  if (!humanAskRedditHotIntent(input.intent) || !isRecord(workflow) || !Array.isArray(workflow.steps)) {
    return workflow;
  }

  const steps = workflow.steps
    .map((step) => {
      if (!isRecord(step)) return step;
      const normalized = { ...step };
      const params = isRecord(normalized.params) ? { ...normalized.params } : null;
      if (params && typeof params.uri === "string") {
        params.uri = normalizeAskRedditHotUri(params.uri);
        params.packageName = typeof params.packageName === "string" ? params.packageName : input.packageName;
        normalized.params = params;
      }
      return normalized;
    })
    .filter((step) => {
      if (!isRecord(step) || step.type !== "action" || step.action !== "semantic_tap") return true;
      const params = isRecord(step.params) ? step.params : {};
      return params.target !== "reddit_home_feed.subreddit_toolbar_search_button";
    });

  return { ...workflow, steps } as T;
}

export function normalizeCachedHumanWorkflowTemplate(
  workflow: WorkflowTemplate,
  sourceMetadata: Record<string, unknown> | null | undefined,
): WorkflowTemplate {
  if (sourceMetadata?.source !== "dashboard_human") return attachDeviceVerificationContracts(workflow, sourceMetadata);
  const intent = typeof sourceMetadata.intent === "string" ? sourceMetadata.intent : "";
  const packageName = workflow.platform === "reddit" ? "com.reddit.frontpage" : workflow.platform;
  const gmailNormalized = normalizeGmailAppWorkflow(workflow, intent);
  const browserNormalized = normalizeBrowserWorkflow(gmailNormalized, intent);
  return attachDeviceVerificationContracts(
    normalizeHumanWorkflowForKnownRedditTargets(browserNormalized, { intent, packageName }),
    sourceMetadata,
  );
}

function requiredContract(
  postconditions: DeviceStepVerificationContract["postconditions"],
  options: Partial<DeviceStepVerificationContract> = {},
): DeviceStepVerificationContract {
  return { required: true, settleMs: 100, postconditions, ...options };
}

function inferredTargetPackage(
  workflow: WorkflowTemplate,
  metadata: Record<string, unknown> | null | undefined,
  step: ActionStep,
): string | null {
  const params = isRecord(step.params) ? step.params : {};
  if (typeof params.expectedPackage === "string" && params.expectedPackage.trim()) return params.expectedPackage.trim();
  if (typeof params.packageName === "string" && params.packageName.trim()) return params.packageName.trim();
  const intent = typeof metadata?.intent === "string" ? metadata.intent : workflow.intent ?? "";
  if (step.action === "intent_send" && (isExplicitBrowserWorkflowIntent(intent) || /^https?:\/\//i.test(String(params.uri ?? "")))) {
    return "com.android.chrome";
  }
  const packages: Record<string, string> = {
    reddit: "com.reddit.frontpage",
    instagram: "com.instagram.android",
    tiktok: "com.zhiliaoapp.musically",
    twitter: "com.twitter.android",
    gmail: "com.google.android.gm",
    chrome: "com.android.chrome",
    browser: "com.android.chrome",
  };
  return packages[workflow.platform.toLowerCase()] ?? null;
}

function defaultDeviceVerification(
  workflow: WorkflowTemplate,
  metadata: Record<string, unknown> | null | undefined,
  step: ActionStep,
): DeviceStepVerificationContract | undefined {
  const targetPackage = inferredTargetPackage(workflow, metadata, step);
  switch (step.action) {
    case "screen_wake":
      return requiredContract([{ path: "screen.interactive", expected: true }], {
        settleMs: 150,
        retryPolicy: { maxAttempts: 2, backoffMs: [250] },
      });
    case "unlock":
      return requiredContract([{ path: "keyguard.locked", expected: false }], {
        settleMs: 400,
        preconditions: [{ path: "screen.interactive", expected: true }],
        retryPolicy: { maxAttempts: 3, backoffMs: [300, 700] },
      });
    case "open_app":
    case "intent_send":
      return targetPackage
        ? requiredContract([{ path: "foreground.package", expected: targetPackage }], { settleMs: 300 })
        : undefined;
    case "ui_tree_dump":
      return requiredContract([{ path: "result.uiTreeValid", expected: true }]);
    case "screenshot":
      return requiredContract([{ path: "result.imagePresent", expected: true }]);
    case "get_screen_state":
      return requiredContract([{ path: "result.state", operator: "exists" }]);
    case "get_foreground_app":
      return requiredContract([{ path: "result.packageName", operator: "exists" }]);
    default:
      return undefined;
  }
}

/** Adds device-local contracts without changing the workflow's step topology. */
export function attachDeviceVerificationContracts(
  workflow: WorkflowTemplate,
  metadata?: Record<string, unknown> | null,
): WorkflowTemplate {
  const attach = (step: WorkflowStep): WorkflowStep => {
    if (step.type !== "action") return step;
    if (step.deviceVerification) return step;
    const contract = defaultDeviceVerification(workflow, metadata, step);
    return contract ? { ...step, deviceVerification: contract } : step;
  };
  return { ...workflow, steps: workflow.steps.map(attach) };
}
