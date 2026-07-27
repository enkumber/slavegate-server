import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const configuredAndroidRoot = process.env.PHONE_NETWORK_ANDROID_ROOT?.trim();
const embeddedAndroidRoot = join(root, "app", "src", "main", "kotlin");
const androidRoot = configuredAndroidRoot
  ? resolve(configuredAndroidRoot)
  : embeddedAndroidRoot;
if (!existsSync(androidRoot)) {
  console.error(
    "Hardcoding audit refused to run: Android source is absent. "
      + "Set PHONE_NETWORK_ANDROID_ROOT to the Android repository root.",
  );
  process.exit(2);
}
const scanTargets = [
  ...["src", "shared", "seeds", "dashboard-src/src"].map((path) => ({
    root,
    path,
    prefix: "",
  })),
  {
    root: androidRoot.endsWith(join("app", "src", "main", "kotlin"))
      ? resolve(androidRoot, "..", "..", "..", "..")
      : androidRoot,
    path: androidRoot.endsWith(join("app", "src", "main", "kotlin"))
      ? "app/src/main/kotlin"
      : "app/src/main/kotlin",
    prefix: "android/",
  },
];
const extensions = new Set([".ts", ".tsx", ".sql", ".kt", ".js", ".json", ".yaml", ".yml"]);
const ignored = [
  /\.test\.(?:ts|tsx)$/,
  /\/dist\//,
  /\/build\//,
  /\/node_modules\//,
];
const forbiddenPaths = [
  {
    id: "packaged-filesystem-workflow",
    pattern: /^(?:src\/modules\/workflows|seeds\/workflow-templates)\/.*\.(?:json|ya?ml)$/i,
  },
  {
    id: "packaged-application-map",
    pattern: /^seeds\/.*(?:map|selector|transition).*\.(?:json|ya?ml)$/i,
  },
  {
    id: "tracked-production-backup",
    pattern: /(?:^|\/)src\/.*\.backup$/i,
  },
];
const isDatabaseSchema = (path) =>
  path.includes("/src/db/migrations/") || path.endsWith("/src/db/schema.sql");

