import { getDb } from "../../db/client";
import { workflowEvents } from "../workflow-events";
import type {
  CreativeWorkflowCreateRequest,
  CreativeWorkflowCreateResponse,
  CreativeIntent,
  CreativeSafetyClass,
  CreativeProposal,
} from "./creative-workflow.types";

const CANONICAL_READ_ONLY_INTENT = "reddit_account_health_scan";

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
  const { intent, safetyClass, summary } = selectIntent(req.objective ?? "");
  return {
    objective: req.objective ?? "",
    intent,
    safetyClass,
    summary,
    clientId: req.clientId ?? "",
    accountId: req.accountId ?? "",
    deviceId: req.deviceId ?? "",
  };
}

function canonicalIntentForProposal(proposal: CreativeProposal): string | null {
  if (proposal.safetyClass !== "read_only") return null;
  if (proposal.intent === "account_scan" || proposal.intent === "health_check") {
    return CANONICAL_READ_ONLY_INTENT;
  }
  return null;
}

function cachedWorkflowSafetyClass(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const metadata = compiledPlan?.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as Record<string, unknown> | null;
  return (metadata?.safetyClass ?? workflow?.safetyClass ?? sourceMetadata?.safetyClass ?? null) as string | null;
}

function cachedWorkflowIntent(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const metadata = compiledPlan?.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as Record<string, unknown> | null;
  return (metadata?.intent ?? workflow?.intent ?? sourceMetadata?.intent ?? null) as string | null;
}

function cachedWorkflowLlmHappyPathRequests(cached: Record<string, unknown>): number | null {
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const llmBudget = compiledPlan?.llmBudget as Record<string, unknown> | undefined;
  return typeof llmBudget?.happyPathRequests === "number" ? llmBudget.happyPathRequests : null;
}

