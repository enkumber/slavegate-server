import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const serverRoot = path.resolve(__dirname, "..", "..");
const androidRoot = path.resolve(serverRoot, "..", "..", "android-agent", "app", "src", "main");

function sourceFiles(root: string, extensions: string[]): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (["db", "node_modules", "dist", "build"].includes(entry.name)) return [];
      return sourceFiles(absolute, extensions);
    }
    if (!extensions.some((extension) => entry.name.endsWith(extension))) return [];
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) return [];
    return [absolute];
  });
}

describe("DB-authoritative workflow semantics", () => {
  it("keeps application and workflow-domain vocabulary out of the AI workflow engine", () => {
    const source = [
      ...sourceFiles(serverRoot, [".ts"]),
      ...sourceFiles(androidRoot, [".kt", ".java"]),
    ]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n")
      .toLowerCase();

    for (const forbidden of [
      "reddit",
      "instagram",
      "tiktok",
      "twitter",
      "youtube",
      "rustdesk",
      "subreddit",
      "account_health_scan",
      "validateRedditAccountHealthIntent".toLowerCase(),
      "com.instagram.android",
      "com.reddit.frontpage",
      "com.zhiliaoapp.musically",
      "com.carriez.flutter_hbb",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("does not ship legacy semantic engines or filesystem workflow catalogs", () => {
    for (const retiredPath of [
      path.join(serverRoot, "modules", "agents"),
      path.join(serverRoot, "modules", "screen-detection"),
      path.join(serverRoot, "modules", "skills"),
      path.join(serverRoot, "modules", "skill-updater"),
      path.join(serverRoot, "modules", "data-pipeline", "parsers"),
      path.join(serverRoot, "api", "hydra-routes.ts"),
    ]) {
      expect(sourceFiles(retiredPath, [".ts", ".json", ".skill", ".md"]), retiredPath).toHaveLength(0);
    }
  });

  it("does not keep product catalogs or lexical intent policy in production code", () => {
    const source = sourceFiles(serverRoot, [".ts"])
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    for (const forbidden of [
      "COMPILER_KNOWLEDGE_BASE",
      "COMPILER_POLICY_GATES",
      "TOOL_CATALOG",
      "hasMutationTerms",
      "isOpenAppOnlyIntent",
      "INTRINSIC_ACTION_EFFECTS",
      "rankWorkflowCapabilities",
      "selectUnambiguousCapability",
      "compactHumanWorkflowAppMapHints",
      "ensureHumanWorkflowPreambleSteps",
      "normalizeHumanWorkflowTemplateCandidate",
      "derivePortableCapabilityKey",
      "resolvePortableCapabilityArtifact",
      "SAFE_PARAM_KEYS",
      "safetyRank",
      "inferPortableWorkflow",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("ships schema and generic lookup primitives without release-bound workflow semantics", () => {
    const semanticMigration = fs.readFileSync(
      path.join(__dirname, "..", "..", "db", "migrations", "099_db_authoritative_workflow_semantics.sql"),
      "utf8",
    );
    const controlPlaneMigration = fs.readFileSync(
      path.join(__dirname, "..", "..", "db", "migrations", "100_postgres_compiler_control_plane.sql"),
      "utf8",
    );

    expect(semanticMigration).toContain("runtime_semantic_entries");
    expect(semanticMigration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(semanticMigration).not.toMatch(/\bUPDATE\b/i);
    expect(controlPlaneMigration).toContain("resolve_human_workflow_platform");
    expect(controlPlaneMigration).toContain("resolve_workflow_capabilities");
    expect(controlPlaneMigration).toContain("compiler_tokens");
    expect(controlPlaneMigration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(controlPlaneMigration).not.toMatch(/\bUPDATE\b/i);

    const releaseMigrations = `${semanticMigration}\n${controlPlaneMigration}`.toLowerCase();
    for (const forbidden of [
      "com.android.chrome",
      "google.com",
      "reddit",
      "instagram",
      "human_workflow_compile_template",
      "human_workflow_repair_template",
      "compiler_control_plane",
    ]) {
      expect(releaseMigrations, forbidden).not.toContain(forbidden);
    }
  });

  it("retires the legacy prompt compiler instead of keeping a second semantic path", () => {
    for (const retiredFile of [
      "planner.ts",
      "prompt-builder.ts",
      "validator.ts",
      "model-routing.ts",
    ]) {
      expect(
        fs.existsSync(path.join(serverRoot, "modules", "workflow-compiler", retiredFile)),
        retiredFile,
      ).toBe(false);
    }
  });
});