const rules = [
  {
    id: "migration-packaged-product-data",
    scope: isDatabaseSchema,
    pattern: /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:workflow_shortcuts|app_runtime_profiles|skill_definitions|runtime_semantic_entries|workflow_runtime_contracts|workflow_capabilities|workflow_capability_artifacts|system_prompts|system_config|model_configs|vision_config)\b/gi,
  },
  {
    id: "migration-semantic-status-constraint",
    scope: isDatabaseSchema,
    pattern: /\bCHECK\s*\([^;]*(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope|type|kind|strategy|source|role|method|purpose|category|severity|rating)\s+(?:IN\s*\(|=\s*ANY\s*\()/gi,
  },
  {
    id: "migration-semantic-lifecycle-seed",
    scope: isDatabaseSchema,
    // Generic functions may insert caller-supplied/discovered bindings. Only
    // packaged literal rows are product semantics and therefore forbidden.
    pattern: /\bINSERT\s+INTO\s+lifecycle_(?:state_definitions|transitions|resource_bindings|resource_policies)\b[\s\S]{0,500}?\bVALUES\s*\(\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/gi,
  },
  {
    id: "migration-semantic-state-default",
    scope: isDatabaseSchema,
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope|type|kind|strategy|source|role|method|purpose|category|severity|rating|branch_key)\b[^,;\n]*\bDEFAULT\s+["'][A-Za-z][A-Za-z0-9_./:-]*["']/gi,
  },
  {
    id: "migration-semantic-state-sql",
    scope: isDatabaseSchema,
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope|type|kind|strategy|source|role|method|purpose|category|severity|rating)\s*(?:=|<>|!=|(?:NOT\s+)?IN\s*\()\s*["'(][A-Za-z][A-Za-z0-9_-]*/gi,
  },
  {
    id: "migration-operational-policy-default",
    scope: isDatabaseSchema,
    pattern: /\b(?:timeout_ms|delay_ms|interval_ms|max_retries|max_attempts|attempt_limit|priority|confidence_threshold|min_match_score|ambiguity_margin|required_distinct_devices|required_distinct_branches|device_class|orientation|font_scale_bucket|screen_type_key|learn_method|resolution_method|state_resolution_method|target_resolution_method|selector_first|graph_runtime|ai_recovery|candidate_learning|auto_promotion|safety_classes|assigned_agent|incident_commander|remediation_owner|recovery_exhausted|timezone|simulated_timezone|(?:p_)?actor)\b[^,;\n]*\bDEFAULT\s+(?:-?\d[\d.]*(?:\b|::)|TRUE\b|FALSE\b|["'][^"']+["'])/gi,
  },
  {
    id: "migration-product-policy-seed",
    scope: isDatabaseSchema,
    pattern: /\bINSERT\s+INTO\s+(?:runtime_semantic_entries|workflow_runtime_contracts|workflow_capabilities|workflow_capability_artifacts|job_status_definitions|task_status_definitions|workflow_status_definitions|agency_workflow_run_status_definitions|research_job_status_definitions)\b/gi,
  },
  {
    id: "migration-semantic-row-seed",
    scope: isDatabaseSchema,
    pattern: /\bINSERT\s+INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope|type|kind|strategy|source|role|method|purpose|category|severity|rating)\b[^)]*\)\s*VALUES\s*\(?[\s\S]{0,500}?["'][A-Za-z][A-Za-z0-9_.:-]*["']/gi,
  },
  {
    id: "runtime-status-name-branch",
    scope: (path) => !path.includes("/src/db/migrations/")
      && !path.startsWith("/android/app/src/main/kotlin/com/phonenetwork/service/"),
    pattern: /\b(?:[A-Za-z][A-Za-z0-9_]*_(?:status|state)|status|state|lifecycleStatus|lifecycle_status|candidateState|candidate_state|promotionState|promotion_state|libraryState|library_state|safetyClass|safety_class|portabilityScope|portability_scope|mode|scope)\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-decision-name-branch",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:decision|phase|outcome|artifactState|artifact_state|validationStage|validation_stage|action|actionKey|action_key)\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-product-action-name-branch",
    scope: (path) => path.endsWith("/src/api/agency-routes.ts")
      || path.includes("/dashboard-src/src/pages/"),
    pattern: /\baction\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-product-action-packaged-value",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\baction\s*:\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-product-action-literal-union",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:[A-Za-z][A-Za-z0-9_]*Action|action)\??\s*:\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])+/g,
  },
  {
    id: "runtime-job-action-literal-union",
    scope: (path) => /\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:[A-Za-z][A-Za-z0-9_]*(?:JobType|ActionType))\s*=\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])+/g,
  },
  {
    id: "android-action-dispatch-name",
    // Native Android primitives are an ABI boundary; workflow/product action
    // keys must not dispatch Android code by name. Keep this rule targeted at
    // legacy action catalogs and name-based runtime dispatch, not platform
    // parameter parsing such as key names, intent flags, directions, or parser
    // structure tags.
    scope: (path) => path.endsWith(".kt")
      && /\/(?:executor|workflow)\//.test(path),
    pattern: /\b(?:EDGE_V2_ACTIONS|OBSERVATION_ONLY_JOB_TYPES|when\s*\(\s*(?:action|stepType|jobType)\s*\))/g,
  },
  {
    id: "runtime-status-name-sql",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|decision|mode|phase|outcome|action_key|safety_class|portability_scope)\s*(?:=|<>|!=|(?:NOT\s+)?IN\s*\()\s*(?:["'][A-Za-z][A-Za-z0-9_.:-]*|\(\s*["'][A-Za-z][A-Za-z0-9_.:-]*)/gi,
  },
  {
    id: "runtime-semantic-includes-set",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /(?:\(\s*)?\[\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*,\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])+\s*\](?:\s+as\s+[^)]*)?\)?\.includes\(\s*(?:[A-Za-z][A-Za-z0-9_]*_(?:status|state)|status|state|decision|phase|outcome|action|actionKey|boundary|rootKind|operationKind|mode|scope)\b/g,
  },
  {
    id: "runtime-semantic-named-set",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b(?:[A-Z][A-Z0-9_]*(?:STATUS(?:ES)?|STATE(?:S)?|DECISION(?:S)?|PHASE(?:S)?|OUTCOME(?:S)?|ACTION_KEYS|BOUNDAR(?:Y|IES)|MODE(?:S)?|SCOPE(?:S)?|SAFETY_CLASSES|PORTABILITY_SCOPES)[A-Z0-9_]*|[A-Z][A-Z0-9_]*(?:ALLOWED|SAFE)[A-Z0-9_]*ACTIONS[A-Z0-9_]*)\s*=\s*(?:new\s+Set\s*\()?\[\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*,\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])+/g,
  },
  {
    id: "runtime-action-named-set",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b[A-Z][A-Z0-9_]*ACTIONS?[A-Z0-9_]*\s*=\s*(?:new\s+Set\s*\()?\[\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-interpreter-name-branch",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b(?:distribution|check|operator|verification|failureMode)\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-mapping-action-name-branch",
    scope: (path) => path.includes("/src/modules/app-mapping/") && /\.(?:ts|tsx)$/.test(path),
    pattern: /\bstep\.type\s*(?:===|!==|==|!=)\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-dispatch-action-literal",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:dispatchAndAwaitRefresh|dispatchLegacyGeneratedWorkflow|dispatchGeneratedWorkflowProbe)\s*\([^)]{0,240}?["'][A-Za-z][A-Za-z0-9_.:-]*["']/gs,
  },
  {
    id: "runtime-workflow-operational-default",
    scope: (path) => !path.includes("/src/db/migrations/")
      && /\/(?:workflows|workflow-compiler|app-mapping|ui-graph|executor)\//.test(path)
      && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b(?:timeoutMs|retryDelayMs|delayAfterMs|pollIntervalMs|maxAttemptsPerStep|maxAttemptsPerWorkflow|maxRecoveryActionsPerAttempt|probability|distribution|verification|failureMode)\b[^;\n]{0,80}?\?\?\s*(?:-?\d[\d_]*(?:\.\d+)?|true|false|["'][A-Za-z][A-Za-z0-9_.:-]*["'])/g,
  },
  {
    id: "runtime-semantic-rank-map",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b[A-Z][A-Z0-9_]*(?:RANK|PRIORITY|ORDER)[A-Z0-9_]*\s*:\s*Record<[^>]+>\s*=\s*\{\s*[A-Za-z][A-Za-z0-9_.:-]*\s*:\s*\d+/g,
  },
  {
    id: "runtime-operational-numeric-threshold",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b(?:attemptsMade|retryCount|retry_count|failureCount|failure_count|successCount|success_count|recoveryCount|recovery_count|distinctDevices|distinct_devices|distinctBranches|distinct_branches)\s*(?:>=|>|<=|<)\s*\d+/g,
  },
  {
    id: "runtime-status-literal-union",
    scope: (path) => /\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:status|state|lifecycleStatus|candidateState|promotionState|libraryState|safetyClass|portabilityScope|actionKey)\??\s*:\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])+/g,
  },
  {
    id: "runtime-decision-literal-union",
    scope: (path) => /\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:decision|phase|outcome|artifactState|validationStage)\??\s*:\s*["'][A-Za-z][A-Za-z0-9_-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_-]*["'])+/g,
  },
  {
    id: "runtime-product-semantic-literal-union",
    scope: (path) => /\/(?:src|shared|dashboard-src\/src)\/.*\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:Intent|SafetyClass|AllowedAction|AllowedRecoveryRequest|Platform|InteractionEffect|PostconditionOperator)\b\s*=\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])*/g,
  },
  {
    id: "runtime-named-transition-target",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:toState|targetStatus|fromStatus)\s*:\s*["'][A-Za-z][A-Za-z0-9_-]*["']/g,
  },
  {
    id: "runtime-named-transition-source-set",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx)$/.test(path),
    pattern: /\bfromStates\s*:\s*\[\s*["'][A-Za-z][A-Za-z0-9_-]*["']/g,
  },
  {
    id: "runtime-packaged-status-value",
    scope: (path) => !path.includes("/src/db/migrations/")
      && !path.startsWith("/android/app/src/main/kotlin/"),
    pattern: /(?:\bstatus\s*:\s*["'][A-Za-z][A-Za-z0-9_-]*["']|put\(\s*["']status["']\s*,\s*["'][A-Za-z][A-Za-z0-9_-]*["']\s*\))/g,
  },
  {
    id: "runtime-lifecycle-key-literal",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b(?:lifecycleKey|lifecycle_key|actionKey|action_key)\s*[:=]\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "android-status-name",
    scope: (path) => path.endsWith(".kt") && /\/(?:executor|workflow)\//.test(path),
    pattern: /\b(?:status|state|actionKey)\s*(?:==|!=)\s*"[A-Za-z][A-Za-z0-9_-]*"/g,
  },
  {
    id: "android-workflow-operational-default",
    scope: (path) => path.endsWith(".kt") && /\/workflow\/WorkflowStep\.kt$/.test(path),
    pattern: /\bopt(?:Int|Long|Double|Boolean)\(\s*"[^"]+"\s*,\s*(?:-?\d[\d_]*(?:\.\d+)?[Lf]?|true|false)\s*\)/g,
  },
  {
    id: "android-workflow-product-string-default",
    scope: (path) => path.endsWith(".kt") && /\/workflow\/WorkflowStep\.kt$/.test(path),
    pattern: /\boptString\(\s*"[^"]+"\s*,\s*"[A-Za-z][A-Za-z0-9_.:-]*"\s*\)/g,
  },
  {
    id: "android-workflow-operational-constant",
    scope: (path) => path.endsWith(".kt") && /\/workflow\/WorkflowStep\.kt$/.test(path),
    pattern: /\b(?:const\s+val|val)\s+[A-Z][A-Z0-9_]*(?:TIMEOUT|RETRY|DELAY|INTERVAL|MAX|MIN)[A-Z0-9_]*\s*=\s*\d[\d_]*/g,
  },
  {
    id: "android-product-specific-handler",
    scope: (path) => path.endsWith(".kt") && /\/(?:executor|workflow)\//.test(path),
    pattern: /\b(?:fun|suspend\s+fun)\s+\w*(?:Reddit|Instagram|RustDesk|Outreach|Comment|Following)\w*\s*\(/gi,
  },
];

