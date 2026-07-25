/**
 * workflows/workflow.service.ts
 * CRUD and state management for workflow executions.
 * Checkpoint is stored in PostgreSQL (atomic via BEGIN/UPDATE/COMMIT).
 *
 * "write → fsync → rename" principle implemented as:
 *   BEGIN → UPDATE workflows SET checkpoint = $new WHERE id = $id AND checkpoint_version = $old → COMMIT
 * Optimistic locking via checkpoint_version prevents race conditions.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §8
 */

import { getDb } from "../../db/client";
import type {
  WorkflowCheckpoint,
  WorkflowExecutionStats,
  WorkflowStatus,
  WorkflowTemplate,
} from "./types";
import {
  computeGeneratedWorkflowCompiledPlanHash,
  validateGeneratedWorkflowTemplate,
  type GeneratedWorkflowCompiledPlan,
} from "./workflow-validator";
import { portableCapabilityMetadata } from "../human-workflow/portable-capability";
import {
  transitionWorkflow,
  transitionWorkflowWhere,
} from "./workflow-lifecycle.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRecord {
  id:          string;
  templateId:  string | null;
  accountId:   string | null;
  deviceId:    string | null;
  status:      WorkflowStatus;
  currentStep: number;
  totalSteps:  number | null;
  checkpoint:  WorkflowCheckpoint;
  executionStats: WorkflowExecutionStats | null;
  hbeParams:   Record<string, unknown>;
  startedAt:   string | null;
  completedAt: string | null;
  error:       string | null;
  createdAt:   string;
  lifecycleInitial?: boolean;
  lifecycleTerminal?: boolean;
  lifecycleRetryable?: boolean;
  lifecycleAdministrative?: boolean;
  lifecycleDispatchable?: boolean;
}

export interface CreateWorkflowInput {
  templateId?:  string;
  accountId?:   string;
  deviceId:     string;
  totalSteps?:  number;
  hbeParams:    Record<string, unknown>;
  checkpoint:   WorkflowCheckpoint;
}

export interface GeneratedWorkflowPlanCacheRecord {
  cacheKey: string;
  requestKey: string | null;
  canonicalWorkflowId: string;
  canonicalWorkflowVersion: string;
  compiledPlanHash: string;
  artifactState: "candidate" | "promoted" | "failed" | "quarantined";
  sourceMetadata: Record<string, unknown>;
  templateId: string;
  platform: string;
  templateVersion: string;
  workflow: WorkflowTemplate;
  compiledPlan: GeneratedWorkflowCompiledPlan;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export type GeneratedWorkflowArtifactState = GeneratedWorkflowPlanCacheRecord["artifactState"];

export interface SaveGeneratedPlanCacheOptions {
  sourceMetadata?: Record<string, unknown>;
  artifactState?: GeneratedWorkflowArtifactState;
  replaceRequestKeyArtifacts?: boolean;
}

export interface GeneratedWorkflowCacheLookupOptions {
  includeCandidate?: boolean;
}

export interface GeneratedWorkflowOutcomeInput {
  cacheKey: string;
  success: boolean;
  reason?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  agencyWorkflowRunId?: string | null;
  stepsCompleted?: number | null;
  totalSteps?: number | null;
  deviceId?: string | null;
  branchKey?: string | null;
  appVersion?: string | null;
  androidVersion?: string | null;
  recoveryCount?: number;
  postconditionVerified?: boolean;
}

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class WorkflowService {
  // ─── CRUD ────────────────────────────────────────────────────────────────

  async create(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const db = getDb();
    const result = await db.query(
      `INSERT INTO workflows
         (template_id, account_id, device_id, current_step, total_steps, checkpoint, hbe_params)
       VALUES ($1, $2, $3, 0, $4, $5, $6)
       RETURNING *`,
      [
        input.templateId ?? null,
        input.accountId  ?? null,
        input.deviceId,
        input.totalSteps ?? null,
        JSON.stringify(input.checkpoint),
        JSON.stringify(input.hbeParams),
      ]
    );
    return rowToWorkflow(result.rows[0]);
  }

  async get(id: string): Promise<WorkflowRecord | null> {
    const db = getDb();
    const result = await db.query(
      `SELECT workflow.*,
              state.initial AS lifecycle_initial,
              state.terminal AS lifecycle_terminal,
              state.retryable AS lifecycle_retryable,
              state.administrative AS lifecycle_administrative,
              state.dispatchable AS lifecycle_dispatchable
         FROM workflows workflow
         JOIN lifecycle_state_definitions state
           ON state.lifecycle_key = workflow.lifecycle_key
          AND state.status = workflow.status
        WHERE workflow.id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return rowToWorkflow(result.rows[0]);
  }

  async list(
    deviceId?: string,
    status?: WorkflowStatus,
    page = 1,
    pageSize = 50
  ): Promise<{ items: WorkflowRecord[]; total: number }> {
    const db = getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (deviceId) { values.push(deviceId); conditions.push(`device_id = $${values.length}`); }
    if (status)   { values.push(status);   conditions.push(`status = $${values.length}`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(pageSize, (page - 1) * pageSize);

    const [rows, countRow] = await Promise.all([
      db.query(`SELECT * FROM workflows ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values),
      db.query(`SELECT COUNT(*) FROM workflows ${where}`, values.slice(0, -2)),
    ]);

