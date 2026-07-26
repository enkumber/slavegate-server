import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const scanRoots = [
  "src",
  "dashboard-src/src",
  "app/src/main/kotlin",
];
const extensions = new Set([".ts", ".tsx", ".sql", ".kt"]);
const ignored = [
  /\.test\.(?:ts|tsx)$/,
  /\/dist\//,
  /\/build\//,
  /\/node_modules\//,
];

const rules = [
  {
    id: "migration-semantic-status-constraint",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\bCHECK\s*\([^;]*(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope)\s+IN\s*\(/gi,
  },
  {
    id: "migration-semantic-lifecycle-seed",
    scope: (path) => path.includes("/src/db/migrations/"),
    // Generic functions may insert caller-supplied/discovered bindings. Only
    // packaged literal rows are product semantics and therefore forbidden.
    pattern: /\bINSERT\s+INTO\s+lifecycle_(?:state_definitions|transitions|resource_bindings|resource_policies)\b[\s\S]{0,500}?\bVALUES\s*\(\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/gi,
  },
  {
    id: "migration-semantic-state-default",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope)\b[^,;\n]*\bDEFAULT\s+["'][A-Za-z][A-Za-z0-9_-]*["']/gi,
  },
  {
    id: "migration-semantic-state-sql",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope)\s*(?:=|<>|!=|(?:NOT\s+)?IN\s*\()\s*["'(][A-Za-z][A-Za-z0-9_-]*/gi,
  },
  {
    id: "migration-product-policy-seed",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\bINSERT\s+INTO\s+(?:runtime_semantic_entries|workflow_runtime_contracts|workflow_capabilities|workflow_capability_artifacts|job_status_definitions|task_status_definitions|workflow_status_definitions|agency_workflow_run_status_definitions|research_job_status_definitions)\b/gi,
  },
  {
    id: "migration-semantic-row-seed",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\bINSERT\s+INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state|artifact_state|event_type|decision|mode|phase|outcome|action|action_key|validation_stage|scope_type|candidate_type|safety_class|portability_scope)\b[^)]*\)\s*VALUES\s*\(?[\s\S]{0,500}?["'][A-Za-z][A-Za-z0-9_.:-]*["']/gi,
  },
  {
    id: "runtime-status-name-branch",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:[A-Za-z][A-Za-z0-9_]*_(?:status|state)|status|state|lifecycleStatus|lifecycle_status|candidateState|candidate_state|promotionState|promotion_state|libraryState|library_state|safetyClass|safety_class|portabilityScope|portability_scope|mode|scope)\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-decision-name-branch",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:decision|phase|outcome|artifactState|artifact_state|validationStage|validation_stage|actionKey|action_key)\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-product-action-name-branch",
    scope: (path) => path.endsWith("/src/api/agency-routes.ts")
      || path.includes("/dashboard-src/src/pages/"),
    pattern: /\baction\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-product-action-packaged-value",
    scope: (path) => path.endsWith("/src/api/agency-routes.ts")
      || path.includes("/dashboard-src/src/"),
    pattern: /\baction\s*:\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "runtime-product-action-literal-union",
    scope: (path) => path.endsWith("/src/api/agency-routes.ts")
      || path.includes("/dashboard-src/src/"),
    pattern: /\b(?:[A-Za-z][A-Za-z0-9_]*Action|action)\??\s*:\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_.:-]*["'])+/g,
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
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /(?:\bstatus\s*:\s*["'][A-Za-z][A-Za-z0-9_-]*["']|put\(\s*["']status["']\s*,\s*["'][A-Za-z][A-Za-z0-9_-]*["']\s*\))/g,
  },
  {
    id: "runtime-lifecycle-key-literal",
    scope: (path) => !path.includes("/src/db/migrations/") && /\.(?:ts|tsx|kt)$/.test(path),
    pattern: /\b(?:lifecycleKey|lifecycle_key|actionKey|action_key)\s*[:=]\s*["'][A-Za-z][A-Za-z0-9_.:-]*["']/g,
  },
  {
    id: "android-status-name",
    scope: (path) => path.endsWith(".kt"),
    pattern: /\b(?:status|state|actionKey)\s*(?:==|!=)\s*"[A-Za-z][A-Za-z0-9_-]*"/g,
  },
];

function filesUnder(directory) {
  const output = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const normalized = path.replaceAll("\\", "/");
    if (ignored.some((pattern) => pattern.test(normalized))) continue;
    if (statSync(path).isDirectory()) output.push(...filesUnder(path));
    else if (extensions.has(extname(path))) output.push(path);
  }
  return output;
}

const violations = [];
for (const scanRoot of scanRoots) {
  const directory = join(root, scanRoot);
  for (const path of filesUnder(directory)) {
    const source = readFileSync(path, "utf8");
    const displayPath = relative(root, path).replaceAll("\\", "/");
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
