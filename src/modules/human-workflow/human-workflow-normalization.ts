import type { WorkflowTemplate } from "../workflows/types";

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
  if (sourceMetadata?.source !== "dashboard_human") return workflow;
  const intent = typeof sourceMetadata.intent === "string" ? sourceMetadata.intent : "";
  const packageName = workflow.platform === "reddit" ? "com.reddit.frontpage" : workflow.platform;
  const gmailNormalized = normalizeGmailAppWorkflow(workflow, intent);
  const browserNormalized = normalizeBrowserWorkflow(gmailNormalized, intent);
  return normalizeHumanWorkflowForKnownRedditTargets(browserNormalized, { intent, packageName });
}
