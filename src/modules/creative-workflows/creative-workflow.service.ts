import { randomUUID } from "crypto";
import type {
  CreativeWorkflowCreateRequest,
  CreativeWorkflowCreateResponse,
  CreativeWorkflowRun,
  CreativeWorkflowStatus,
  CreativeIntent,
  CreativeSafetyClass,
  CreativeProposal,
} from "./creative-workflow.types";

const DEFAULT_INVENTORY = [
  { intent: "account_scan" as CreativeIntent, safetyClass: "read_only" as CreativeSafetyClass, summary: "Scan account health, feed activity, and engagement patterns" },
  { intent: "health_check" as CreativeIntent, safetyClass: "read_only" as CreativeSafetyClass, summary: "Quick health check of account: login, feed, search surface, blockers" },
  { intent: "strategy_review" as CreativeIntent, safetyClass: "read_only" as CreativeSafetyClass, summary: "Review current strategy, content direction, and competitor signals" },
  { intent: "engagement_boost" as CreativeIntent, safetyClass: "light" as CreativeSafetyClass, summary: "Boost engagement via targeted interactions and content" },
  { intent: "content_post" as CreativeIntent, safetyClass: "light" as CreativeSafetyClass, summary: "Prepare and schedule content posts" },
  { intent: "audience_research" as CreativeIntent, safetyClass: "read_only" as CreativeSafetyClass, summary: "Research target audience, interests, and content gaps" },
];

function selectIntent(objective: string): { intent: CreativeIntent; safetyClass: CreativeSafetyClass; summary: string } {
  const obj = objective.toLowerCase();
  if (obj.includes("scan") || obj.includes("check") || obj.includes("health") || obj.includes("audit")) {
    return { intent: "account_scan", safetyClass: "read_only", summary: `Account scan for: ${objective}` };
  }
  if (obj.includes("strategy") || obj.includes("review") || obj.includes("plan")) {
    return { intent: "strategy_review", safetyClass: "read_only", summary: `Strategy review: ${objective}` };
  }
  if (obj.includes("engage") || obj.includes("boost") || obj.includes("grow")) {
    return { intent: "engagement_boost", safetyClass: "light", summary: `Engagement boost: ${objective}` };
  }
  if (obj.includes("post") || obj.includes("content") || obj.includes("create")) {
    return { intent: "content_post", safetyClass: "light", summary: `Content creation: ${objective}` };
  }
  if (obj.includes("audience") || obj.includes("research") || obj.includes("discover")) {
    return { intent: "audience_research", safetyClass: "read_only", summary: `Audience research: ${objective}` };
  }
  return { intent: "account_scan", safetyClass: "read_only", summary: `Account scan for: ${objective}` };
}

function buildProposal(req: CreativeWorkflowCreateRequest): CreativeProposal {
  const { intent, safetyClass, summary } = selectIntent(req.objective);
  return {
    objective: req.objective,
    intent,
    safetyClass,
    summary,
    clientId: req.clientId,
    accountId: req.accountId,
    deviceId: req.deviceId,
  };
}

export async function createCreativeWorkflowRun(req: CreativeWorkflowCreateRequest): Promise<CreativeWorkflowCreateResponse> {
  const { intent, safetyClass, summary } = selectIntent(req.objective);

  if (!req.clientId || !req.accountId || !req.deviceId || !req.objective) {
    return {
      runId: randomUUID(),
      proposal: buildProposal(req),
      status: "not_ready",
      agencyWorkflowRunId: null,
      taskId: null,
      message: "Missing required fields: clientId, accountId, deviceId, objective are all required.",
    };
  }

  const runId = randomUUID();
  const proposal = buildProposal(req);

  return {
    runId,
    proposal,
    status: req.dryRun ? "proposal" : "queued",
    agencyWorkflowRunId: req.dryRun ? null : randomUUID(),
    taskId: req.dryRun ? null : randomUUID(),
    message: req.dryRun
      ? `Dry run: proposal created with intent=${intent}, safetyClass=${safetyClass}.`
      : `Creative workflow run ${runId} created. Intent=${intent}, safetyClass=${safetyClass}. Linked to agency workflow run ${randomUUID()}.`,
  };
}

export async function getCreativeWorkflowRun(runId: string): Promise<CreativeWorkflowRun | null> {
  return null;
}

export { buildProposal, selectIntent };
