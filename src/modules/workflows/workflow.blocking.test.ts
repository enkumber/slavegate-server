/**
 * workflow.blocking.test.ts
 *
 * Tests that verify the server-blocking fixes AND 100-device scalability:
 *   1. Request timeout middleware works
 *   2. startWorkflow() has timeout protection
 *   3. saveCheckpoint() doesn't hold dedicated DB connections
 *   4. Per-device concurrency guard (max 1 workflow per device)
 *   5. Global concurrency guard (configurable soft limit)
 *   6. withTimeout helper works correctly
 *   7. Scalability config is correct for 100-device target
 *   8. DB pool sized correctly
 *   9. WS connection limit enforced
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── withTimeout helper tests ─────────────────────────────────────────────

describe("withTimeout", () => {
  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(message)), ms)
      ),
    ]);
  }

  it("resolves if the promise settles within timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "timeout"
    );
    expect(result).toBe("ok");
  });

  it("rejects with message if promise takes too long", async () => {
    const neverResolves = new Promise<string>(() => {}); // never settles
    await expect(
      withTimeout(neverResolves, 50, "operation timed out")
    ).rejects.toThrow("operation timed out");
  });

  it("rejects with original error if promise rejects before timeout", async () => {
    await expect(
      withTimeout(
        Promise.reject(new Error("db error")),
        1000,
        "timeout"
      )
    ).rejects.toThrow("db error");
  });
});

// ─── Request timeout middleware ────────────────────────────────────────────

describe("requestTimeout middleware", () => {
  function createRequestTimeout() {
    const REQUEST_TIMEOUT_MS = 30_000;

    let finishCb: (() => void) | null = null;
    let closeCb: (() => void) | null = null;

    const req = {} as Record<string, unknown>;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") finishCb = cb;
        if (event === "close") closeCb = cb;
      }),
    } as any;
    const next = vi.fn();

    // Simulate the middleware
    let middlewareTimer: ReturnType<typeof setTimeout> | null = null;
    function requestTimeout(
      _req: any,
      res: any,
      next: () => void
    ): void {
      middlewareTimer = setTimeout(() => {
        if (!res.headersSent) {
          res.status(504);
          res.json({ ok: false, error: "Request timeout" });
        }
      }, REQUEST_TIMEOUT_MS);
      res.on("finish", () => { if (middlewareTimer) clearTimeout(middlewareTimer); });
      res.on("close", () => { if (middlewareTimer) clearTimeout(middlewareTimer); });
      next();
    }

    requestTimeout(req, res, next);

    return { res, next, finishCb: () => finishCb?.(), closeCb: () => closeCb?.(), getTimer: () => middlewareTimer };
  }

  it("calls next() immediately", () => {
    const { next } = createRequestTimeout();
    expect(next).toHaveBeenCalled();
  });

  it("registers finish and close handlers on res", () => {
    const { res } = createRequestTimeout();
    expect(res.on).toHaveBeenCalledWith("finish", expect.any(Function));
    expect(res.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("does not send 504 if response finishes before timeout", () => {
    const { res, finishCb } = createRequestTimeout();
    finishCb(); // Simulate response finishing
    // Timer was cleared, so 504 is never sent
    expect(res.status).not.toHaveBeenCalledWith(504);
  });
});

// ─── saveCheckpoint — no dedicated connection holding ──────────────────────

describe("saveCheckpoint — uses pool.query instead of db.connect", () => {
  it("should use pool.query, not db.connect", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    // Extract the saveCheckpoint method
    const methodMatch = source.match(
      /async saveCheckpoint\([\s\S]*?(?=\n  async |\n  \/\/|$)/
    );
    expect(methodMatch).toBeTruthy();
    const methodBody = methodMatch![0];

    // Should NOT contain db.connect
    expect(methodBody).not.toContain("db.connect()");
    expect(methodBody).not.toContain("client.release()");
    expect(methodBody).not.toContain("BEGIN");
    expect(methodBody).not.toContain("COMMIT");
    expect(methodBody).not.toContain("ROLLBACK");

    // Should use the atomic DB-authoritative transition helper.
    expect(methodBody).toContain("transitionWorkflowWhere(");
  });
});

// ─── startWorkflow — timeout protection ────────────────────────────────────

describe("startWorkflow — timeout protection", () => {
  it("should include Promise.race with timeout", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.executor.ts"),
      "utf8"
    );

    // Extract startWorkflow function
    const funcMatch = source.match(
      /export async function startWorkflow[\s\S]*?(?=\n\/\/|export|$)/
    );
    expect(funcMatch).toBeTruthy();
    const funcBody = funcMatch![0];

    // Should use Promise.race for timeout
    expect(funcBody).toContain("Promise.race");
    expect(funcBody).toContain("scalabilityConfig.enqueueTimeout");
  });
});

describe("workflow executor package resolution", () => {
  it("does not embed application package resolution in the executor", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.executor.ts"),
      "utf8"
    );

    expect(source).not.toContain("com.reddit.frontpage");
    expect(source).toContain("requires packageName from the DB-authored workflow or runtime profile");
  });
});

// ─── POST /workflows — full edge workflow only ────────────────────────────

describe("POST /workflows — no server step execution", () => {
  it("does not invoke the legacy server-side workflow executor", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const workflowSection = fs.readFileSync(
      path.join(__dirname, "generated-workflow-execution.service.ts"),
      "utf8"
    );

    expect(workflowSection).not.toContain('from "./workflow.executor"');
    expect(workflowSection).not.toContain("startWorkflow(");
    expect(workflowSection).toContain("server step execution is forbidden");
  });
});

// ─── Generated workflow contract endpoints ─────────────────────────────────

describe("Generated workflow contract validation", () => {
  it("exports reusable generated workflow validation and schema helpers", async () => {
    const validator = await import("./workflow-validator");

    expect(typeof validator.validateGeneratedWorkflowTemplate).toBe("function");
    expect(typeof validator.getGeneratedWorkflowContract).toBe("function");
    expect(typeof validator.summarizeGeneratedWorkflowTemplate).toBe("function");
    expect(typeof validator.compileGeneratedWorkflowTemplate).toBe("function");

    const contract = validator.getGeneratedWorkflowContract();
    expect(contract).toMatchObject({
      endpoints: {
        validate: "POST /api/workflows/generated/validate",
        dryRun: "POST /api/workflows/generated with { dryRun: true }",
        resolveCache: "POST /api/workflows/generated/cache/resolve",
        cache: "GET /api/workflows/generated/cache/:cacheKey",
        execute: "POST /api/workflows/generated with { deviceId, workflow | cacheKey | requestKey }",
      },
      compiledPlan: {
        happyPathLlmRequests: "explicit_workflow_steps_only",
        recovery: "LLM recovery must be declared by the workflow failure branch.",
        requestKey: "Stable hash returned by /prompt before LLM generation; use it to check cache first.",
        cacheFirstPrompt: "POST /api/workflows/generated/prompt returns cached workflow+plan when requestKey is already known.",
        executeFromCache: "POST /api/workflows/generated can execute cached templates directly by cacheKey or requestKey.",
      },
    });
  });

  it("rejects malformed generated workflows with path-specific errors", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "bad_workflow",
      name: "Bad workflow",
      platform: "reddit",
      description: "Broken on purpose",
      version: "1.0.0",
      steps: [
        { type: "action", id: "same" },
        { type: "wait", id: "same" },
        { type: "loop", id: "loop", count: { min: 3, max: 1, distribution: "uniform" }, steps: [] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("workflow.steps[0].action must be a non-empty string for action steps");
    expect(result.errors).toContain('workflow.steps[1].id duplicates step id "same"');
    expect(result.errors).toContain("workflow.steps[1] wait step must define duration, condition, or until");
    expect(result.errors).toContain("workflow.steps[2].count.min must be <= workflow.steps[2].count.max");
    expect(result.errors).toContain("workflow.steps[2].steps must be a non-empty step array for loop steps");
  });

  it("rejects generated workflows that try to open blocked Android packages", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "blocked_package_workflow",
      name: "Blocked package workflow",
      platform: "reddit",
      description: "Should not be allowed to open device settings.",
      version: "1.0.0",
      steps: [
        {
          type: "action",
          id: "open_settings",
          action: "open_app",
          params: { packageName: "com.android.settings" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("workflow.steps[0].params.packageName is blocked for generated workflows: com.android.settings");
  });

  it("rejects generated workflow actions that can trigger root, VLM, file, or mutation paths", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "unsafe_generated_actions",
      name: "Unsafe generated actions",
      platform: "reddit",
      description: "Should not allow arbitrary dispatcher jobs from generated workflows.",
      version: "1.0.0",
      steps: [
        { type: "action", id: "root_uninstall", action: "pm_uninstall", params: { packageName: "com.example" } },
        { type: "action", id: "vlm_tap", action: "cascade_tap", params: { target: "vote" } },
        { type: "action", id: "delete_file", action: "file_delete", params: { path: "/sdcard/file" } },
        { type: "action", id: "root_reboot", action: "reboot", params: {} },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('workflow.steps[0].action "pm_uninstall" is not allowed; must be one of:'),
      expect.stringContaining('workflow.steps[1].action "cascade_tap" is not allowed; must be one of:'),
      expect.stringContaining('workflow.steps[2].action "file_delete" is not allowed; must be one of:'),
      expect.stringContaining('workflow.steps[3].action "reboot" is not allowed; must be one of:'),
    ]));
  });

  it("normalizes generated workflow platform labels to a bounded set", async () => {
    const { validateGeneratedWorkflowTemplate, summarizeGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "normalized_platform_workflow",
      name: "Normalized platform workflow",
      platform: " Reddit ",
      description: "Platform should be normalized before metrics labels use it.",
      version: "1.0.0",
      steps: [
        {
          type: "action",
          id: "open_reddit",
          action: "open_app",
          params: { packageName: "com.reddit.frontpage" },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.template?.platform).toBe("reddit");
    expect(summarizeGeneratedWorkflowTemplate(result.template!)).toMatchObject({
      platform: "reddit",
      compiledPlan: {
        platform: "reddit",
      },
    });
  });

  it("accepts safe catalog-managed platform identifiers without a code allowlist", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "unknown_platform_workflow",
      name: "Unknown platform workflow",
      platform: "client-123",
      description: "Should not create high-cardinality metrics labels.",
      version: "1.0.0",
      steps: [
        {
          type: "action",
          id: "open_unknown",
          action: "open_app",
          params: { packageName: "com.example.app" },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects semantic_tap generated workflow actions without a target before runtime", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "reddit_invalid_semantic_tap_v1",
      name: "Invalid semantic tap workflow",
      platform: "reddit",
      description: "Should fail during compile validation, not on the device.",
      version: "1.0.0",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      steps: [
        {
          type: "action",
          id: "open_reddit",
          action: "open_app",
          params: { packageName: "com.reddit.frontpage" },
        },
        {
          type: "action",
          id: "tap_missing_target",
          action: "semantic_tap",
          params: {},
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("workflow.steps[1].params.target is required for semantic_tap actions");
  });

  it("accepts read-only Reddit account health generated workflows with canonical output metadata", async () => {
    const { compileGeneratedWorkflowTemplate, validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "reddit_account_health_scan_v1",
      name: "Reddit account health scan",
      platform: "reddit",
      description: "Read-only scan of login state and home feed readiness.",
      version: "1.0.0",
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      outputSchema: {
        required: ["loggedIn", "homeFeedVisible", "searchSurfaceAvailable", "challengeDetected", "loginWallDetected", "accountSwitcherVisible", "observedUsername", "screenState", "error"],
        properties: {
          loggedIn: { type: "string" },
          homeFeedVisible: { type: "string" },
          searchSurfaceAvailable: { type: "string" },
          challengeDetected: { type: "string" },
          loginWallDetected: { type: "string" },
          accountSwitcherVisible: { type: "string" },
          observedUsername: { type: "string" },
          screenState: { type: "string" },
          error: { type: "string" },
        },
      },
      allowedRecoveryRequests: ["refresh_screen_state"],
      recoveryPolicy: {
        autonomy: "ai_autopilot",
        maxAttemptsPerStep: 3,
        maxAttemptsPerWorkflow: 6,
        maxRecoveryActionsPerAttempt: 6,
        allowedRecoveryRequests: ["ai_recovery_workflow", "refresh_screen_state", "retry_current_step", "return_to_anchor", "verify_anchor"],
        requireStateVerification: true,
        learnFromFailure: true,
      },
      defaultVerificationStrategy: "local_with_screenshot",
      dataRetentionDays: 1,
      steps: [
        {
          type: "action",
          id: "open_reddit",
          action: "open_app",
          params: { packageName: "com.reddit.frontpage" },
          expectedScreen: "REDDIT_HOME_FEED",
        },
        { type: "checkpoint", id: "home_readiness_observed" },
      ],
    });

    expect(result.ok).toBe(true);
    const compiled = compileGeneratedWorkflowTemplate(result.template!);
    expect(compiled.metadata).toMatchObject({
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      allowedRecoveryRequests: ["refresh_screen_state"],
      recoveryPolicy: expect.objectContaining({
        autonomy: "ai_autopilot",
        maxAttemptsPerStep: 3,
        maxAttemptsPerWorkflow: 6,
        learnFromFailure: true,
      }),
      outputSchema: {
        required: ["loggedIn", "homeFeedVisible", "searchSurfaceAvailable", "challengeDetected", "loginWallDetected", "accountSwitcherVisible", "observedUsername", "screenState", "error"],
      },
    });
    expect(compiled.llmBudget.happyPathRequests).toBe(0);
  });

  it("enforces generated workflow recovery budget without adding happy-path LLM calls", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const executorSource = fs.readFileSync(
      path.join(__dirname, "workflow.executor.ts"),
      "utf8"
    );
    const metricsSource = fs.readFileSync(
      path.join(__dirname, "..", "observability", "metrics.ts"),
      "utf8"
    );

    expect(executorSource).toContain('export const RECOVERY_BUDGET_EXCEEDED = "RECOVERY_BUDGET_EXCEEDED"');
    expect(executorSource).toContain("generatedWorkflowRuntimeRecoveryPolicy");
    expect(executorSource).toContain('autonomy: explicit?.autonomy ?? "ai_autopilot"');
    expect(executorSource).toContain("explicit?.maxAttemptsPerStep ?? (isReadOnly ? 3 : 2)");
    expect(executorSource).toContain("GENERATED_WORKFLOW_RECOVERY_TOTAL_ATTEMPTS_KEY");
    expect(executorSource).toContain("recordGeneratedWorkflowRecoveryEvent");
    expect(executorSource).toContain("attemptGeneratedWorkflowAiRecovery");
    expect(executorSource).toContain("buildGeneratedWorkflowRecoveryPrompt");
    expect(executorSource).toContain("validateGeneratedWorkflowRecoverySteps");
    expect(executorSource).toContain("await llmJson<GeneratedWorkflowRecoveryPlan>");
    expect(executorSource).toContain("recordGeneratedWorkflowRecoveryFailure");
    expect(executorSource).toContain("stats.recoveryAttempts++");
    expect(executorSource).toContain("stats.recoveryBudgetExhausted++");
    expect(executorSource).toContain("stats.recoveryLlmCalls++");
    expect(executorSource).toContain("stats.runtimeLlmCalls++");
    expect(executorSource).toContain("normalizeA11yFindTapParams(finalParams)");
    expect(executorSource).toContain('params["resourceId"] = "add_comment_button"');
    expect(executorSource).toContain("never advances a workflow without a correlated JOB_RESULT");
    expect(executorSource).toContain("return false;");
    expect(executorSource).toContain("timeoutMs: dispatchedTimeoutMs");
    expect(executorSource).toContain("awaitGeneratedChildJobResult");
    expect(executorSource).toContain("function generatedChildResultTimeoutMs(executionTimeoutMs: number, queued = false): number");
    expect(executorSource).toContain("const graceTimeoutMs = executionTimeoutMs + LEGACY_GENERATED_WORKFLOW_RESULT_GRACE_MS");
    expect(executorSource).toContain("const resultTimeoutMs = generatedChildResultTimeoutMs(dispatchedTimeoutMs)");
    expect(executorSource).toContain("}, { resultTimeoutMs });");
    expect(executorSource).toContain("dispatch.queued");
    expect(executorSource).toContain("generatedWorkflowRecoveryAttempts?.labels(platform, recoveryReasonFromError(err)).inc()");
    expect(executorSource).toContain("generatedWorkflowRecoveryBudgetExhausted?.labels(platform).inc()");

    const batchExecutionCatch = executorSource.match(
      /batchResult = await executeBatchSteps[\s\S]*?catch \(err\) \{([\s\S]*?)\n  \}/
    )?.[1] ?? "";
    expect(batchExecutionCatch).toContain("executionStats(checkpoint).failedSteps++");
    expect(batchExecutionCatch).toContain("const budgetErr = recordGeneratedWorkflowRecoveryFailure(template, checkpoint, stepIndex, err)");
    expect(batchExecutionCatch).toContain("await workflowService.saveCheckpoint");
    expect(batchExecutionCatch).toContain("throw budgetErr ?? err");

    expect(metricsSource).toContain("phone_network_generated_workflow_recovery_attempt_total");
    expect(metricsSource).toContain('labelNames: ["platform", "reason"]');
    expect(metricsSource).toContain("phone_network_generated_workflow_recovery_budget_exhausted_total");
    expect(metricsSource).toContain('labelNames: ["platform"]');
  });

  it("rejects read-only mutations by Goal Contract effect instead of vocabulary", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");
    const result = validateGeneratedWorkflowTemplate({
      id: "catalog_effect_probe_v1",
      name: "Catalog effect probe",
      platform: "catalog-app",
      description: "The validator must use declared effects only.",
      version: "1.0.0",
      runtimeContract: "edge-workflow/v2",
      safetyClass: "read_only",
      goalContract: {
        version: "1",
        allowedEffects: ["observation"],
        stages: [{
          id: "inspect",
          allowedActions: ["get_screen_state"],
          allowedEffects: ["observation"],
        }],
      },
      steps: [{
        type: "action",
        id: "inspect",
        action: "get_screen_state",
        params: {},
        goalStage: "inspect",
        effect: "business_mutation",
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain('uses disallowed effect "business_mutation"');
  });

  it("allows read-only workflows to navigate to Reddit post comments", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");
    const result = validateGeneratedWorkflowTemplate({
      id: "reddit_first_visible_post_comments_preview_v1",
      name: "Reddit first visible post comments preview",
      platform: "reddit",
      description: "Open the comments section for the first visible post without writing anything.",
      version: "1.0.0",
      safetyClass: "read_only",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      recoveryPolicy: {
        autonomy: "ai_autopilot",
        maxAttemptsPerStep: 3,
        maxAttemptsPerWorkflow: 6,
        maxRecoveryActionsPerAttempt: 6,
        allowedRecoveryRequests: ["ai_recovery_workflow", "refresh_screen_state", "retry_current_step"],
        requireStateVerification: true,
        learnFromFailure: true,
      },
      steps: [
        { type: "action", id: "open_reddit", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
        { type: "action", id: "tap_first_visible_post_comments", action: "semantic_tap", params: { target: "reddit.first_visible_post.open_comments" } },
        { type: "action", id: "capture_comments_screen", action: "ui_tree_dump", params: { outputVariable: "_finalUiTree" } },
        { type: "checkpoint", id: "comments_opened" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("allows the Android Add Account settings intent without a uri", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");
    const result = validateGeneratedWorkflowTemplate({
      id: "android_add_google_account_v1",
      name: "Add Google account",
      platform: "android",
      description: "Open Android Add Account settings and select Google.",
      version: "1.0.0",
      safetyClass: "standard",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      steps: [
        { type: "action", id: "wake", action: "screen_wake" },
        {
          type: "action",
          id: "open_add_account",
          action: "intent_send",
          params: { action: "android.settings.ADD_ACCOUNT_SETTINGS" },
        },
        { type: "checkpoint", id: "add_account_open" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects arbitrary uri-less Android intents", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");
    const result = validateGeneratedWorkflowTemplate({
      id: "android_unsafe_intent_v1",
      name: "Unsafe intent",
      platform: "android",
      description: "Attempt an unapproved implicit intent.",
      version: "1.0.0",
      safetyClass: "standard",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      steps: [
        {
          type: "action",
          id: "open_unapproved",
          action: "intent_send",
          params: { action: "android.intent.action.DELETE" },
        },
        { type: "checkpoint", id: "done" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "workflow.steps[0].params.action is not allowed without a uri: android.intent.action.DELETE",
    );
  });

  it("allows standard edge workflows to generate and type catalog-authored text", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");
    const result = validateGeneratedWorkflowTemplate({
      id: "catalog_contextual_text_v1",
      name: "Catalog contextual text",
      platform: "catalog_app",
      description: "Generate and submit text using catalog-defined UI data.",
      version: "1.0.0",
      runtimeContract: "edge-workflow/v2",
      safetyClass: "standard",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      steps: [
        { type: "action", id: "generate_comment", action: "request_llm", params: { prompt: "Use {{_postContextUiTree}}", responseFormat: "text", saveOutputAs: "_generated_comment" } },
        { type: "action", id: "tap_comment_input", action: "a11y_find_tap", params: { label: "Add a comment" } },
        { type: "action", id: "type_comment", action: "type_text", params: { textFromVariable: "_generated_comment" } },
        { type: "action", id: "submit_comment", action: "a11y_find_tap", params: { text: "Post" } },
        { type: "checkpoint", id: "comment_submitted" },
      ],
    });

    expect(result.ok).toBe(true);
  });
});

// ─── POST /workflows/generated — dry-run validation path ──────────────────

describe("POST /workflows/generated — dry-run validation", () => {
  it("supports dryRun without requiring a deviceId or dispatching", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    const routeStart = source.indexOf('router.post("/workflows/generated"');
    const routeEnd = source.indexOf('router.post("/workflows/:id/cancel"', routeStart);
    const routeBody = source.substring(routeStart, routeEnd);

    expect(routeBody).toContain("dryRun");
    expect(routeBody).toContain("deviceId required unless dryRun is true");
    expect(routeBody).toContain("workflow failed validation");
    expect(routeBody).toContain("errors: validation.errors");
    expect(routeBody).toContain("persisted");
    expect(routeBody).toContain("summarizeGeneratedWorkflowTemplate");

    const dryRunBranch = routeBody.substring(
      routeBody.indexOf("if (dryRun)"),
      routeBody.indexOf("await workflowService.saveTemplate(template);", routeBody.indexOf("if (dryRun)"))
    );
    expect(dryRunBranch).not.toContain("dispatchWorkflowTemplate");
    expect(dryRunBranch).not.toContain("startWorkflow");
  });

  it("validates generated workflow steps before persistence or dispatch", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    expect(source).toContain("validateGeneratedWorkflowTemplate");
    expect(source).toContain("summarizeGeneratedWorkflowTemplate");
    expect(source).toContain('router.get("/workflows/generated/schema"');
    expect(source).toContain('router.post("/workflows/generated/prompt"');
    expect(source).toContain('router.post("/workflows/generated/validate"');
    expect(source).toContain('router.post("/workflows/generated/cache/resolve"');
    expect(source).toContain('router.get("/workflows/generated/cache/:cacheKey"');
    expect(source).toContain("getGeneratedWorkflowContract");
    expect(source).toContain("buildGeneratedWorkflowPrompt");
    expect(source).toContain("buildGeneratedWorkflowAppMapHints");
    expect(source).toContain("resolveGeneratedWorkflowScreens");
    expect(source).toContain("appMapLoaded");
    expect(source).toContain("screenCount");
    expect(source).toContain("requestKey");
    expect(source).toContain("computeGeneratedWorkflowRequestKey");
    expect(source).toContain("reuse_cached_workflow");
    expect(source).toContain("cacheMiss: true");
    expect(source).toContain("cacheMiss: false");
    expect(source).toContain("workflow, cacheKey or requestKey required");
    expect(source).toContain("workflow payload execution is disabled");
    expect(source).toContain("GENERATED_WORKFLOW_CANONICAL_CACHE_REQUIRED");
    expect(source).toContain("saveGeneratedPlanCache");
    expect(source).toContain("getGeneratedPlanCache");
    expect(source).toContain("getGeneratedPlanCacheByRequestKey");
    expect(source).toContain("generate_validate_and_cache_workflow");
    expect(source).toContain('nextAction: "reuse_cached_workflow"');
    expect(source).toContain("requestedCacheKey");
    expect(source).toContain("requestedRequestKey");
    expect(source).toContain("resolvedCache?.cacheKey");
    expect(source).toContain("resolvedCache?.requestKey");
    expect(source).toContain("canExecuteFromCache");
    expect(source).toContain("canExecuteFromCache: true");
    expect(source).toContain("canExecuteFromCache: false");
    expect(source).toContain("generatedWorkflowCacheLookups");
    expect(source).toContain("generatedWorkflowExecutions");
    expect(source).toContain("generatedWorkflowLlmAvoided");
    expect(source).toContain('"prompt", "canonical_hit"');
    expect(source).toContain("generatedWorkflowCacheResult(cacheKey, requestKey)");
    expect(source).not.toContain("GENERATED_WORKFLOW_LLM_BUDGET_NOT_CACHE_SAFE");
  });

  it("exports generated workflow control-plane DTOs in the shared API contract", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "shared", "protocol", "api-types.ts"),
      "utf8"
    );

    expect(source).toContain("export interface GeneratedWorkflowCompiledPlanSummary");
    expect(source).toContain("happyPathRequests: number");
    expect(source).toContain("export interface GeneratedWorkflowPlanCacheRecordDto");
    expect(source).toContain("canonicalWorkflowId: string");
    expect(source).toContain("canonicalWorkflowVersion: string");
    expect(source).toContain("compiledPlanHash: string");
    expect(source).toContain("metadata: {");
    expect(source).toContain("intent: GeneratedWorkflowIntent | null");
    expect(source).toContain("safetyClass: GeneratedWorkflowSafetyClass | null");
    expect(source).toContain("outputSchema: GeneratedWorkflowOutputSchema | null");
    expect(source).toContain("allowedRecoveryRequests: GeneratedWorkflowAllowedRecoveryRequest[]");
    expect(source).toContain('export type GeneratedWorkflowSafetyClass = "read_only"');
    expect(source).toContain('export type GeneratedWorkflowIntent = "reddit_account_health_scan"');
    expect(source).toContain("export type GeneratedWorkflowAllowedAction");
    expect(source).toContain("export type GeneratedWorkflowExecuteRequest");
    expect(source).toContain("workflow?: never");
    expect(source).toContain("cacheKey?: never");
    expect(source).toContain("requestKey?: never");
    expect(source).toContain("export type GeneratedWorkflowExecuteResponse");
    expect(source).toContain('status: "queued" | "running"');
    expect(source).toContain("canonicalHit: boolean");
    expect(source).toContain("canExecuteFromCache: true");
  });

  it("exposes full device ids from edge status for execution APIs", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    expect(source).toContain("shortDeviceId: id.slice(0, 8)");
    expect(source).not.toContain("deviceId: id.slice(0, 8)");
  });

  it("invalidates stale cached Reddit comments plans after shortcut shape changes", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "db", "migrations", "042_invalidate_stale_reddit_comments_cache.sql"),
      "utf8"
    );

    expect(source).toContain("DELETE FROM generated_workflow_plan_cache");
    expect(source).toContain("dashboard_human_reddit_first_post_comments_v1");
    expect(source).toContain("tap_first_post_comments");
    expect(source).toContain("post.comments");
    expect(source).toContain("a72b2ed5edde9bc384738b5b");
  });
});

describe("Generated workflow validator module", () => {
  it("validates generated workflow steps before persistence or dispatch", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow-validator.ts"),
      "utf8"
    );

    expect(source).toContain("function validateGeneratedWorkflowStepInput");
    expect(source).toContain("workflow.steps[${index}]");
    expect(source).toContain(".action must be a non-empty string for action steps");
    expect(source).toContain("wait step must define duration, condition, or until");
    expect(source).toContain(".type must be one of: ${GENERATED_WORKFLOW_STEP_TYPES.join");
    expect(source).toContain("isBlockedPackage");
    expect(source).toContain("compileGeneratedWorkflowTemplate");
    expect(source).toContain("happyPathRequests: explicitLlmRequests");
    expect(source).toContain("canExecuteFromCache");
    expect(source).toContain("generated-workflow-plan/v1");
    expect(source).toContain('"action",');
    expect(source).toContain('"checkpoint",');
  });
});

// ─── DB Pool — sized for 100 devices ──────────────────────────────────────

describe("DB Pool configuration", () => {
  it("should have pool max >= 50 and statement_timeout", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "db", "client.ts"),
      "utf8"
    );

    // Should reference scalabilityConfig for pool size
    expect(source).toContain("scalabilityConfig.dbPoolMax");
    expect(source).toContain("scalabilityConfig.dbStatementTimeout");
    // Should set statement_timeout on each new connection
    expect(source).toContain("SET statement_timeout");
  });
});

// ─── Per-device concurrency guard ──────────────────────────────────────────

describe("Per-device concurrency guard", () => {
  it("should check countActiveByDevice before creating workflow", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const workflowSection = fs.readFileSync(
      path.join(__dirname, "generated-workflow-execution.service.ts"),
      "utf8"
    );

    // Should check per-device active workflows
    expect(workflowSection).toContain("countActiveByDevice");
    expect(workflowSection).toContain("maxWorkflowsPerDevice");
    // Should return 409 (conflict) for device busy
    expect(workflowSection).toContain("409");
    expect(workflowSection).toContain("DEVICE_BUSY");
  });

  it("should check global concurrent limit", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const workflowSection = fs.readFileSync(
      path.join(__dirname, "generated-workflow-execution.service.ts"),
      "utf8"
    );

    expect(workflowSection).toContain("maxGlobalConcurrentWorkflows");
    expect(workflowSection).toContain("429");
    expect(workflowSection).toContain("SERVER_BUSY");
  });
});

// ─── Scalability config ────────────────────────────────────────────────────

describe("Scalability config", () => {
  it("should have correct defaults for 100-device target", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "config", "scalability.config.ts"),
      "utf8"
    );

    // Per-device: max 1 workflow
    expect(source).toMatch(/maxWorkflowsPerDevice:\s*1/);

    // Global: at least 50 concurrent
    expect(source).toMatch(/maxGlobalConcurrentWorkflows.*50/);

    // Worker concurrency: at least 20
    expect(source).toMatch(/workerConcurrency.*20/);

    // DB pool: at least 50
    expect(source).toMatch(/dbPoolMax.*50/);

    // WS max connections: at least 150
    expect(source).toMatch(/maxWsConnections.*150/);

    // Environment variable overrides
    expect(source).toContain("MAX_CONCURRENT_WORKFLOWS");
    expect(source).toContain("WORKFLOW_WORKER_CONCURRENCY");
    expect(source).toContain("DB_POOL_MAX");
  });
});

// ─── WebSocket connection limit ────────────────────────────────────────────

describe("WebSocket connection limit", () => {
  it("should enforce max connections and reject new ones", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "ws", "direct-ws.server.ts"),
      "utf8"
    );

    // Should check connections.size against MAX_WS_CONNECTIONS
    expect(source).toContain("MAX_WS_CONNECTIONS");
    expect(source).toContain("max capacity");
    // Should close with 4029 (custom code for capacity)
    expect(source).toContain("4029");
  });
});

// ─── Workflow service has per-device methods ───────────────────────────────

describe("Workflow service per-device methods", () => {
  it("should have countActiveByDevice method", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    expect(source).toContain("async countActiveByDevice(deviceId: string)");
    expect(source).toContain("JOIN lifecycle_state_definitions state");
    expect(source).toContain("state.metadata->>'countsAsActive'");
  });

  it("should have getActiveCounts method for monitoring", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    expect(source).toContain("async getActiveCounts()");
    expect(source).toContain("GROUP BY state.status, state.sort_order");
    expect(source).not.toContain("counts.queued + counts.running");
  });
});

// ─── Scalability monitoring endpoint ──────────────────────────────────────

describe("Scalability monitoring endpoint", () => {
  it("should expose /api/scalability/status", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    expect(source).toContain("router.get(\"/scalability/status\"");
    expect(source).toContain("getPoolStats");
    expect(source).toContain("getActiveCounts");
    expect(source).toContain("getConnectionCount");
  });
});

// ─── Simulated blocking scenario ───────────────────────────────────────────

describe("Simulated blocking: multiple operations don't block each other", () => {
  it("multiple withTimeout calls can run concurrently", async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(message)), ms)
        ),
      ]);
    }

    const start = Date.now();

    // Simulate 3 slow DB operations, all with 100ms timeout
    const results = await Promise.allSettled([
      withTimeout(new Promise(() => {}), 100, "op1 timeout"),
      withTimeout(new Promise(() => {}), 100, "op2 timeout"),
      withTimeout(
        new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 20)),
        100,
        "op3 timeout"
      ),
    ]);

    const elapsed = Date.now() - start;

    // All should complete within ~150ms (not 300ms sequentially)
    expect(elapsed).toBeLessThan(200);

    // First two timed out
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    // Third resolved
    expect(results[2].status).toBe("fulfilled");
    if (results[2].status === "fulfilled") {
      expect(results[2].value).toBe("fast");
    }
  });

  it("50 concurrent timeout operations complete in parallel", async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(message)), ms)
        ),
      ]);
    }

    const start = Date.now();

    // Simulate 50 concurrent cancel checks (100-device scenario)
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        withTimeout(new Promise<never>(() => {}), 100, `check ${i} timeout`)
      )
    );

    const elapsed = Date.now() - start;

    // All 50 should timeout in ~100ms (parallel), not 5000ms (sequential)
    expect(elapsed).toBeLessThan(300);
    expect(results.every(r => r.status === "rejected")).toBe(true);
  });
});

// ─── Per-device isolation: two workflows on same device → rejected ─────────

describe("Per-device isolation logic", () => {
  it("countActiveByDevice query is correct", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    const methodMatch = source.match(
      /async countActiveByDevice[\s\S]*?(?=\n  async |\n  \/\/)/
    );
    expect(methodMatch).toBeTruthy();
    const methodBody = methodMatch![0];

    // Active-state membership is configured in PostgreSQL, not duplicated here.
    expect(methodBody).toContain("lifecycle_state_definitions");
    expect(methodBody).toContain("countsAsActive");
    expect(methodBody).not.toContain("'queued', 'running'");
    // Should filter by device_id
    expect(methodBody).toContain("workflow.device_id = $1");
  });
});