    return {
      items: rows.rows.map(rowToWorkflow),
      total: parseInt(countRow.rows[0].count, 10),
    };
  }

  /**
   * Count workflows by status. Used for concurrency guard.
   */
  async countByStatus(status: WorkflowStatus): Promise<number> {
    const db = getDb();
    const result = await db.query(
      "SELECT COUNT(*) FROM workflows WHERE status = $1",
      [status]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  /**
   * Count active (running or queued) workflows for a specific device.
   * Used to enforce per-device concurrency limit (max 1 workflow per device).
   */
  async countActiveByDevice(deviceId: string): Promise<number> {
    const db = getDb();
    const result = await db.query(
      `SELECT COUNT(*)
         FROM workflows workflow
         JOIN lifecycle_state_definitions state
           ON state.lifecycle_key = workflow.lifecycle_key
          AND state.status = workflow.status
        WHERE workflow.device_id = $1
          AND COALESCE((state.metadata->>'countsAsActive')::boolean, FALSE)`,
      [deviceId],
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  /**
   * Get count of workflows in all active states.
   * Returns a breakdown for monitoring/dashboard.
   */
  async getActiveCounts(): Promise<Record<string, number>> {
    const db = getDb();
    const result = await db.query(
      `SELECT state.status, COUNT(workflow.id) AS count
         FROM lifecycle_resource_bindings binding
         JOIN lifecycle_state_definitions state
           ON state.lifecycle_key = binding.lifecycle_key
         LEFT JOIN workflows workflow
           ON workflow.lifecycle_key = state.lifecycle_key
          AND workflow.status = state.status
        WHERE binding.resource_table = to_regclass($1)
          AND NOT state.terminal
        GROUP BY state.status, state.sort_order
        ORDER BY state.sort_order, state.status`,
      ["workflows"],
    );
    const counts: Record<string, number> = { total: 0 };
    for (const row of result.rows) {
      const status = row.status as string;
      const count = parseInt(row.count as string, 10);
      counts[status] = count;
      counts.total += count;
    }
    return counts;
  }

  async cancel(id: string): Promise<boolean> {
    return Boolean(await transitionWorkflow(id, {
      targetTerminal: true,
      targetAdministrative: true,
      transitionManualAllowed: true,
    }));
  }

  // ─── Checkpoint (atomic) ─────────────────────────────────────────────────

  /**
   * Atomically update checkpoint + step index.
   *
   * Uses pool.query() instead of db.connect() to avoid holding dedicated connections.
   * The UPDATE with WHERE guard provides atomicity without explicit BEGIN/COMMIT.
   * If the pool is exhausted, connectionTimeoutMillis (5s) prevents hanging.
   *
   * @param expectedStep  Current step index — prevents overwrite from stale worker
   */
  async saveCheckpoint(
    workflowId: string,
    newCheckpoint: WorkflowCheckpoint,
    newStep: number,
    expectedStep: number
  ): Promise<boolean> {
    const db = getDb();
    try {
      return Boolean(await transitionWorkflowWhere(
        workflowId,
        {
          targetTerminal: false,
          targetAdministrative: false,
          targetDispatchable: false,
          transitionMarkStarted: true,
          transitionMarkCompleted: false,
        },
        { checkpoint: newCheckpoint, currentStep: newStep },
        db,
        "workflow.current_step = $2",
        [expectedStep],
      ));
    } catch (err) {
      console.error(`[workflow] saveCheckpoint failed for ${workflowId}: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── Status transitions ────────────────────────────────────────────────

  async markRunning(id: string): Promise<boolean> {
    return Boolean(await transitionWorkflow(id, {
      targetTerminal: false,
      targetAdministrative: false,
      targetDispatchable: false,
      transitionMarkStarted: true,
      transitionMarkCompleted: false,
    }));
  }

  async markCompleted(id: string): Promise<void> {
    await transitionWorkflow(id, {
      targetTerminal: true,
      targetRetryable: false,
      targetAdministrative: false,
      transitionMarkCompleted: true,
      transitionClearFailure: true,
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await transitionWorkflow(id, {
      targetTerminal: true,
      targetRetryable: true,
      targetAdministrative: false,
      transitionMarkCompleted: true,
      transitionClearFailure: false,
    }, { error });
  }

  async markFailedIfEdgeStartUnacknowledged(id: string, error: string): Promise<boolean> {
    const db = getDb();
    return Boolean(await transitionWorkflowWhere(
      id,
      {
        targetTerminal: true,
        targetRetryable: true,
        targetAdministrative: false,
        transitionMarkCompleted: true,
        transitionClearFailure: false,
      },
      { error },
      db,
      "workflow.current_step = 0 AND (workflow.checkpoint->>'source') IS DISTINCT FROM 'edge'",
    ));
  }

  /**
   * Fail an edge workflow only if it is still running at the exact checkpoint
   * observed by the watchdog. The checkpoint CAS prevents a delayed sweep from
   * terminalizing a workflow that progressed or completed meanwhile.
   */
  async markFailedIfEdgeProgressStale(
    id: string,
    observedCheckpointAt: string,
    error: string,
  ): Promise<boolean> {
    const db = getDb();
    return Boolean(await transitionWorkflowWhere(
      id,
      {
        targetTerminal: true,
        targetRetryable: true,
        targetAdministrative: false,
        transitionMarkCompleted: true,
        transitionClearFailure: false,
      },
      { error },
      db,
      "(workflow.checkpoint->>'source') = 'edge' AND (workflow.checkpoint->>'checkpointAt') = $2",
      [observedCheckpointAt],
    ));
  }

  async markPaused(id: string): Promise<void> {
    await transitionWorkflow(id, {
      targetTerminal: false,
      targetAdministrative: true,
      transitionManualAllowed: true,
    });
  }

  // ─── Template management ─────────────────────────────────────────────────

  async saveTemplate(template: WorkflowTemplate): Promise<void> {
    const db = getDb();
    await this.saveTemplateWithDb(db, template);
  }

  private async saveTemplateWithDb(db: Queryable, template: WorkflowTemplate): Promise<void> {
    await db.query(
      `INSERT INTO workflow_templates
         (id, platform, definition, data_retention_days, default_verification_strategy)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         platform                     = EXCLUDED.platform,
         definition                   = EXCLUDED.definition,
         data_retention_days          = EXCLUDED.data_retention_days,
         default_verification_strategy = EXCLUDED.default_verification_strategy,
         updated_at                   = NOW()`,
      [
        template.id,
        template.platform,
        JSON.stringify(template),
        template.dataRetentionDays,
        template.defaultVerificationStrategy,
      ]
    );
  }

  async getTemplate(id: string): Promise<WorkflowTemplate | null> {
    const db = getDb();
    const result = await db.query(
      "SELECT definition FROM workflow_templates WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].definition as WorkflowTemplate;
  }

  async listTemplates(): Promise<WorkflowTemplate[]> {
    const db = getDb();
    const rows = await db.query(
      "SELECT definition FROM workflow_templates ORDER BY id"
    );
    return rows.rows.map(r => r.definition as WorkflowTemplate);
  }

  // ─── Generated workflow plan cache ───────────────────────────────────────

  async saveGeneratedPlanCache(
    template: WorkflowTemplate,
    compiledPlan: GeneratedWorkflowCompiledPlan,
    requestKey?: string,
    sourceMetadataOrOptions: Record<string, unknown> | SaveGeneratedPlanCacheOptions = {}
  ): Promise<void> {
    const db = getDb();
    await this.saveGeneratedPlanCacheWithDb(db, template, compiledPlan, requestKey, sourceMetadataOrOptions);
  }

  async saveExecutableGeneratedPlanCache(
    template: WorkflowTemplate,
    compiledPlan: GeneratedWorkflowCompiledPlan,
    requestKey: string | undefined,
    sourceMetadata: Record<string, unknown>
  ): Promise<void> {
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await this.saveTemplateWithDb(client, template);
      await this.saveGeneratedPlanCacheWithDb(client, template, compiledPlan, requestKey, {
        artifactState: "promoted",
        sourceMetadata,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async saveCandidateExecutableGeneratedPlanCache(
    template: WorkflowTemplate,
    compiledPlan: GeneratedWorkflowCompiledPlan,
    requestKey: string | undefined,
    sourceMetadata: Record<string, unknown>
  ): Promise<void> {
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await this.saveTemplateWithDb(client, template);
      await this.saveGeneratedPlanCacheWithDb(client, template, compiledPlan, requestKey, {
        artifactState: "candidate",
        sourceMetadata,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async saveGeneratedPlanCacheWithDb(
    db: Queryable,
    template: WorkflowTemplate,
    compiledPlan: GeneratedWorkflowCompiledPlan,
    requestKey?: string,
    sourceMetadataOrOptions: Record<string, unknown> | SaveGeneratedPlanCacheOptions = {}
  ): Promise<void> {
    const options = normalizeSaveGeneratedPlanCacheOptions(sourceMetadataOrOptions);
    const artifactState = options.artifactState ?? "candidate";
    const validation = validateGeneratedWorkflowTemplate(template);
    if (!validation.template) {
      throw Object.assign(
        new Error(`generated workflow cache persistence failed validation: ${validation.errors.join("; ")}`),
        { code: "GENERATED_WORKFLOW_CACHE_VALIDATION_FAILED", validationErrors: validation.errors }
      );
    }
    if (compiledPlan.llmBudget.happyPathRequests !== 0) {
      throw Object.assign(
        new Error("generated workflow cache persistence requires compiledPlan.llmBudget.happyPathRequests=0"),
        { code: "GENERATED_WORKFLOW_CACHE_LLM_BUDGET_UNSAFE" }
      );
    }
    const compiledPlanHash = computeGeneratedWorkflowCompiledPlanHash(compiledPlan);
    const sourceMetadata = {
      intent: compiledPlan.metadata.intent,
      safetyClass: compiledPlan.metadata.safetyClass,
      outputSchema: compiledPlan.metadata.outputSchema,
      allowedRecoveryRequests: compiledPlan.metadata.allowedRecoveryRequests,
      ...options.sourceMetadata,
    };
    const canonicalSourceMetadata = {
      ...sourceMetadata,
      ...portableCapabilityMetadata(template, sourceMetadata),
    };
    if (requestKey && options.replaceRequestKeyArtifacts !== false) {
      await db.query("DELETE FROM generated_workflow_plan_cache WHERE request_key = $1 AND cache_key <> $2", [
        requestKey,
        compiledPlan.cacheKey,
      ]);
    }
    await db.query(
      `INSERT INTO generated_workflow_plan_cache
         (cache_key, request_key, canonical_workflow_id, canonical_workflow_version, compiled_plan_hash,
          artifact_state, source_metadata, template_id, platform, template_version, workflow, compiled_plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (cache_key) DO UPDATE SET
         request_key      = COALESCE(EXCLUDED.request_key, generated_workflow_plan_cache.request_key),
         canonical_workflow_id = EXCLUDED.canonical_workflow_id,
         canonical_workflow_version = EXCLUDED.canonical_workflow_version,
         compiled_plan_hash = EXCLUDED.compiled_plan_hash,
         artifact_state = CASE
           WHEN generated_workflow_plan_cache.artifact_state = 'promoted' AND EXCLUDED.artifact_state = 'candidate'
             THEN generated_workflow_plan_cache.artifact_state
           ELSE EXCLUDED.artifact_state
         END,
         source_metadata = generated_workflow_plan_cache.source_metadata || EXCLUDED.source_metadata,
         template_id      = EXCLUDED.template_id,
         platform         = EXCLUDED.platform,
         template_version = EXCLUDED.template_version,
         workflow         = EXCLUDED.workflow,
         compiled_plan    = EXCLUDED.compiled_plan,
         updated_at       = NOW()`,
      [
        compiledPlan.cacheKey,
        requestKey ?? null,
        template.id,
        template.version,
        compiledPlanHash,
        artifactState,
        JSON.stringify(canonicalSourceMetadata),
        template.id,
        template.platform,
        template.version,
        JSON.stringify(template),
        JSON.stringify(compiledPlan),
      ]
    );
    await this.syncCapabilityCatalogWithDb(
      db,
      compiledPlan.cacheKey,
      template,
      canonicalSourceMetadata,
    );
  }

  private async syncCapabilityCatalogWithDb(
    db: Queryable,
    cacheKey: string,
    template: WorkflowTemplate,
    sourceMetadata: Record<string, unknown>,
  ): Promise<void> {
    const capabilityKey = sourceMetadata.capabilityKey;
    if (typeof capabilityKey !== "string" || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(capabilityKey)) return;
    const aliases = [
      sourceMetadata.intent,
      template.intent,
      template.name,
      template.description,
      ...(Array.isArray(sourceMetadata.capabilityAliases) ? sourceMetadata.capabilityAliases : []),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const safetyClass = [
      "read_only",
      "navigation",
      "standard",
      "mutating",
      "sensitive",
      "destructive",
    ].includes(String(sourceMetadata.safetyClass ?? template.safetyClass))
      ? String(sourceMetadata.safetyClass ?? template.safetyClass)
      : "read_only";
    const portabilityScope = ["global", "contextual", "device", "account"].includes(String(sourceMetadata.portabilityScope))
      ? String(sourceMetadata.portabilityScope)
      : "global";
    const role = sourceMetadata.capabilityRole === "fragment" ? "fragment" : "complete";

    await db.query(
      `INSERT INTO workflow_capabilities (
         capability_key, platform, description, aliases, safety_class, portability_scope, metadata
       )
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb)
       ON CONFLICT (capability_key) DO UPDATE SET
         aliases = ARRAY(
           SELECT DISTINCT value
           FROM unnest(workflow_capabilities.aliases || EXCLUDED.aliases) AS value
           WHERE value IS NOT NULL AND BTRIM(value) <> ''
         ),
         description = COALESCE(workflow_capabilities.description, EXCLUDED.description),
         metadata = workflow_capabilities.metadata || EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        capabilityKey,
        template.platform,
        template.description ?? null,
        aliases,
        safetyClass,
        portabilityScope,
        JSON.stringify({
          syncedBy: "workflow_cache_persistence",
          ...(sourceMetadata.goalContract || template.goalContract
            ? { goalContract: sourceMetadata.goalContract ?? template.goalContract }
            : {}),
        }),
      ],
    );
    await db.query(
      `INSERT INTO workflow_capability_artifacts (
         capability_key, cache_key, role, status, evidence
       )
       VALUES ($1, $2, $3, 'active', $4::jsonb)
       ON CONFLICT (capability_key, cache_key) DO UPDATE SET
         role = EXCLUDED.role,
         status = 'active',
         evidence = workflow_capability_artifacts.evidence || EXCLUDED.evidence,
         updated_at = NOW()`,
      [
        capabilityKey,
        cacheKey,
        role,
        JSON.stringify({ syncedBy: "workflow_cache_persistence" }),
      ],
    );
  }

  async getGeneratedPlanCache(
    cacheKey: string,
    options: GeneratedWorkflowCacheLookupOptions = {}
  ): Promise<GeneratedWorkflowPlanCacheRecord | null> {
    const db = getDb();
    const result = await db.query(
      `UPDATE generated_workflow_plan_cache
       SET hit_count = hit_count + 1, last_used_at = NOW()
       WHERE cache_key = $1
         AND artifact_state = ANY($2::text[])
         AND (
           artifact_state <> 'promoted'
           OR COALESCE(
             compiled_plan #>> '{metadata,safetyClass}',
             workflow ->> 'safetyClass',
             source_metadata ->> 'safetyClass'
           ) IN ('read_only', 'navigation', 'standard', 'mutating', 'sensitive')
         )
       RETURNING *`,
      [cacheKey, allowedArtifactStates(options)]
    );
    if (result.rows.length === 0) return null;
    return rowToGeneratedPlanCache(result.rows[0]);
  }

  async getGeneratedPlanCacheByRequestKey(
    requestKey: string,
    options: GeneratedWorkflowCacheLookupOptions = {}
  ): Promise<GeneratedWorkflowPlanCacheRecord | null> {
    const db = getDb();
    const result = await db.query(
      `UPDATE generated_workflow_plan_cache
       SET hit_count = hit_count + 1, last_used_at = NOW()
       WHERE cache_key = (
         SELECT cache_key FROM generated_workflow_plan_cache
         WHERE request_key = $1
           AND artifact_state = ANY($2::text[])
           AND (
             artifact_state <> 'promoted'
             OR COALESCE(
               compiled_plan #>> '{metadata,safetyClass}',
               workflow ->> 'safetyClass',
               source_metadata ->> 'safetyClass'
             ) IN ('read_only', 'navigation', 'standard', 'mutating', 'sensitive')
           )
         ORDER BY updated_at DESC
         LIMIT 1
       )
       RETURNING *`,
      [requestKey, allowedArtifactStates(options)]
    );
    if (result.rows.length === 0) return null;
    return rowToGeneratedPlanCache(result.rows[0]);
  }

  async listPortableGeneratedPlanCacheCandidates(
    platform: string,
    limit = 200
  ): Promise<GeneratedWorkflowPlanCacheRecord[]> {
    const db = getDb();
    const result = await db.query(
      `SELECT *
       FROM generated_workflow_plan_cache
       WHERE artifact_state = 'promoted'
         AND (
           LOWER(platform) = LOWER($1)
           OR source_metadata -> 'supportedPlatforms' ? $1
         )
         AND COALESCE(source_metadata ->> 'portable', 'true') <> 'false'
         AND COALESCE(source_metadata ->> 'portabilityScope', 'global') NOT IN ('device', 'account', 'contextual')
         AND COALESCE(
           compiled_plan #>> '{metadata,safetyClass}',
           workflow ->> 'safetyClass',
           source_metadata ->> 'safetyClass'
         ) IN ('read_only', 'navigation', 'standard', 'mutating', 'sensitive')
       ORDER BY updated_at DESC
       LIMIT $2`,
      [platform, Math.max(1, Math.min(limit, 500))]
    );
    return result.rows.map(rowToGeneratedPlanCache);
  }

  async recordPortableCapabilityIdentity(
    cacheKey: string,
    capabilityKey: string
  ): Promise<void> {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(capabilityKey)) {
      throw Object.assign(new Error("portable capability key is invalid"), {
        code: "PORTABLE_CAPABILITY_KEY_INVALID",
      });
    }
    const db = getDb();
    const result = await db.query(
      `UPDATE generated_workflow_plan_cache
       SET source_metadata = source_metadata || jsonb_build_object(
             'capabilityKey', $2::text,
             'portable', true,
             'portabilityScope', 'global',
             'capabilityResolvedAt', NOW()
           ),
           updated_at = NOW()
       WHERE cache_key = $1
         AND artifact_state = 'promoted'
         AND COALESCE(source_metadata ->> 'portable', 'true') <> 'false'
         AND COALESCE(source_metadata ->> 'portabilityScope', 'global') NOT IN ('device', 'account', 'contextual')
       RETURNING *`,
      [cacheKey, capabilityKey]
    );
    const row = result.rows[0];
    if (row) {
      await this.syncCapabilityCatalogWithDb(
        db,
        cacheKey,
        row.workflow as WorkflowTemplate,
        (row.source_metadata as Record<string, unknown>) ?? {},
      );
    }
  }

  async getGeneratedPlanCacheForRepair(
    cacheKey: string
  ): Promise<GeneratedWorkflowPlanCacheRecord | null> {
    const db = getDb();
    const result = await db.query(
      `SELECT *
       FROM generated_workflow_plan_cache
       WHERE cache_key = $1
       LIMIT 1`,
      [cacheKey]
    );
    if (result.rows.length === 0) return null;
    return rowToGeneratedPlanCache(result.rows[0]);
  }

  async recordGeneratedPlanCacheOutcome(
    input: GeneratedWorkflowOutcomeInput
  ): Promise<GeneratedWorkflowPlanCacheRecord | null> {
    const db = getDb();
    const successIncrement = input.success ? 1 : 0;
    const failureIncrement = input.success ? 0 : 1;
    await db.query(
        `INSERT INTO workflow_artifact_coverage
           (cache_key, device_id, branch_key, app_version, android_version,
            success_count, failure_count, recovery_count, postcondition_verified, last_evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (
           cache_key,
           COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
           branch_key, COALESCE(app_version,''), COALESCE(android_version,'')
         ) DO UPDATE SET
           success_count=workflow_artifact_coverage.success_count + EXCLUDED.success_count,
           failure_count=workflow_artifact_coverage.failure_count + EXCLUDED.failure_count,
           recovery_count=workflow_artifact_coverage.recovery_count + EXCLUDED.recovery_count,
           postcondition_verified=workflow_artifact_coverage.postcondition_verified OR EXCLUDED.postcondition_verified,
           last_evidence=EXCLUDED.last_evidence,
           updated_at=NOW()`,
        [
          input.cacheKey, input.deviceId ?? null, input.branchKey ?? "default",
          input.appVersion ?? null, input.androidVersion ?? null, successIncrement, failureIncrement,
          Math.max(0, Number(input.recoveryCount ?? 0)),
          input.success && input.postconditionVerified !== false,
          JSON.stringify({
            taskId: input.taskId ?? null,
            workflowId: input.workflowId ?? null,
            agencyWorkflowRunId: input.agencyWorkflowRunId ?? null,
            reason: input.reason ?? null,
          }),
        ],
      );
    const coverage = await db.query(
        `SELECT COUNT(DISTINCT device_id) FILTER (WHERE success_count > 0 AND postcondition_verified)::int AS distinct_devices,
                COUNT(DISTINCT branch_key) FILTER (WHERE success_count > 0 AND postcondition_verified)::int AS distinct_branches,
                COALESCE(SUM(failure_count),0)::int AS failures,
                COALESCE(SUM(recovery_count),0)::int AS recoveries
           FROM workflow_artifact_coverage WHERE cache_key=$1`,
        [input.cacheKey],
      );
    const stats = coverage.rows[0] ?? {};
    const globalCoverage = Number(stats.distinct_devices ?? 0) >= 2
      && Number(stats.distinct_branches ?? 0) >= 2
      && Number(stats.failures ?? 0) === 0
      && Number(stats.recoveries ?? 0) === 0;
    const result = await db.query(
        `/* recordGeneratedPlanCacheOutcome */
       UPDATE generated_workflow_plan_cache
       SET artifact_state = CASE
             WHEN $2::int = 1
              AND artifact_state IN ('candidate', 'promoted')
              AND $10::boolean
              AND COALESCE(compiled_plan #>> '{llmBudget,happyPathRequests}', '') = '0'
              AND COALESCE(
                compiled_plan #>> '{metadata,safetyClass}',
                workflow ->> 'safetyClass',
                source_metadata ->> 'safetyClass'
              ) IN ('read_only', 'navigation')
               THEN 'promoted'
             WHEN $3::int = 1 AND artifact_state = 'candidate'
               THEN 'failed'
             WHEN $3::int = 1 AND artifact_state = 'promoted'
               THEN 'quarantined'
             ELSE artifact_state
           END,
           source_metadata = source_metadata || jsonb_build_object(
             'workflowLearning',
             jsonb_build_object(
               'successCount', COALESCE((source_metadata #>> '{workflowLearning,successCount}')::int, 0) + $2::int,
               'failureCount', COALESCE((source_metadata #>> '{workflowLearning,failureCount}')::int, 0) + $3::int,
               'lastOutcome', CASE WHEN $2::int = 1 THEN 'success' ELSE 'failure' END,
               'lastReason', $4::text,
               'lastTaskId', $5::text,
               'lastWorkflowId', $6::text,
               'lastAgencyWorkflowRunId', $7::text,
               'lastStepsCompleted', $8::int,
               'lastTotalSteps', $9::int,
               'lastEvaluatedAt', NOW(),
               'validationStage', CASE
                 WHEN $10::boolean THEN 'global_promoted'
                 WHEN $2::int = 1 THEN 'device_validated'
                 ELSE 'candidate'
               END,
               'decision', CASE
                 WHEN $2::int = 1 AND $10::boolean THEN 'auto_promote_or_keep'
                 WHEN $2::int = 1 THEN 'retain_candidate_until_coverage'
                 WHEN artifact_state = 'promoted' THEN 'quarantine_promoted_after_failure'
                 WHEN artifact_state = 'candidate' THEN 'mark_candidate_failed'
                 ELSE 'record_learning_only'
               END
             )
           ),
           updated_at = NOW()
       WHERE cache_key = $1
       RETURNING *`,
      [
        input.cacheKey,
        successIncrement,
        failureIncrement,
        input.reason ?? null,
        input.taskId ?? null,
        input.workflowId ?? null,
        input.agencyWorkflowRunId ?? null,
        input.stepsCompleted ?? null,
        input.totalSteps ?? null,
        globalCoverage,
      ]
    );
    if (result.rows.length === 0) return null;
    return rowToGeneratedPlanCache(result.rows[0]);
  }
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToWorkflow(row: Record<string, unknown>): WorkflowRecord {
  return {
    id:          row.id as string,
    templateId:  (row.template_id as string) ?? null,
    accountId:   (row.account_id as string) ?? null,
    deviceId:    (row.device_id as string) ?? null,
    status:      row.status as WorkflowStatus,
    currentStep: row.current_step as number,
    totalSteps:  (row.total_steps as number) ?? null,
    checkpoint:  row.checkpoint as WorkflowCheckpoint,
    executionStats: ((row.checkpoint as WorkflowCheckpoint)?.executionStats ?? null) as WorkflowExecutionStats | null,
    hbeParams:   row.hbe_params as Record<string, unknown>,
    startedAt:   row.started_at ? (row.started_at as Date).toISOString() : null,
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
    error:       (row.error as string) ?? null,
    createdAt:   (row.created_at as Date).toISOString(),
    lifecycleInitial: row.lifecycle_initial as boolean | undefined,
    lifecycleTerminal: row.lifecycle_terminal as boolean | undefined,
    lifecycleRetryable: row.lifecycle_retryable as boolean | undefined,
    lifecycleAdministrative: row.lifecycle_administrative as boolean | undefined,
    lifecycleDispatchable: row.lifecycle_dispatchable as boolean | undefined,
  };
}

export const workflowService = new WorkflowService();

function rowToGeneratedPlanCache(row: Record<string, unknown>): GeneratedWorkflowPlanCacheRecord {
  return {
    cacheKey: row.cache_key as string,
    requestKey: (row.request_key as string) ?? null,
    canonicalWorkflowId: (row.canonical_workflow_id as string) ?? (row.template_id as string),
    canonicalWorkflowVersion: (row.canonical_workflow_version as string) ?? (row.template_version as string),
    compiledPlanHash: (row.compiled_plan_hash as string) ?? (row.cache_key as string),
    artifactState: (row.artifact_state as GeneratedWorkflowArtifactState) ?? "promoted",
    sourceMetadata: (row.source_metadata as Record<string, unknown>) ?? {},
    templateId: row.template_id as string,
    platform: row.platform as string,
    templateVersion: row.template_version as string,
    workflow: row.workflow as WorkflowTemplate,
    compiledPlan: row.compiled_plan as GeneratedWorkflowCompiledPlan,
    hitCount: row.hit_count as number,
    createdAt: row.created_at ? (row.created_at as Date).toISOString() : "",
    updatedAt: row.updated_at ? (row.updated_at as Date).toISOString() : "",
    lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
  };
}

function normalizeSaveGeneratedPlanCacheOptions(
  value: Record<string, unknown> | SaveGeneratedPlanCacheOptions
): SaveGeneratedPlanCacheOptions {
  if (
    Object.prototype.hasOwnProperty.call(value, "sourceMetadata")
    || Object.prototype.hasOwnProperty.call(value, "artifactState")
  ) {
    return value as SaveGeneratedPlanCacheOptions;
  }
  return { sourceMetadata: value as Record<string, unknown> };
}

function allowedArtifactStates(options: GeneratedWorkflowCacheLookupOptions): GeneratedWorkflowArtifactState[] {
  const states: GeneratedWorkflowArtifactState[] = ["promoted"];
  if (options.includeCandidate) states.push("candidate");
  return states;
}
