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
    pattern: /\bCHECK\s*\([^;]*(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state)\s+IN\s*\(/gi,
  },
  {
    id: "migration-semantic-lifecycle-seed",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\bINSERT\s+INTO\s+lifecycle_(?:state_definitions|transitions)\b/gi,
  },
  {
    id: "migration-semantic-state-default",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state)\b[^,;\n]*\bDEFAULT\s+["'][A-Za-z][A-Za-z0-9_-]*["']/gi,
  },
  {
    id: "migration-product-policy-seed",
    scope: (path) => path.includes("/src/db/migrations/"),
    pattern: /\bINSERT\s+INTO\s+(?:runtime_semantic_entries|workflow_capabilities|workflow_capability_artifacts|job_status_definitions|task_status_definitions|workflow_status_definitions|agency_workflow_run_status_definitions|research_job_status_definitions)\b/gi,
  },
  {
    id: "runtime-status-name-branch",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:status|state|lifecycleStatus|lifecycle_status|candidateState|candidate_state|promotionState|promotion_state|libraryState|library_state)\s*(?:===|!==|==|!=)\s*["'](?!(?:string|number|boolean|object|undefined|null)["'])[A-Za-z][A-Za-z0-9_-]*["']/g,
  },
  {
    id: "runtime-status-name-sql",
    scope: (path) => !path.includes("/src/db/migrations/"),
    pattern: /\b(?:status|state|lifecycle_status|candidate_state|promotion_state|library_state)\s*(?:=|IN\s*\()\s*["'(][A-Za-z][A-Za-z0-9_-]*/gi,
  },
  {
    id: "runtime-status-literal-union",
    scope: (path) => /\.(?:ts|tsx)$/.test(path),
    pattern: /\b(?:status|state|lifecycleStatus|candidateState|promotionState|libraryState)\??\s*:\s*["'][A-Za-z][A-Za-z0-9_-]*["'](?:\s*\|\s*["'][A-Za-z][A-Za-z0-9_-]*["'])+/g,
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