function filesUnder(directory) {
  const output = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const normalized = path.replaceAll("\\", "/");
    if (ignored.some((pattern) => pattern.test(normalized))) continue;
    if (statSync(path).isDirectory()) output.push(...filesUnder(path));
    else output.push(path);
  }
  return output;
}

const violations = [];
for (const target of scanTargets) {
  const directory = join(target.root, target.path);
  for (const path of filesUnder(directory)) {
    const displayPath = `${target.prefix}${relative(target.root, path).replaceAll("\\", "/")}`;
    for (const rule of forbiddenPaths) {
      if (rule.pattern.test(displayPath)) {
        violations.push({
          rule: rule.id,
          path: displayPath,
          line: 1,
          text: "release-packaged product semantics must be stored in PostgreSQL",
        });
      }
    }
    if (!extensions.has(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    for (const rule of rules) {
      if (!rule.scope(`/${displayPath}`)) continue;
      rule.pattern.lastIndex = 0;
      for (const match of source.matchAll(rule.pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push({
          rule: rule.id,
          path: displayPath,
          line,
          text: match[0].replace(/\s+/g, " ").slice(0, 180),
        });
      }
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `${violation.rule}: ${violation.path}:${violation.line}: ${violation.text}`,
    );
  }
  console.error(`Hardcoding audit failed with ${violations.length} violation(s).`);
  process.exit(1);
}

console.log("Hardcoding audit passed: no packaged lifecycle/status semantics found.");
