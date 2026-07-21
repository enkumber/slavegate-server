/**
 * workflow-compiler/planner.service.ts
 * Nivel 3: AI Planning — NL instruction → Compiled Workflow JSON.
 *
 * Flow:
 *   1. Load app map via app-mapping service (DB first, seed import fallback)
 *   2. Check cache (same instruction + app map version = cache hit)
 *   3. Build LLM prompt via prompt-builder logic
 *   4. Call LLM via utils/llm.ts
 *   5. Parse & validate response
 *   6. Save to compiled_workflows table
 */

import crypto from "crypto";
import { getDb } from "../../db/client";
import { llmJson } from "../../utils/llm";
import { loadMap } from "../app-mapping/recorder.service";
import type { AppMap } from "../app-mapping/schema";
import { canonicalizeCompiledWorkflow, canonicalModelOverride } from "./model-routing";
import { buildCompilePrompt } from "./prompt-builder";
import type {
  CompiledStep,
  CompiledWorkflow,
  CompileRequest,
  CompileResult,
} from "./types";

// Re-export types for backward compatibility (runner, recovery, routes import from here)
export type {
  CompiledStep,
  CompiledWorkflow,
  CompileRequest,
  CompileResult,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE KEY
// ═══════════════════════════════════════════════════════════════════════════════

function computeCacheKey(instruction: string, appId: string, appMapVersion: string): string {
  return crypto
    .createHash("sha256")
    .update(`${instruction.trim().toLowerCase()}|${appId}|${appMapVersion}`)
    .digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDER — delegated to prompt-builder.ts
// ═══════════════════════════════════════════════════════════════════════════════

// (buildAppMapSummary + buildPlannerPrompt removed — now using buildCompilePrompt from ./prompt-builder.ts)

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

interface ValidationError {
  stepId?: string;
  message: string;
}

function validateCompiledWorkflow(
  raw: { steps?: unknown[]; startPage?: unknown; name?: unknown },
  appMap: AppMap
): { valid: boolean; errors: ValidationError[]; workflow?: CompiledWorkflow } {
  const errors: ValidationError[] = [];

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { valid: false, errors: [{ message: "No steps array or empty steps" }] };
  }

  if (typeof raw.startPage !== "string" || !appMap.pages[raw.startPage]) {
    errors.push({ message: `Invalid startPage: ${raw.startPage}` });
  }

  const pageHashIndex = new Map<string, string>();
  for (const [pageId, page] of Object.entries(appMap.pages)) {
    pageHashIndex.set(pageId, page.detection.signatureHash);
  }

  const validActions = new Set(["screen_wake", "unlock", "tap", "type", "swipe", "press_key", "wait", "open_app", "intent_send", "screenshot"]);

  for (let i = 0; i < raw.steps.length; i++) {
    const step = raw.steps[i] as Record<string, unknown>;
    const stepId = (step?.id as string) || `step_${i}`;

    if (!validActions.has(step.action as string)) {
      errors.push({ stepId, message: `Invalid action: ${step.action}` });
    }

    // Check expectedPage exists in app map
    const expectedPage = step.expectedPage as string;
    if (typeof expectedPage === "string" && !pageHashIndex.has(expectedPage)) {
      errors.push({ stepId, message: `expectedPage "${expectedPage}" not found in app map` });
    }

    // Check expectedPageHash matches
    const expectedHash = step.expectedPageHash as string;
    if (typeof expectedPage === "string" && pageHashIndex.has(expectedPage)) {
      const actualHash = pageHashIndex.get(expectedPage)!;
      if (expectedHash && expectedHash !== actualHash) {
        errors.push({ stepId, message: `expectedPageHash mismatch for page "${expectedPage}": got "${expectedHash}", expected "${actualHash}"` });
      }
    }

    // Check elementId references if present
    if (step.target && typeof step.target === "object") {
      const target = step.target as Record<string, unknown>;
      const elemId = target.elementId as string;
      if (elemId && typeof expectedPage === "string" && appMap.pages[expectedPage]) {
        if (!appMap.pages[expectedPage].elements[elemId]) {
          errors.push({ stepId, message: `elementId "${elemId}" not found on page "${expectedPage}"` });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Build proper CompiledWorkflow
  const workflow: CompiledWorkflow = {
    id: "",
    name: (raw.name as string) || "Compiled workflow",
    source: "",
    appId: appMap.appId,
    compiledAt: new Date().toISOString(),
    steps: (raw.steps as CompiledStep[]).map((s, i) => ({
      ...s,
      id: s.id || `s${i + 1}`,
      retries: s.retries ?? 2,
      retryDelay: s.retryDelay ?? 500,
      description: s.description || `${s.action} step`,
    })),
    appMapVersion: appMap.version,
    startPage: raw.startPage as string,
    maxRecoveryAttempts: 1,
    maxTotalRecoveryAttempts: 10,
  };

  return { valid: true, errors: [], workflow };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: compileInstruction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compile a natural language instruction into an executable workflow.
 * Uses cached result if available (same instruction + app map version).
 */
export const MAX_INSTRUCTION_LENGTH = 2000;

export async function compileInstruction(req: CompileRequest): Promise<CompileResult> {
  const { appId, instruction, options = {} } = req;
  const sanitizedInstruction = instruction.trim().slice(0, MAX_INSTRUCTION_LENGTH);
  const model = canonicalModelOverride(options.model);
  const db = getDb();

  if (!sanitizedInstruction) {
    return { ok: false, error: "Instruction is empty after trimming." };
  }

  // 1. Load app map through the canonical app-mapping service. This keeps seed-only maps
  // importable before compilation instead of treating them as complete but uncompileable.
  let appMap: AppMap | null;
  try {
    appMap = await loadMap(appId);
    if (!appMap) {
      return { ok: false, error: `App map not found for appId="${appId}". Run app-mapping first.` };
    }
  } catch (err) {
    console.error("[planner] Failed to load app map:", (err as Error).message);
    return { ok: false, error: `Error loading app map: ${(err as Error).message}` };
  }

  // 2. Check cache (using SHA256 hash for efficient indexed lookup)
  const cacheKey = computeCacheKey(sanitizedInstruction, appId, appMap.version);
  try {
    const cached = await db.query(
      `SELECT id, compiled_data FROM compiled_workflows
       WHERE cache_key = $1
       ORDER BY created_at DESC LIMIT 1`,
      [cacheKey]
    );
    if (cached.rows.length > 0) {
      const compiledData = typeof cached.rows[0].compiled_data === "string"
        ? JSON.parse(cached.rows[0].compiled_data)
        : cached.rows[0].compiled_data;
      const workflow = canonicalizeCompiledWorkflow(compiledData);
      console.log(`[planner] Cache hit for "${sanitizedInstruction.slice(0, 60)}..." (appId=${appId})`);
      return {
        ok: true,
        workflowId: cached.rows[0].id,
        compiledWorkflow: workflow,
        fromCache: true,
      };
    }
  } catch {
    // Cache miss or table/column doesn't exist yet — proceed to compilation
  }

  // 3. Build prompt (delegated to prompt-builder.ts)
  const prompt = buildCompilePrompt(appMap, sanitizedInstruction);

  // 4. Call LLM
  let llmResponse: { steps?: unknown[]; startPage?: unknown; name?: unknown };
  try {
    llmResponse = await llmJson<{ steps?: unknown[]; startPage?: unknown; name?: unknown }>(
      prompt,
      model,
      { max_tokens: 4096, system: "You are a workflow compiler. Respond ONLY with valid JSON." }
    );
  } catch (err) {
    console.error("[planner] LLM call failed:", (err as Error).message);
    return { ok: false, error: `LLM compilation failed: ${(err as Error).message}` };
  }

  // 5. Validate
  const validation = validateCompiledWorkflow(llmResponse, appMap);
  if (!validation.valid || !validation.workflow) {
    console.error("[planner] Validation failed:", validation.errors);
    return {
      ok: false,
      error: `Compiled workflow validation failed: ${validation.errors.map((e) => `${e.stepId ? `[${e.stepId}] ` : ""}${e.message}`).join("; ")}`,
    };
  }

  const workflow = validation.workflow;
  workflow.source = sanitizedInstruction;
  workflow.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1;
  workflow.recoveryModel = canonicalModelOverride(options.recoveryModel);
  canonicalizeCompiledWorkflow(workflow);

  // 6. Save to DB
  let workflowId: string;
  try {
    const insertResult = await db.query(
      `INSERT INTO compiled_workflows (name, source, app_id, app_map_version, cache_key, compiled_data, status, total_steps)
       VALUES ($1, $2, $3, $4, $5, $6, 'compiled', $7)
       RETURNING id`,
      [
        workflow.name,
        sanitizedInstruction,
        appId,
        appMap.version,
        cacheKey,
        JSON.stringify(workflow),
        workflow.steps.length,
      ]
    );
    workflowId = insertResult.rows[0].id;
    workflow.id = workflowId;
  } catch (err) {
    // If table doesn't exist, return workflow without persisting
    console.warn("[planner] Could not save to compiled_workflows (table may not exist):", (err as Error).message);
    workflow.id = crypto.randomUUID();
    workflowId = workflow.id;
  }

  console.log(
    `[planner] Compiled workflow "${workflow.name}" (${workflow.steps.length} steps) for "${sanitizedInstruction.slice(0, 60)}..."`
  );

  return {
    ok: true,
    workflowId,
    compiledWorkflow: workflow,
    fromCache: false,
  };
}

/**
 * Get a compiled workflow by ID.
 */
export async function getCompiledWorkflow(workflowId: string): Promise<CompileResult> {
  const db = getDb();
  try {
    const result = await db.query(
      `SELECT id, compiled_data, status, steps_completed, recovery_count
       FROM compiled_workflows WHERE id = $1`,
      [workflowId]
    );
    if (result.rows.length === 0) {
      return { ok: false, error: `Compiled workflow not found: ${workflowId}` };
    }
    const row = result.rows[0];
    const compiledData = typeof row.compiled_data === "string"
      ? JSON.parse(row.compiled_data)
      : row.compiled_data;
    const workflow = canonicalizeCompiledWorkflow(compiledData);
    (workflow as CompiledWorkflow & { _meta?: unknown })._meta = {
      status: row.status,
      stepsCompleted: row.steps_completed,
      recoveryCount: row.recovery_count,
    };
    return { ok: true, workflowId: row.id, compiledWorkflow: workflow };
  } catch (err) {
    return { ok: false, error: `DB error: ${(err as Error).message}` };
  }
}

/**
 * Update compiled workflow status in DB.
 */
export async function updateWorkflowStatus(
  workflowId: string,
  status: string,
  stepsCompleted?: number,
  recoveryCount?: number,
  executionStats?: Record<string, unknown>
): Promise<void> {
  const db = getDb();
  try {
    const sets: string[] = ["status = $2", "updated_at = NOW()"];
    const values: unknown[] = [workflowId, status];
    let paramIdx = 3;

    if (stepsCompleted !== undefined) {
      sets.push(`steps_completed = $${paramIdx++}`);
      values.push(stepsCompleted);
    }
    if (recoveryCount !== undefined) {
      sets.push(`recovery_count = $${paramIdx++}`);
      values.push(recoveryCount);
    }
    if (executionStats !== undefined) {
      sets.push(`execution_stats = $${paramIdx++}`);
      values.push(JSON.stringify(executionStats));
    }

    await db.query(
      `UPDATE compiled_workflows SET ${sets.join(", ")} WHERE id = $1`,
      values
    );
  } catch (err) {
    console.warn("[planner] Failed to update workflow status:", (err as Error).message);
  }
}