export async function createCreativeWorkflowRun(req: CreativeWorkflowCreateRequest): Promise<CreativeWorkflowCreateResponse> {
  const proposal = buildProposal(req);

  if (!req.clientId || !req.accountId || !req.deviceId || !req.objective) {
    return {
      runId: null,
      proposal,
      status: "not_ready",
      code: "CREATIVE_WORKFLOW_MISSING_FIELDS",
      agencyWorkflowRunId: null,
      taskId: null,
      message: "Missing required fields: clientId, accountId, deviceId, objective are all required.",
    };
  }

  const report = {
    objective: proposal.objective,
    proposal,
    dryRun: req.dryRun === true,
    createdAt: new Date().toISOString(),
  };

  if (req.dryRun) {
    return {
      runId: null,
      proposal,
      status: "proposal",
      agencyWorkflowRunId: null,
      taskId: null,
      report,
      message: `Dry run: proposal created with intent=${proposal.intent}, safetyClass=${proposal.safetyClass}.`,
    };
  }

  const canonicalIntent = canonicalIntentForProposal(proposal);
  if (!canonicalIntent) {
    return {
      runId: null,
      proposal,
      status: "not_ready",
      code: "CREATIVE_WORKFLOW_UNSUPPORTED_INTENT",
      agencyWorkflowRunId: null,
      taskId: null,
      report,
      message: `No safe executable generated workflow is approved for intent=${proposal.intent}, safetyClass=${proposal.safetyClass}.`,
    };
  }

  const db = getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const accountResult = await client.query<{
      id: string;
      username: string | null;
      platform: string;
      client_id: string | null;
    }>(
      `SELECT id, username, platform, client_id
       FROM accounts
       WHERE id = $1`,
      [req.accountId],
    );
    const account = accountResult.rows[0];
    if (!account) {
      await client.query("ROLLBACK");
      return {
        runId: null,
        proposal,
        status: "not_ready",
        code: "ACCOUNT_NOT_FOUND",
        agencyWorkflowRunId: null,
        taskId: null,
        report,
        message: "Account not found.",
      };
    }
    if (account.client_id && account.client_id !== req.clientId) {
      await client.query("ROLLBACK");
      return {
        runId: null,
        proposal,
        status: "not_ready",
        code: "ACCOUNT_CLIENT_MISMATCH",
        agencyWorkflowRunId: null,
        taskId: null,
        report,
        message: "Account is linked to a different client.",
      };
    }
    if (account.platform !== "reddit") {
      await client.query("ROLLBACK");
      return {
        runId: null,
        proposal,
        status: "not_ready",
        code: "CREATIVE_WORKFLOW_PLATFORM_NOT_READY",
        agencyWorkflowRunId: null,
        taskId: null,
        report,
        message: "Creative E2E currently has an approved executable artifact only for reddit read-only account health scans.",
      };
    }

    const cacheResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM generated_workflow_plan_cache
       WHERE platform = $1
         AND COALESCE(compiled_plan #>> '{metadata,intent}', workflow ->> 'intent', source_metadata ->> 'intent') = $2
         AND COALESCE(compiled_plan #>> '{metadata,safetyClass}', workflow ->> 'safetyClass', source_metadata ->> 'safetyClass') = 'read_only'
         AND COALESCE(compiled_plan #>> '{llmBudget,happyPathRequests}', '') = '0'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [account.platform, canonicalIntent],
    );
    const cached = cacheResult.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      return {
        runId: null,
        proposal,
        status: "not_ready",
        code: "CREATIVE_WORKFLOW_ARTIFACT_NOT_READY",
        agencyWorkflowRunId: null,
        taskId: null,
        report,
        message: "No compatible cache-safe read-only generated workflow artifact is ready for this creative proposal.",
      };
    }

    const safetyClass = cachedWorkflowSafetyClass(cached);
    const artifactIntent = cachedWorkflowIntent(cached);
    if (safetyClass !== "read_only" || (artifactIntent && artifactIntent !== canonicalIntent) || cachedWorkflowLlmHappyPathRequests(cached) !== 0) {
      await client.query("ROLLBACK");
      return {
        runId: null,
        proposal,
        status: "not_ready",
        code: "CREATIVE_WORKFLOW_ARTIFACT_INVALID",
        agencyWorkflowRunId: null,
        taskId: null,
        report,
        message: "Compatible artifact failed read-only/cache-safe validation.",
      };
    }

    const runContext = {
      source: "creative_workflows",
      clientId: req.clientId,
      accountId: req.accountId,
      deviceId: req.deviceId,
      objective: req.objective,
      proposal,
      report,
    };
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agency_workflow_runs
         (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
          canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context, output)
       VALUES ($1, $2, $3, $4, $5, 'read_only', NULL, $6, $7, $8, $9, 'queued', $10, $11)
       RETURNING id`,
      [
        req.clientId,
        req.accountId,
        req.deviceId,
        account.platform,
        canonicalIntent,
        cached.cache_key,
        cached.canonical_workflow_id,
        cached.canonical_workflow_version,
        cached.compiled_plan_hash,
        JSON.stringify(runContext),
        JSON.stringify({ report }),
      ],
    );
    const runId = runResult.rows[0].id;

    const taskParams = {
      cacheKey: cached.cache_key,
      clientId: req.clientId,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: canonicalIntent,
      source: "creative_workflows",
      objective: req.objective,
    };
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [
        req.accountId,
        req.deviceId,
        JSON.stringify(taskParams),
        new Date().toISOString(),
      ],
    );
    const taskId = taskResult.rows[0].id;

    await client.query(
      `UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`,
      [taskId, runId],
    );
    await client.query("COMMIT");

    workflowEvents.publish({
      source: "agency",
      event: "queued",
      taskId,
      agencyWorkflowRunId: runId,
      clientId: req.clientId,
      accountId: req.accountId,
      deviceId: req.deviceId,
      status: "queued",
      message: "Creative workflow queued as generated workflow task",
      details: {
        objective: req.objective,
        proposal,
        intent: canonicalIntent,
        cacheKey: cached.cache_key,
      },
    });

  return {
    runId,
    proposal,
      status: "queued",
      agencyWorkflowRunId: runId,
      taskId,
      cacheKey: typeof cached.cache_key === "string" ? cached.cache_key : null,
      requestKey: typeof cached.request_key === "string" ? cached.request_key : null,
      report,
      message: `Creative workflow run ${runId} queued. Intent=${canonicalIntent}, safetyClass=read_only. Linked task ${taskId}.`,
  };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export { buildProposal, selectIntent };
