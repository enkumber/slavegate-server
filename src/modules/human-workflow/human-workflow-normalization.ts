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
  return normalizeHumanWorkflowForKnownRedditTargets(workflow, { intent, packageName });
}
